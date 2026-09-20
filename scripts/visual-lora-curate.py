#!/usr/bin/env python3
"""
audioMONASTRY · VISUAL-P1-007 – Schritt 2: Kuration der Trainingspaare
=====================================================================
Liest die Nutzer-Bewertungen des VisualMONK-Selbstlern-Loops und wählt daraus
die bestbewerteten **Prompt/Bild-Paare** für ein Stil-LoRA-Training aus.

Woher die Daten kommen (die Wahrheit im Repo)
---------------------------------------------
Bewertungen entstehen in der App über `POST /api/ai/vision/feedback`
(`server/routes/aiRoutes.ts`) und liegen in Supabase:

  * `public.visual_generations` – Prompt, Stil, Seed, Modell, R2-URL je Bild
    (Migration `database/ai_migration_008_visual.sql`)
  * `public.visual_feedback`    – Bewertung 1..5, `keep`, `tags`, `comment`

Beide Tabellen haben RLS ohne anon-Policy: lesbar nur mit dem Server-Schlüssel
(`service_role`). Es gibt **keinen** lokalen Spiegel dieser Bewertungen – ohne
Supabase (oder einen Export, s. u.) gibt es hier nichts zu kuratieren. Genau
deshalb endet ein Lauf ohne verwertbare Paare mit **Exit 3 und Begründung**
statt mit einem stillen Erfolg.

Datenquellen
------------
  * `--from-supabase` (Default, wenn SB_URL + Server-Schlüssel vorhanden sind)
    Liest beide Tabellen per PostgREST (nur GET, kein Schreibzugriff).
  * `--from-json DATEI`  Export-Datei. Zwei akzeptierte Formen:
      1. Rohform:  {"feedback": [ … ], "generations": [ … ]}
      2. Paarform: {"pairs": [ … ]}  (oder eine nackte Liste = `pairs`)

Aufruf
------
    python3 scripts/visual-lora-curate.py --from-json daten/visual-export.json
    python3 scripts/visual-lora-curate.py --min-rating 4 --keep-only --limit 120
    python3 scripts/visual-lora-curate.py --style cosmic --min-votes 2
    python3 scripts/visual-lora-curate.py --help

Ausgabe
-------
    logs/lora/<jahr-monat-tag>/curated-pairs.json     (Schema visual-lora-pairs/1)
Die Datei wird **immer** geschrieben – auch mit 0 Paaren, damit der Betreiber
belegen kann, dass der Lauf stattgefunden hat und warum nichts übrig blieb.

Exit-Codes
----------
  0 = Paare geschrieben (mindestens eines)
  2 = Aufruf-/Konfigurationsfehler (fehlende Datei, keine Datenquelle, kaputtes JSON)
  3 = ehrliche Leermenge: 0 verwertbare Paare (Grund auf stderr + im JSON)

Kein Netzwerk-Schreibzugriff, kein GPU-Aufruf, keine Kosten.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA = "visual-lora-pairs/1"
DEFAULT_ENV_FILE = ROOT / ".env"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_EMPTY = 3

#: Prioritätsordnung der Server-Schlüssel – Spiegel von
#: `SUPABASE_SERVER_KEY_ORDER` in src/config/supabaseKeys.ts. `SB_*` (neu) vor
#: `SUPABASE_*` (Legacy); der alte PAT steht bewusst zuletzt, damit ein
#: abgelaufener Legacy-Schlüssel keinen gültigen Service-Role-Key verdeckt.
SUPABASE_SERVER_KEY_ORDER = (
    "SB_SERVICE_ROLE",
    "SB_SECRET",
    "SB_PAT",
    "SUPABASE_SERVICE_ROLE",
    "SUPABASE_SERVICE_ROLE_JWT",
    "SUPABASE_SECRET",
    "SUPABASE_LEGACY_PAT",
)

#: Rohtabellen des Selbstlern-Loops (Migration 008).
TABLE_FEEDBACK = "visual_feedback"
TABLE_GENERATIONS = "visual_generations"


# ---------------------------------------------------------------------------
# Env-Auflösung: Prozess-Env gewinnt, `.env` füllt Lücken (wie dotenv es tut)
# ---------------------------------------------------------------------------
def read_env_file(path: pathlib.Path) -> Dict[str, str]:
    """Primitives .env-Lesen (KEY=VALUE, # Kommentar, Quotes werden entfernt).

    Bewusst ohne Zusatzabhängigkeit – dieselbe Bauart wie in
    `scripts/generate-mos-samples.py`.
    """
    out: Dict[str, str] = {}
    if not path or not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        out[name.strip()] = value.strip().strip('"').strip("'")
    return out


class EnvSource:
    """Prozess-Env vor `.env`-Datei (dotenv-Verhalten: Env gewinnt)."""

    def __init__(self, env_file: Optional[pathlib.Path]) -> None:
        self.file_env = read_env_file(env_file) if env_file else {}

    def get(self, name: str, default: str = "") -> str:
        value = os.environ.get(name)
        if value is None:
            value = self.file_env.get(name)
        return (value or "").strip() if value is not None else default

    def first(self, names: Sequence[str], default: str = "") -> Tuple[str, str]:
        """Erster gesetzter Name → (Wert, Name)."""
        for name in names:
            value = self.get(name)
            if value:
                return value, name
        return default, ""


# ---------------------------------------------------------------------------
# Reine Auswertung (kein Netz, testbar) – Spiegel von src/core/ai/vision/visualFeedback.ts
# ---------------------------------------------------------------------------
def normalize_rating(value: Any) -> Optional[int]:
    """Bewertung auf 1..5 (ganzzahlig) normalisieren; ungültig → None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):  # NaN/Inf
        return None
    rounded = int(round(number))
    if rounded < 1 or rounded > 5:
        return None
    return rounded


def normalize_tags(tags: Any) -> List[str]:
    """Tags bereinigen (trim, dedupe, max 8, je max 40 Zeichen)."""
    if isinstance(tags, str):
        tags = [tags]
    if not isinstance(tags, (list, tuple)):
        return []
    out: List[str] = []
    for raw in tags:
        value = str(raw or "").strip()[:40]
        if value and value not in out:
            out.append(value)
        if len(out) >= 8:
            break
    return out


def as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "t", "1", "yes", "ja", "on"):
        return True
    if text in ("false", "f", "0", "no", "nein", "off"):
        return False
    return default


def aggregate_feedback(rows: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Bewertungszeilen je Generierung bündeln.

    Nur gültige Bewertungen zählen (wie `aggregateFeedback` im TS-Kern).
    `keep` wird mehrheitlich entschieden (Gleichstand → behalten), `tags`
    werden über alle Bewertungen vereinigt.
    """
    aggregate: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        generation_id = str(row.get("generation_id") or row.get("generationId") or "").strip()
        rating = normalize_rating(row.get("rating"))
        if not generation_id or rating is None:
            continue
        entry = aggregate.setdefault(
            generation_id,
            {"votes": 0, "rating_sum": 0, "keep_true": 0, "keep_false": 0, "tags": [], "comments": []},
        )
        entry["votes"] += 1
        entry["rating_sum"] += rating
        if as_bool(row.get("keep"), default=True):
            entry["keep_true"] += 1
        else:
            entry["keep_false"] += 1
        for tag in normalize_tags(row.get("tags")):
            if tag not in entry["tags"] and len(entry["tags"]) < 8:
                entry["tags"].append(tag)
        comment = str(row.get("comment") or "").strip()[:200]
        if comment:
            entry["comments"].append(comment)
    return aggregate


def _generation_field(row: Dict[str, Any], *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def merge_pairs(
    feedback_rows: Iterable[Dict[str, Any]],
    generation_rows: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Bewertungen + Generierungen zu Kandidatenpaaren verbinden.

    Zeilen ohne `id`/`prompt` werden verworfen (nicht geraten) – ohne Prompt
    gibt es keine Caption und ohne ID keine Zuordnung zum Bild.
    """
    aggregate = aggregate_feedback(feedback_rows)
    pairs: List[Dict[str, Any]] = []
    for row in generation_rows:
        if not isinstance(row, dict):
            continue
        generation_id = _generation_field(row, "id", "generation_id", "generationId")
        prompt = _generation_field(row, "prompt")
        if not generation_id or not prompt:
            continue
        stats = aggregate.get(generation_id)
        votes = int(stats["votes"]) if stats else 0
        rating = round(stats["rating_sum"] / votes, 2) if stats and votes else 0.0
        keep = True
        if stats:
            # Mehrheitsentscheidung über alle Bewertungen eines Bildes
            # (Gleichstand → behalten, siehe `aggregateFeedback` im TS-Kern).
            keep = stats["keep_true"] >= stats["keep_false"]
        pairs.append(
            {
                "generation_id": generation_id,
                "prompt": prompt,
                "style": _generation_field(row, "style") or None,
                "seed": row.get("seed"),
                "model": _generation_field(row, "model") or None,
                "rating": rating,
                "votes": votes,
                "keep": keep,
                "tags": list(stats["tags"]) if stats else [],
                "comments": list(stats["comments"]) if stats else [],
                "image_url": _generation_field(row, "r2_url", "r2Url", "image_url") or None,
                "image_key": _generation_field(row, "r2_key", "r2Key") or None,
                "created_at": _generation_field(row, "created_at", "createdAt") or None,
            }
        )
    return pairs


def curate(
    pairs: Iterable[Dict[str, Any]],
    *,
    min_rating: float,
    min_votes: int,
    keep_only: bool,
    styles: Sequence[str],
    limit: int,
    require_image: bool,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], str]:
    """Kandidaten filtern, sortieren, begrenzen.

    Rückgabe: (ausgewählte Paare, Verwurfsgründe, Ablehnungsgrund oder '').
    Sortierung: Bewertung ↓, Stimmen ↓, Zeit ↓ – deterministisch.
    """
    wanted_styles = {s.strip().lower() for s in styles if s.strip()}
    dropped = {"ohne_bewertung": 0, "rating": 0, "stimmen": 0, "keep": 0, "stil": 0, "ohne_bild": 0}
    kept: List[Dict[str, Any]] = []
    for pair in pairs:
        if not pair.get("votes"):
            dropped["ohne_bewertung"] += 1
            continue
        if float(pair.get("rating") or 0) < min_rating:
            dropped["rating"] += 1
            continue
        if int(pair.get("votes") or 0) < min_votes:
            dropped["stimmen"] += 1
            continue
        if keep_only and not pair.get("keep", True):
            dropped["keep"] += 1
            continue
        style = str(pair.get("style") or "").strip()
        if wanted_styles and style.lower() not in wanted_styles:
            dropped["stil"] += 1
            continue
        if require_image and not (pair.get("image_url") or pair.get("image_key")):
            dropped["ohne_bild"] += 1
            continue
        kept.append(pair)

    # Sortierung: Bewertung ↓, Stimmen ↓, Zeit ↓ – deterministisch und stabil
    # (erst nach Zeit sortieren, dann stabil nach Bewertung/Stimmen darüber).
    kept.sort(key=lambda p: str(p.get("created_at") or ""), reverse=True)
    kept.sort(key=lambda p: (float(p.get("rating") or 0), int(p.get("votes") or 0)), reverse=True)
    kept = kept[: max(1, limit)]

    reason = ""
    if not kept:
        cause = max(dropped, key=lambda key: dropped[key]) if any(dropped.values()) else ""
        mapping = {
            "ohne_bewertung": "keine der Generierungen hat eine gültige Bewertung (1..5)",
            "rating": f"keine Bewertung erreicht Ø {min_rating}",
            "stimmen": f"keine Bewertung erreicht {min_votes} Stimme(n)",
            "keep": "alle ausreichend bewerteten Bilder sind als 'nicht behalten' markiert",
            "stil": "kein Treffer für den Stilfilter " + ", ".join(sorted(wanted_styles)),
            "ohne_bild": "die passenden Bilder haben keine Bild-Referenz (r2_url/r2_key) – ohne Bild kein Training",
        }
        reason = mapping.get(cause, "die Kandidatenmenge ist leer")
    return kept, dropped, reason


# ---------------------------------------------------------------------------
# Supabase (nur lesend)
# ---------------------------------------------------------------------------
def supabase_get(url: str, key: str, table: str, params: Dict[str, str], timeout: int = 60) -> List[Dict[str, Any]]:
    """PostgREST-GET. Nur Lesen – diese Funktion sendet ausschließlich GET."""
    query = urllib.parse.urlencode(params, safe=",().*")
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}?{query}"
    request = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "audiomonastry-visual-lora-curate",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8") or "[]")
    if isinstance(payload, dict):
        return [payload]
    if not isinstance(payload, list):
        return []
    return [row for row in payload if isinstance(row, dict)]


def load_from_supabase(env: EnvSource, min_rating: float) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Beide Tabellen lesen; Rückgabe (feedback, generations, quelle)."""
    url, url_name = env.first(("SB_URL", "SUPABASE_URL"))
    key, key_name = env.first(SUPABASE_SERVER_KEY_ORDER)
    if not url or not key:
        missing = [n for n, v in (("SB_URL", url), (key_name or "SB_SERVICE_ROLE", key)) if not v]
        raise RuntimeError(
            "Supabase ist nicht konfiguriert (fehlt: " + ", ".join(missing) + ") – "
            "entweder SB_URL/SB_SERVICE_ROLE in .env setzen oder --from-json nutzen"
        )
    # Server-seitig filtern: nur Bewertungen, die überhaupt in Frage kommen.
    feedback = supabase_get(
        url,
        key,
        TABLE_FEEDBACK,
        {
            "select": "generation_id,rating,keep,tags,comment,user_id,created_at",
            "rating": f"gte.{int(min_rating) if float(min_rating).is_integer() else min_rating}",
        },
    )
    generation_ids = sorted({str(row.get("generation_id") or "").strip() for row in feedback if row.get("generation_id")})
    if not generation_ids:
        return feedback, [], f"supabase ({url_name}, {key_name})"

    # PostgREST-`in.(...)` in Blöcken, damit die URL nicht ins Unendliche wächst.
    generations: List[Dict[str, Any]] = []
    fields = "id,created_at,prompt,style,seed,r2_key,r2_url,model,session_id,user_id"
    for start in range(0, len(generation_ids), 100):
        block = generation_ids[start : start + 100]
        generations.extend(
            supabase_get(url, key, TABLE_GENERATIONS, {"select": fields, "id": f"in.({','.join(block)})"})
        )
    return feedback, generations, f"supabase ({url_name}, {key_name})"


def load_from_json(path: pathlib.Path) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Export laden (Rohform `feedback`/`generations` oder Paarform `pairs`)."""
    if not path.exists():
        raise FileNotFoundError(f"Export-Datei fehlt: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return [], [row for row in payload if isinstance(row, dict)], f"export {path}"
    if isinstance(payload, dict):
        if "generations" in payload or "feedback" in payload:
            feedback = [row for row in (payload.get("feedback") or []) if isinstance(row, dict)]
            generations = [row for row in (payload.get("generations") or []) if isinstance(row, dict)]
            return feedback, generations, f"export {path}"
        if "pairs" in payload:
            pairs = [row for row in (payload.get("pairs") or []) if isinstance(row, dict)]
            # Paarform: als „bereits zusammengeführt“ markieren (votes/rating stehen drin).
            return [], pairs, f"export {path}"
    raise ValueError(
        f"{path}: unbekannte Form – erwartet wird {{'feedback':[],'generations':[]}} "
        "oder {'pairs':[]} oder eine Liste von Paaren"
    )


def pairs_from_export_rows(generations: List[Dict[str, Any]], feedback: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rohform → Paare. Enthält die Zeile schon `rating`/`votes`, gilt sie als Paar."""
    if feedback:
        return merge_pairs(feedback, generations)
    pairs = []
    for row in generations:
        pairs.append(
            {
                "generation_id": _generation_field(row, "generation_id", "generationId", "id"),
                "prompt": _generation_field(row, "prompt"),
                "style": _generation_field(row, "style") or None,
                "seed": row.get("seed"),
                "model": _generation_field(row, "model") or None,
                "rating": float(row.get("rating") or 0),
                "votes": int(row.get("votes") or 0),
                "keep": as_bool(row.get("keep"), default=True),
                "tags": normalize_tags(row.get("tags")),
                "comments": [str(row.get("comment") or "").strip()][:1] if row.get("comment") else [],
                "image_url": _generation_field(row, "r2_url", "r2Url", "image_url") or None,
                "image_key": _generation_field(row, "r2_key", "r2Key") or None,
                "created_at": _generation_field(row, "created_at", "createdAt") or None,
            }
        )
    return [p for p in pairs if p["generation_id"] and p["prompt"]]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def supabase_count(url: str, key: str, table: str, timeout: int = 60) -> Optional[int]:
    """Zeilenzahl einer Tabelle lesen (PostgREST `Prefer: count=exact`, nur HEAD/GET)."""
    params = {"select": "id"}
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Prefer": "count=exact",
            "Range-Unit": "items",
            "Range": "0-0",
            "User-Agent": "audiomonastry-visual-lora-curate",
        },
        method="HEAD",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_range = response.headers.get("Content-Range", "")
    if "/" not in content_range:
        return None
    try:
        return int(content_range.rsplit("/", 1)[1])
    except ValueError:
        return None


def diagnose(env: EnvSource, from_json: Optional[pathlib.Path], min_rating: float) -> int:
    """Wo der Datenpfad heute steht – read-only, ohne Filter, ohne Bewertung.

    Beantwortet genau die Betreiber-Frage „gibt es überhaupt Bild-Bewertungen?“:
    wie viele Zeilen in `visual_feedback` / `visual_generations` liegen und wie
    die Bewertungen verteilt sind. Fehlende Tabellen werden als solche gemeldet
    (Migration 008 nicht eingespielt) statt als leere Datenmenge.
    """
    report: Dict[str, Any] = {"schema": "visual-lora-diagnose/1", "created_at": datetime.now(timezone.utc).isoformat()}

    if from_json:
        try:
            feedback, generations, source_desc = load_from_json(from_json)
        except (ValueError, json.JSONDecodeError, FileNotFoundError) as exc:
            print(f"FEHLER: Export nicht lesbar: {exc}", file=sys.stderr)
            return EXIT_USAGE
        report["source"] = {"kind": "export", "detail": source_desc}
        report["feedback_rows"] = len(feedback)
        report["generation_rows"] = len(generations)
        report["rating_distribution"] = {
            str(value): sum(1 for row in feedback if normalize_rating(row.get("rating")) == value)
            for value in range(1, 6)
        }
        with_image = sum(1 for row in generations if row.get("r2_url") or row.get("r2Url") or row.get("r2_key") or row.get("r2Key"))
        report["generations_with_image"] = with_image
    else:
        url, url_name = env.first(("SB_URL", "SUPABASE_URL"))
        key, key_name = env.first(SUPABASE_SERVER_KEY_ORDER)
        if not url or not key:
            print(
                "FEHLER: Supabase ist nicht konfiguriert (SB_URL + SB_SERVICE_ROLE fehlen) – "
                "Diagnose nicht möglich.",
                file=sys.stderr,
            )
            return EXIT_USAGE
        report["source"] = {"kind": "supabase", "detail": f"{url_name}, {key_name}"}
        for table, field in ((TABLE_FEEDBACK, "feedback_rows"), (TABLE_GENERATIONS, "generation_rows")):
            try:
                report[field] = supabase_count(url, key, table)
            except urllib.error.HTTPError as exc:
                report[field] = None
                report.setdefault("errors", {})[table] = f"HTTP {exc.code} ({exc.reason})"
            except (urllib.error.URLError, OSError) as exc:
                report[field] = None
                report.setdefault("errors", {})[table] = f"{type(exc).__name__}: {exc}"
        try:
            ratings = supabase_get(url, key, TABLE_FEEDBACK, {"select": "rating", "limit": "1000"})
            report["rating_distribution"] = {
                str(value): sum(1 for row in ratings if normalize_rating(row.get("rating")) == value)
                for value in range(1, 6)
            }
            report["ratings_sampled"] = len(ratings)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            report["rating_distribution"] = None
            report.setdefault("errors", {})["ratings"] = f"{type(exc).__name__}: {exc}"

    total_feedback = report.get("feedback_rows")
    verdict = "keine Datenquelle lesbar"
    if isinstance(total_feedback, int):
        if total_feedback == 0:
            verdict = "visual_feedback ist LEER – es gibt heute keine Bild-Bewertungen"
        else:
            good = sum(
                count for rating, count in (report.get("rating_distribution") or {}).items()
                if int(rating) >= int(min_rating)
            )
            verdict = (
                f"{total_feedback} Bewertungszeilen, davon {good} mit Rating >= {min_rating:g} "
                f"(Kandidaten für ein Training)"
            )
    report["verdict"] = verdict
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[diagnose] {verdict}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visual-lora-curate.py",
        description="Kuratiert die bestbewerteten Prompt/Bild-Paare für das Stil-LoRA (VISUAL-P1-007).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Exit-Codes: 0 = Paare geschrieben, 2 = Aufruf-/Konfigfehler, 3 = 0 verwertbare Paare.\n"
            "Ausgabe: logs/lora/<datum>/curated-pairs.json (Schema visual-lora-pairs/1)"
        ),
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--from-json", metavar="DATEI", help="Export-Datei statt Supabase lesen.")
    source.add_argument(
        "--from-supabase",
        action="store_true",
        help="Supabase explizit als Quelle erzwingen (Default, wenn SB_URL + Server-Schlüssel gesetzt sind).",
    )
    parser.add_argument("--min-rating", type=float, default=4.0, help="Mindest-Durchschnittsbewertung (Default 4).")
    parser.add_argument("--min-votes", type=int, default=1, help="Mindestzahl gültiger Bewertungen je Bild (Default 1).")
    parser.add_argument("--keep-only", dest="keep_only", action="store_true", default=True,
                        help="Nur Bilder, die die Nutzer behalten wollen (Default an).")
    parser.add_argument("--include-unkept", dest="keep_only", action="store_false",
                        help="Auch Bilder mit 'nicht behalten' zulassen.")
    parser.add_argument("--style", action="append", default=[], metavar="NAME",
                        help="Nur diesen Stil (mehrfach angebbar oder komma-getrennt).")
    parser.add_argument("--limit", type=int, default=200, help="Höchstzahl der Paare (Default 200).")
    parser.add_argument("--allow-missing-image", dest="require_image", action="store_false", default=True,
                        help="Paare ohne Bild-Referenz zulassen (für ein LoRA unbrauchbar – nur zur Diagnose).")
    parser.add_argument("--out", metavar="DATEI", help="Zielpfad (Default logs/lora/<datum>/curated-pairs.json).")
    parser.add_argument("--diagnose", action="store_true",
                        help="Nur den Datenpfad prüfen (read-only): Zeilen in visual_feedback/visual_generations.")
    parser.add_argument("--env-file", metavar="DATEI", default=str(DEFAULT_ENV_FILE),
                        help="Env-Datei für Supabase-Zugang (Default .env; 'none' = nur Prozess-Env).")
    parser.add_argument("--quiet", action="store_true", help="Nur die JSON-Zusammenfassung ausgeben.")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    styles: List[str] = []
    for entry in args.style:
        styles.extend(part.strip() for part in str(entry).split(",") if part.strip())

    env_file = None if str(args.env_file).strip().lower() in ("none", "-", "") else pathlib.Path(args.env_file)
    env = EnvSource(env_file)

    if args.diagnose:
        return diagnose(env, pathlib.Path(args.from_json) if args.from_json else None, float(args.min_rating))

    # --- Quelle bestimmen ----------------------------------------------------
    try:
        if args.from_json:
            feedback, generations, source_desc = load_from_json(pathlib.Path(args.from_json))
            pairs = pairs_from_export_rows(generations, feedback)
            raw_feedback = len(feedback)
            raw_generations = len(generations)
        else:
            feedback, generations, source_desc = load_from_supabase(env, args.min_rating)
            pairs = merge_pairs(feedback, generations)
            raw_feedback = len(feedback)
            raw_generations = len(generations)
    except FileNotFoundError as exc:
        print(f"FEHLER: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"FEHLER: Export nicht lesbar: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except RuntimeError as exc:
        print(f"FEHLER: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        print(f"FEHLER: Supabase nicht erreichbar: {exc}", file=sys.stderr)
        print("        Ohne Bewertungen aus der DB gibt es nichts zu kuratieren – "
              "kein stiller Erfolg, kein Ersatz durch Zufallsdaten.", file=sys.stderr)
        return EXIT_USAGE

    # --- Kuration ------------------------------------------------------------
    kept, dropped, reason = curate(
        pairs,
        min_rating=args.min_rating,
        min_votes=args.min_votes,
        keep_only=bool(args.keep_only),
        styles=styles,
        limit=int(args.limit),
        require_image=bool(args.require_image),
    )

    out_path = pathlib.Path(args.out) if args.out else (
        ROOT / "logs" / "lora" / datetime.now(timezone.utc).strftime("%Y-%m-%d") / "curated-pairs.json"
    )
    payload = {
        "schema": SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "ticket": "VISUAL-P1-007",
        "source": {"kind": "supabase" if not args.from_json else "export", "detail": source_desc},
        "filter": {
            "min_rating": args.min_rating,
            "min_votes": args.min_votes,
            "keep_only": bool(args.keep_only),
            "styles": styles,
            "limit": int(args.limit),
            "require_image": bool(args.require_image),
        },
        "stats": {
            "feedback_rows": raw_feedback,
            "generation_rows": raw_generations,
            "candidates": len(pairs),
            "kept": len(kept),
            "dropped": dropped,
        },
        "reason": reason or None,
        "pairs": kept,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    summary = {
        "source": source_desc,
        "candidates": len(pairs),
        "kept": len(kept),
        "out": str(out_path.relative_to(ROOT)) if out_path.is_relative_to(ROOT) else str(out_path),
        "dropped": {k: v for k, v in dropped.items() if v},
    }
    print(json.dumps(summary, ensure_ascii=False))

    if not kept:
        print(
            "FEHLER: 0 verwertbare Prompt/Bild-Paare – " + (reason or "Kandidatenmenge leer") + ".",
            file=sys.stderr,
        )
        print(
            "        Betreiber-Schritt: erst Bewertungen erzeugen (Session-Ende-Umfrage in der App, "
            "POST /api/ai/vision/feedback) bzw. pruefen, ob visual_feedback/visual_generations "
            "gefuellt sind. Details: docs/VISUAL_LORA_TRAINING.md",
            file=sys.stderr,
        )
        return EXIT_EMPTY
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
