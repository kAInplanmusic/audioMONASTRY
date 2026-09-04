# Externe Library-Ressourcen – Lizenz-Register

> Stand: 2026-09-03 · Quelle: „Open-Source Audio Technology Audit (2026-09-03)"
> in `MASTER_TODO.md` (Klasse D = externe Ressource, Klasse G = Lizenzproblem).

Dieses Register dokumentiert alle im Audit bewerteten **externen** Sample-/
Instrument-Bibliotheken. Sie sind **keine** Bestandteile von audioMONASTRY:
Es wird kein Audiomaterial, kein Installer und kein abgeleitetes Preset dieser
Anbieter im Repository, im Container-Image oder in der `biblioMONK`-Library
ausgeliefert.

## Grundregeln

1. **Keine Redistribution.** Externe Libraries werden ausschließlich vom
   Nutzer selbst beim Anbieter bezogen und lokal eingebunden (Drag & Drop in
   `dropMONK`/`biblioMONK`).
2. **Keine Bündelung ohne Prüfung.** Ein Bündeln (Repo, Docker-Image, OPFS-
   Preset-Paket, Snapshot) ist erst nach dokumentierter Lizenzfreigabe
   zulässig. Bis dahin gilt `LICENSE_REVIEW_REQUIRED`.
3. **Keine Derivate ohne Freigabe.** Aus ND-lizenziertem Material (z. B.
   CC-BY-ND) dürfen keine Stems, Slices, Presets oder AI-Trainingsdaten
   erzeugt und weitergegeben werden.
4. **Namensnennung.** Wo die Lizenz eine Attribution verlangt (CC-BY), muss
   sie beim Export/Release der Session mitgeführt werden.
5. **CC0 ist die einzige Ausnahme**, bei der ein Bündeln grundsätzlich
   möglich ist (siehe VSCO 2 CE).

## Register

| Ressource | Anbieter | Lizenz-/Nutzungslage | Status | Umgang in audioMONASTRY |
|---|---|---|---|---|
| BBC Symphony Orchestra Discover | Spitfire Audio | Proprietäre EULA, kostenlos nach Registrierung; keine Weitergabe der Samples | `LICENSE_REVIEW_REQUIRED` | Nur nutzerseitig installiert; kein Bündeln, keine Preset-Weitergabe mit Audioinhalt |
| LABS | Spitfire Audio | Proprietäre EULA, kostenlos; Nutzung in Produktionen erlaubt, Weitergabe der Samples nicht | `LICENSE_REVIEW_REQUIRED` | Wie oben; nur Verweis in der Doku, kein Repo-Inhalt |
| Virtual Playing Orchestra | Virtual Playing | Aggregat aus mehreren Free-Libraries mit gemischten Lizenzen | `LICENSE_REVIEW_REQUIRED` | Nicht bündeln; Einzelquellen wären je Sample zu prüfen |
| Sonatina Symphonic Orchestra | Mattias Westlund | CC-BY 3.0 (Attribution) | Attribution nötig | Nutzerseitig; bei Weitergabe wäre Namensnennung verpflichtend |
| Berlin Free Orchestra | Orchestral Tools | Proprietäre EULA (SINE-Player-gebunden) | `LICENSE_REVIEW_REQUIRED` | Nur externer Player; keine Integration, kein Bündeln |
| The Alpine Project | Versilian/Community | CC-BY-**ND** (keine Bearbeitung) | Blockiert für Derivate | Keine Stems/Slices/Presets daraus; kein Bündeln |
| Pacific Percussion | Community | Lizenz unklar/nicht eindeutig dokumentiert | `LICENSE_REVIEW_REQUIRED` | Nicht verwenden, bis die Lizenz belegt ist |
| VSCO 2 Community Edition | Versilian Studios | CC0 (Public Domain Dedication) | Frei | Einzige Library, die als CC0-Subset gebündelt werden darf (siehe MASTER_TODO „B – Orchestrale CC0-Library") |

## Abgrenzung zu Code-Referenzen (Klasse G)

Für quelloffene **Software** (Surge XT, Dexed, LSP Plugins, LinuxSampler,
ZynAddSubFX u. a.) gilt zusätzlich: GPL/LGPL-Code wird **nicht** eingebettet.
Diese Projekte dienen ausschließlich als Algorithmus-/Architektur-Referenz;
jede Umsetzung in audioMONASTRY ist Eigencode (siehe Audit-Abschnitte A–C in
`MASTER_TODO.md`). Offene **Formate** (SFZ, DX7-SysEx, SF2, EXS24) sind davon
nicht betroffen und dürfen nativ implementiert werden.

## Prüf-Checkliste vor jedem Release

- [ ] Kein Audiomaterial der oben gelisteten Anbieter im Repo/Image/Snapshot.
- [ ] Keine Presets, die fremde Samples einbetten (nur Referenzen auf lokale
      Nutzerpfade/OPFS-Einträge).
- [ ] Attribution für CC-BY-Quellen im Export dokumentiert.
- [ ] Neue Fremdressourcen zuerst hier eintragen, dann verwenden.
