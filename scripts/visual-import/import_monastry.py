#!/usr/bin/env python3
"""Importiert die 20 Themen-Ordner von MONASTRY/Visuals in die VisualMONK-Clip-Bank.

Quelle : /mnt/wd-elements/Projekte/MONASTRY/Visuals/<Kategorie>/{Bilder,Videos}
Ziel   : R2-Bucket ``audiomonastrysamples`` unter ``visuals/bank/mNNx*.mp4``
         + generierte ``src/visuals/importedBank.generated.ts``

Drei getrennte Stufen (jede wiederholbar, Zustand liegt in ``.visual-import/``):

    python3 scripts/visual-import/import_monastry.py scan     # Auswahl + plan.json
    python3 scripts/visual-import/import_monastry.py render   # ffmpeg (Basis + Varianten)
    python3 scripts/visual-import/import_monastry.py upload   # R2 + Indizes + TS
    python3 scripts/visual-import/import_monastry.py all

Regeln:
* Pro Kategorie 2 Videos (kurze, bewegte Clips bevorzugt) + 3 Bilder (Ken-Burns).
* Jeder Clip wird 6 s lang, 1280x720, 30 fps, yuv420p -> einheitliche Bank.
* Varianten wie im Bestand: loop (ping-pong), quadrat, wide, slow, fast, mirror,
  hue15, grau. Jede Variante ist eine eigene R2-Datei und damit ein eigener
  Pool-Eintrag.
* Lizenz + Attribution aus der ``.meta.json`` wandern in den Index; ohne
  verwertbare Lizenz wird der Clip nicht importiert.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
SOURCE = "/mnt/wd-elements/Projekte/MONASTRY/Visuals"
WORK = os.path.join(REPO, ".visual-import")
OUT = os.path.join(WORK, "out")
PLAN = os.path.join(WORK, "plan.json")
STATE = os.path.join(WORK, "state.json")
GENERATED = os.path.join(REPO, "src", "visuals", "importedBank.generated.ts")

CLIP_SECONDS = 6.0
FPS = 30
W, H = 1280, 720

#: Kategorie -> (Stimmung, Energie, Kurz-Tag, Kurzname)
CATEGORY_STYLE: Dict[str, tuple] = {
    "01_Zombie-Apokalypse-Horror-Pandemie": ("duester", "hart", "zombie", "Zombie"),
    "02_Kriegsdystopie-1-und-2-Weltkrieg": ("duester", "hart", "krieg", "Krieg"),
    "03_Surreal-Abstrakt-Fraktale-Designs": ("cool", "mittel", "fraktal", "Fraktal"),
    "04_Macro-Naturmakro-Miniatur-Nahaufnahmen": ("neutral", "ruhig", "macro", "Makro"),
    "05_Weltall-Galaxie-Sterne-Planeten-Milchstrasse-Universum": ("cool", "ruhig", "weltall", "Weltall"),
    "06_Sexy-Frauen-Akt-Dessous-Romantik": ("neutral", "ruhig", "romantik", "Romantik"),
    "07_Fantasy-Tolkien-Drachen-Dinos-Hexen-Hochkulturen": ("duester", "mittel", "fantasy", "Fantasy"),
    "08_Industrial-Beton-Urban-LostPlaces": ("duester", "hart", "industrial", "Industrial"),
    "09_Natur-Tiere-Landschaft-HDR-Landschaft": ("neutral", "ruhig", "natur", "Natur"),
    "10_Motivation-Sprueche-Zitate-Inspiration": ("neutral", "mittel", "motivation", "Motivation"),
    "11_Techno-Rave-Klub-Laser-Neon": ("cool", "hart", "techno", "Techno"),
    "12_Synthwave-Neon-Retro-Futurismus": ("cool", "mittel", "synthwave", "Synthwave"),
    "13_Synthesizer-Analog-Audio-Gear": ("cool", "mittel", "synth", "Synthesizer"),
    "14_8bit-Retro-Games-Arcade": ("lustig", "hart", "8bit", "8bit"),
    "15_Tattoo-Piercing-Bodymod": ("cool", "mittel", "tattoo", "Tattoo"),
    "16_Comic-Manga-Illustration": ("lustig", "mittel", "comic", "Comic"),
    "17_Maler-Groesste-Meister": ("neutral", "ruhig", "maler", "Maler"),
    "18_Teufel-Geister-Daemonen-Inferno": ("duester", "mittel", "daemon", "Daemon"),
    "19_Moenche-Kloster-Orden": ("duester", "ruhig", "kloster", "Kloster"),
    "20_Streetart-Graffiti-Urban-Art": ("cool", "mittel", "streetart", "Streetart"),
}

#: Varianten: Name -> ffmpeg-Filterkette (Eingang ist der Basis-Clip).
VARIANTS: Dict[str, str] = {
    "loop": "split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]",  # ping-pong, nahtlos
    "quadrat": "crop=720:720:(iw-720)/2:(ih-720)/2",
    "wide": "scale=1920:1080",
    "slow": "setpts=1.3333*PTS",
    "fast": "setpts=0.6667*PTS",
    "mirror": "hflip",
    "hue15": "hue=h=15",
    "grau": "hue=s=0",
}

ALLOWED_LICENSE_HINTS = (
    "cc0", "public domain", "publicdomain", "pd", "pdm", "no restrictions",
    "by-2.0", "by-4.0", "by 2.0", "by 4.0", "by-sa", "cc by", "cc-by",
    "unsplash license", "eigenmaterial", "coverr license", "mixkit free license",
    "creativecommons.org/licenses/by", "creativecommons.org/publicdomain",
)


@dataclass
class Item:
    cid: str
    cat: str
    kind: str                 # 'video' | 'image'
    path: str
    label: str
    tags: List[str] = field(default_factory=list)
    license: str = ""
    attribution: str = ""
    source_url: str = ""
    source: str = ""
    title: str = ""
    mood: str = "neutral"
    energy: str = "mittel"
    seconds: float = 0.0
    width: int = 0
    height: int = 0
    start: float = 0.0        # Segment-Start im Video
    rendered: Dict[str, str] = field(default_factory=dict)
    uploaded: Dict[str, str] = field(default_factory=dict)


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: List[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ffprobe(path: str) -> Dict[str, float]:
    r = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration", "-of", "json", path,
    ], timeout=60)
    try:
        j = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return {}
    st = (j.get("streams") or [{}])[0]
    return {
        "w": int(st.get("width") or 0),
        "h": int(st.get("height") or 0),
        "dur": float((j.get("format") or {}).get("duration") or 0),
    }


def read_meta(path: str) -> Dict:
    mp = path + ".meta.json"
    if not os.path.exists(mp):
        return {}
    try:
        with open(mp, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def license_ok(lic: str) -> bool:
    low = (lic or "").lower()
    if not low:
        return False
    return any(h in low for h in ALLOWED_LICENSE_HINTS)


def load_keywords() -> Dict[str, Dict[str, set]]:
    """Suchbegriffe je Kategorie aus dem MONASTRY-Kategorienkatalog (Single Source)."""
    src = os.path.join(SOURCE, "tools", "categories.py")
    if not os.path.exists(src):
        return {}
    import importlib.util
    spec = importlib.util.spec_from_file_location("monastry_categories", src)
    if spec is None or spec.loader is None:
        return {}
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    def words_of(terms) -> set:
        out = set()
        for term in terms or []:
            for w in str(term).lower().replace("-", " ").replace("/", " ").replace("_", " ").split():
                if len(w) > 2:
                    out.add(w)
        return out

    out: Dict[str, Dict[str, set]] = {}
    for c in getattr(mod, "CATEGORIES", []):
        folder = c.get("folder", "")
        folder_words = words_of(folder.split("_", 1)[-1].split("-"))
        kw = words_of((c.get("kw_de") or []) + (c.get("kw_en") or []))
        terms = words_of((c.get("image_terms") or []) + (c.get("video_terms") or []))
        out[folder] = {"folder": folder_words, "kw": kw, "terms": terms}
    return out


STOCK_SOURCES = {"coverr", "mixkit", "pixabay", "pexels", "unsplash", "videvo"}

#: Motive, die in einer Musik-Visualbank nichts verlieren (auch rechtlich: §86a StGB).
BANNED = (
    "judenboykott", "anti-semit", "antisemit", "nazi", "hitler", "holocaust",
    "swastika", "hakenkreuz", "boykott", "ss-division", "wehrmacht",
    "porno", "porn", "hardcore", "nacktbild",
)
#: Dateinamen/Titel ohne Aussage (Rohaufnahmen, Handy-Dumps, Fehlgriffe).
JUNK = (
    "temp ", "home movie", "home-movie", "vlog", "synchow", "test", "dsc ",
    "img_", "mvi_", "mvimg", "whatsapp", "snapshot", "unbenannt",
)


_RE_CACHE: Dict[frozenset, "re.Pattern[str]"] = {}


def _pattern(words: set):
    key = frozenset(w for w in words if w)
    pat = _RE_CACHE.get(key)
    if pat is None:
        alt = "|".join(re.escape(w) for w in sorted(key, key=len, reverse=True))
        pat = re.compile(rf"\b(?:{alt})\b") if alt else re.compile(r"$.^")
        _RE_CACHE[key] = pat
    return pat


def relevance(haystack: str, words: set) -> int:
    """Anzahl *verschiedener* Suchwörter, die als ganzes Wort vorkommen."""
    if not words:
        return 0
    low = haystack.lower()
    return len({m.group(0) for m in _pattern(words).finditer(low)})


def is_banned(haystack: str) -> bool:
    low = haystack.lower()
    return any(b in low for b in BANNED)


def is_junk(haystack: str) -> bool:
    low = haystack.lower()
    return any(j in low for j in JUNK)


def tags_from_meta(meta: Dict) -> List[str]:
    raw = meta.get("tags") or []
    out = []
    for t in raw:
        name = t.get("name") if isinstance(t, dict) else t
        if isinstance(name, str) and name.strip():
            out.append(name.strip().lower())
    return out[:8]


def scan() -> List[Item]:
    items: List[Item] = []
    if not os.path.isdir(SOURCE):
        sys.exit(f"Quelle fehlt: {SOURCE}")
    keywords = load_keywords()
    seen: set = set()
    cats = sorted(d for d in os.listdir(SOURCE) if os.path.isdir(os.path.join(SOURCE, d)))
    for cat in cats:
        style = CATEGORY_STYLE.get(cat)
        if not style:
            log(f"  übersprungen (kein Stil-Mapping): {cat}")
            continue
        mood, energy, short, nice = style
        kw = keywords.get(cat, {"folder": set(), "kw": set(), "terms": set()})
        prefix = "m" + cat.split("_")[0]
        idx = 0

        def haystack(meta: Dict, path: str) -> str:
            return " ".join([
                str(meta.get("title") or ""), os.path.basename(path),
                " ".join(tags_from_meta(meta)), str(meta.get("query") or ""),
            ])

        def rel_score(text: str) -> int:
            return (relevance(text, kw["folder"]) * 4
                    + relevance(text, kw["kw"]) * 2
                    + relevance(text, kw["terms"]))

        def score_of(text: str, src: str, kurz_bonus: int) -> int:
            """Relevanz zählt, Quelle/Länge sind nur Tiebreak-Boni."""
            return rel_score(text) * 3 + (2 if src in STOCK_SOURCES else (1 if src == "netzwerk" else 0)) * 2 + kurz_bonus

        # --- Videos: Relevanz + kurze Stock-Loops zuerst -------------------
        vids = []
        vdir = os.path.join(SOURCE, cat, "Videos")
        if os.path.isdir(vdir):
            for f in sorted(os.listdir(vdir)):
                if f.endswith(".meta.json") or not f.lower().endswith((".mp4", ".ogv", ".avi", ".webm", ".mov")):
                    continue
                p = os.path.join(vdir, f)
                if os.path.basename(p) in seen:
                    continue
                meta = read_meta(p)
                if meta and not license_ok(str(meta.get("license") or "")):
                    continue
                text = haystack(meta, p)
                if is_banned(text) or is_junk(text):
                    continue
                info = ffprobe(p)
                if info.get("dur", 0) < 2 or info.get("w", 0) < 480:
                    continue
                src = str(meta.get("source") or "")
                # Videos: nur Titel + Dateiname werten — die Tags der Stock-Anbieter
                # sind zu breit (ein Sonnenuntergang trägt dort „rave").
                vtext = " ".join([str(meta.get("title") or ""), os.path.basename(p)])
                if rel_score(vtext) < 4:
                    continue  # ohne Themenbezug kein Clip — lieber Ken-Burns als falsches Motiv
                kurz = 2 if info["dur"] <= 60 else (1 if info["dur"] <= 300 else 0)
                vids.append((score_of(text, src, kurz), info["dur"], p, meta, info))
        vids.sort(key=lambda t: (-t[0], t[1]))
        for score, dur, p, meta, info in vids[:2]:
            idx += 1
            seen.add(os.path.basename(p))
            seg = min(CLIP_SECONDS, max(2.0, dur))
            start = 0.0 if dur <= CLIP_SECONDS * 2 else round(dur * 0.15, 2)
            items.append(Item(
                cid=f"{prefix}{chr(96 + idx)}", cat=cat, kind="video", path=p,
                label=f"{nice} {idx}", mood=mood, energy=energy,
                tags=[short] + tags_from_meta(meta),
                license=str(meta.get("license") or "unbekannt"),
                attribution=str(meta.get("attribution") or meta.get("author") or ""),
                source_url=str(meta.get("source_url") or meta.get("url") or ""),
                source=str(meta.get("source") or ""),
                title=str(meta.get("title") or os.path.basename(p))[:90],
                seconds=seg, width=info["w"], height=info["h"], start=start,
            ))

        # --- Bilder: Ken-Burns-Clips, Relevanz vor Auflösung ---------------
        imgs = []
        idir = os.path.join(SOURCE, cat, "Bilder")
        if os.path.isdir(idir):
            for f in sorted(os.listdir(idir)):
                if f.endswith(".meta.json") or not f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    continue
                p = os.path.join(idir, f)
                if os.path.basename(p) in seen:
                    continue
                meta = read_meta(p)
                if meta and not license_ok(str(meta.get("license") or "")):
                    continue
                text = haystack(meta, p)
                if is_banned(text) or is_junk(text):
                    continue
                size = os.path.getsize(p)
                if size < 40_000 or size > 12_000_000:
                    continue
                px = int(meta.get("width") or 0) * int(meta.get("height") or 0)
                src = str(meta.get("source") or "")
                res = 2 if px >= 1_500_000 else (1 if px >= 600_000 else 0)
                imgs.append((score_of(text, src, res), px, size, p, meta))
        imgs.sort(key=lambda t: (-t[0], -t[1], -t[2]))
        for _score, _px, _size, p, meta in imgs[:5]:
            idx += 1
            seen.add(os.path.basename(p))
            items.append(Item(
                cid=f"{prefix}{chr(96 + idx)}", cat=cat, kind="image", path=p,
                label=f"{nice} {idx}", mood=mood, energy=energy,
                tags=[short, "ken-burns"] + tags_from_meta(meta),
                license=str(meta.get("license") or "unbekannt"),
                attribution=str(meta.get("attribution") or meta.get("author") or ""),
                source_url=str(meta.get("source_url") or meta.get("url") or ""),
                source=str(meta.get("source") or ""),
                title=str(meta.get("title") or os.path.basename(p))[:90],
                seconds=CLIP_SECONDS,
                width=int(meta.get("width") or 0), height=int(meta.get("height") or 0),
            ))

    os.makedirs(WORK, exist_ok=True)
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump([i.__dict__ for i in items], fh, ensure_ascii=False, indent=1)
    log(f"scan: {len(items)} Clips in {len({i.cat for i in items})} Kategorien -> {PLAN}")
    return items


def load_plan() -> List[Item]:
    if not os.path.exists(PLAN):
        sys.exit("plan.json fehlt — erst `scan` laufen lassen")
    with open(PLAN, "r", encoding="utf-8") as fh:
        return [Item(**d) for d in json.load(fh)]


def base_encode(it: Item) -> str:
    """Basis-Clip 1280x720 rendern und Pfad zurückgeben."""
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, f"{it.cid}.mp4")
    if os.path.exists(dst) and os.path.getsize(dst) > 10_000:
        return dst

    if it.kind == "video":
        pre = []
        if it.seconds and it.seconds >= (it.seconds - 0.01):
            pass
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if it.seconds >= 5.5:
            cmd += ["-ss", str(it.start), "-t", f"{it.seconds:.2f}"]
        else:
            # zu kurzer Quellclip: in Schleife auf Ziellänge bringen
            cmd += ["-stream_loop", "-1", "-t", f"{CLIP_SECONDS:.2f}"]
        cmd += ["-i", it.path,
                "-vf", (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
                        f"crop={W}:{H},fps={FPS},setsar=1"),
                "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst]
    else:
        frames = int(CLIP_SECONDS * FPS)
        vf = (f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,"
              f"crop={W * 2}:{H * 2},"
              f"zoompan=z='min(zoom+0.00055,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
              f":d={frames}:s={W}x{H}:fps={FPS},setsar=1")
        cmd = ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", it.path,
               "-t", f"{CLIP_SECONDS:.2f}", "-vf", vf, "-an",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst]

    r = run(cmd, timeout=420)
    if r.returncode != 0 or not os.path.exists(dst):
        log(f"  FEHLER {it.cid} ({os.path.basename(it.path)}): {r.stderr.strip()[:180]}")
        return ""
    return dst


def variant_encode(it: Item, base: str, name: str, filt: str) -> str:
    dst = os.path.join(OUT, f"{it.cid}_{name}.mp4")
    if os.path.exists(dst) and os.path.getsize(dst) > 10_000:
        return dst
    if name == "loop":
        graph = VARIANTS["loop"]
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", base,
               "-filter_complex", graph, "-map", "[out]",
               "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", base, "-vf", filt,
               "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst]
    r = run(cmd, timeout=420)
    if r.returncode != 0 or not os.path.exists(dst):
        log(f"  Variante fehlt {it.cid}_{name}: {r.stderr.strip()[:150]}")
        return ""
    return dst


def start_frame(it: Item, base: str) -> str:
    dst = os.path.join(OUT, f"{it.cid}_start.jpg")
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return dst
    r = run(["ffmpeg", "-y", "-v", "error", "-i", base, "-frames:v", "1",
             "-q:v", "3", dst], timeout=120)
    return dst if r.returncode == 0 and os.path.exists(dst) else ""


def render(limit: Optional[int] = None, workers: int = 6, offset: int = 0) -> None:
    items = load_plan()
    if offset:
        items = items[offset:]
    if limit:
        items = items[:limit]
    os.makedirs(OUT, exist_ok=True)

    def work(it: Item) -> None:
        base = base_encode(it)
        if not base:
            return
        it.rendered = {"base": base}
        j = start_frame(it, base)
        if j:
            it.rendered["start.jpg"] = j
        for name, filt in VARIANTS.items():
            p = variant_encode(it, base, name, filt)
            if p:
                it.rendered[name] = p
        log(f"  ok {it.cid:5} {it.label:16} {len(it.rendered)}/10 Dateien")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, items))

    # Nur die bearbeiteten Einträge zurückschreiben — der Rest des Plans bleibt
    # erhalten (ein `--limit`-Lauf darf die übrigen Clips nicht verlieren).
    full = load_plan()
    by_id = {i.cid: i for i in items if i.rendered}
    for idx, old in enumerate(full):
        if old.cid in by_id:
            full[idx] = by_id[old.cid]
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump([i.__dict__ for i in full], fh, ensure_ascii=False, indent=1)
    done = sum(1 for i in full if i.rendered)
    log(f"render: {done}/{len(full)} Clips fertig in {OUT}")


def load_r2():
    sys.path.insert(0, os.path.join(REPO, "scripts"))
    env = os.path.join(REPO, ".env")
    if os.path.exists(env):
        for line in open(env, "r", encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    import s3lite  # noqa: WPS433 (Laufzeit-Import, hängt an .env)
    return s3lite.S3Target.from_r2_env()


def public_url(key: str) -> str:
    base = os.environ.get("CFR2_PUBLIC_URL", "https://pub-663ece9f219d4704b826b80715e82034.r2.dev").rstrip("/")
    return f"{base}/{key}"


def upload(workers: int = 6) -> None:
    t = load_r2()
    items = load_plan()
    bank = json.loads(t.get_bytes("visuals/bank/bank-index.json") or b"{}")
    vidx = json.loads(t.get_bytes("visuals/bank/varianten-index.json") or b"{}")

    todo = [it for it in items if it.rendered and not it.uploaded
            and not (it.cid in bank and bank[it.cid].get("imported"))]

    def work(it: Item):
        keys: Dict[str, str] = {}
        for name, path in it.rendered.items():
            ext = "jpg" if name.endswith(".jpg") else "mp4"
            if name == "start.jpg":
                key = f"visuals/bank/{it.cid}_start.jpg"
            elif name == "base":
                key = f"visuals/bank/{it.cid}.{ext}"
            else:
                key = f"visuals/bank/{it.cid}_{name}.mp4"
            ctype = "image/jpeg" if ext == "jpg" else "video/mp4"
            try:
                with open(path, "rb") as fh:
                    t.put_bytes(key, fh.read(), ctype, meta={"category": it.cat[:60]})
                keys[name] = key
            except Exception as exc:  # noqa: BLE001 — Fehler je Datei melden, weiter
                log(f"  Upload-Fehler {key}: {exc}")
        return it, keys

    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(work, todo))

    for it, keys in results:
        if "base" not in keys:
            continue
        url = public_url(keys["base"])
        bank[it.cid] = {
            "name": it.cid,
            "datei": f"{it.cid}.mp4",
            "laenge": 1,
            "prompt_art": it.tags[0] if it.tags else "import",
            "prompt": it.title,
            "motiv": it.title,
            "quelle": it.path,
            "bytes": os.path.getsize(it.rendered["base"]),
            "sekunden": CLIP_SECONDS,
            "url": url,
            "imported": True,
            "kategorie": it.cat,
            "mood": it.mood,
            "energy": it.energy,
            "tags": it.tags,
            "license": it.license,
            "attribution": it.attribution,
            "source_url": it.source_url,
            "source": it.source,
            "start": public_url(f"visuals/bank/{it.cid}_start.jpg"),
            "varianten": {n: public_url(k) for n, k in keys.items() if n not in ("base", "start.jpg")},
        }
        vidx[it.cid] = {
            "quelle": f"{it.cid}.mp4",
            "varianten": {
                n: {"url": public_url(k)} for n, k in keys.items() if n not in ("base", "start.jpg")
            },
        }
        it.uploaded = keys
        log(f"  up {it.cid:5} {len(keys)} Dateien")

    t.put_bytes("visuals/bank/bank-index.json",
                json.dumps(bank, ensure_ascii=False, indent=1).encode(), "application/json")
    t.put_bytes("visuals/bank/varianten-index.json",
                json.dumps(vidx, ensure_ascii=False, indent=1).encode(), "application/json")

    # Upload-Stand in den Plan zurückschreiben (nicht die Datei überschreiben,
    # während ein anderer Lauf sie liest — erst am Ende, mit vollem Plan).
    full = load_plan()
    by_id = {i.cid: i for i in items if i.uploaded}
    for idx, old in enumerate(full):
        if old.cid in by_id:
            full[idx] = by_id[old.cid]
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump([i.__dict__ for i in full], fh, ensure_ascii=False, indent=1)
    log(f"upload: {sum(1 for i in full if i.uploaded)}/{len(full)} Clips in der Bank")


def write_generated_ts() -> None:
    items = load_plan()
    rows = []
    for it in items:
        if not it.uploaded:
            continue
        rows.append({
            "id": it.cid,
            "category": it.cat,
            "label": it.label,
            "mood": it.mood,
            "energy": it.energy,
            "tags": it.tags,
            "license": it.license,
            "attribution": it.attribution,
            "sourceUrl": it.source_url,
            "title": it.title,
            "varianten": sorted(k for k in it.uploaded if k not in ("base", "start.jpg")),
        })
    body = json.dumps(rows, ensure_ascii=False, indent=2)
    ts = f"""/**
 * AUTO-GENERIERT von scripts/visual-import/import_monastry.py — nicht von Hand editieren.
 *
 * Importierte Clips aus MONASTRY/Visuals (20 Themen-Ordner, R2-Bank).
 * Lizenz/A attribution je Clip sind unten mitgeführt; die Dateien liegen unter
 * `visuals/bank/<id>[_variante].mp4` im Bucket.
 */
export interface ImportedClip {{
  id: string;
  category: string;
  label: string;
  mood: 'duester' | 'cool' | 'lustig' | 'neutral';
  energy: 'ruhig' | 'mittel' | 'hart';
  tags: readonly string[];
  license: string;
  attribution: string;
  sourceUrl: string;
  title: string;
  varianten: readonly string[];
}}

export const IMPORTED_CLIPS: readonly ImportedClip[] = {body} as const;

/** Alle Varianten-Dateien je Clip (Basis zuerst), als Bank-IDs für die Route. */
export const IMPORTED_BANK_IDS: readonly string[] = IMPORTED_CLIPS.flatMap((c) => [
  c.id,
  ...c.varianten.map((v) => `${{c.id}}_${{v}}`),
]);
"""
    os.makedirs(os.path.dirname(GENERATED), exist_ok=True)
    with open(GENERATED, "w", encoding="utf-8") as fh:
        fh.write(ts)
    log(f"generated: {len(rows)} Clips -> {GENERATED}")


def main() -> None:
    ap = argparse.ArgumentParser(description="MONASTRY/Visuals -> VisualMONK-Clip-Bank")
    ap.add_argument("stage", choices=["scan", "render", "upload", "ts", "all", "stats"])
    ap.add_argument("--limit", type=int, default=None, help="nur die ersten N Clips rendern")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--offset", type=int, default=0)
    a = ap.parse_args()

    if a.stage == "scan":
        scan()
    elif a.stage == "render":
        render(a.limit, a.workers, a.offset)
    elif a.stage == "upload":
        upload(a.workers)
    elif a.stage == "ts":
        write_generated_ts()
    elif a.stage == "all":
        scan()
        render(a.limit, a.workers)
        upload(a.workers)
        write_generated_ts()
    elif a.stage == "stats":
        items = load_plan()
        per: Dict[str, int] = {}
        for it in items:
            per[it.cat] = per.get(it.cat, 0) + 1
        for cat, n in sorted(per.items()):
            log(f"{cat[:44]:46} {n}")
        log(f"gesamt: {len(items)} Clips, gerendert {sum(1 for i in items if i.rendered)}, "
            f"hochgeladen {sum(1 for i in items if i.uploaded)}")


if __name__ == "__main__":
    main()
