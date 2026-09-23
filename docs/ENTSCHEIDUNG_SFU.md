# Was beim SFU zu entscheiden ist (`INFRA-HETZNER-015`)

**Stand 2026-09-23.** Diese Seite beantwortet nur die Frage: *„Was muss man
entscheiden?"* — sie entscheidet nichts. Gemessen ist der Zustand:

* Auf `sfu-1` bleibt der Container `audiomonastry-caddy` im Zustand **Created**,
  weil dort keine Caddyfile liegt (der Repo-Sync schliesst sie bewusst aus).
* Die App fährt **`ENABLE_SFU=0`** und benutzt `sfu-1` nur als **TURN-Server**.
* Die Flotte ist **AUS** (0 Server) — es läuft also gerade gar nichts.

Daraus ergeben sich **fünf** Entscheidungen. Die erste ist die wichtigste, weil
sie die anderen vier erübrigt.

---

## 1. Brauchen wir den SFU überhaupt?

| | |
|---|---|
| **Worum es geht** | Ein SFU (mediasoup) leitet Audio zentral weiter. Die Alternative ist direktes WebRTC zwischen den Teilnehmern (Mesh). |
| **Der Fakt, der zählt** | Eure Obergrenze ist **4 Nutzer** in einem Raum (`COLLAB-P0-*`). Bei 4 Teilnehmern sind das 6 Verbindungen — das schafft Mesh locker. Ein SFU lohnt sich ab etwa 5–6 Teilnehmern oder wenn jemand massiv schwache Upload-Bandbreite hat. |
| **Ohne SFU** | Ein Server weniger (`sfu-1` bleibt reiner TURN-Server), keine Caddyfile-Frage, keine RTC-Port-Freigabe, kein Kaltstart-Risiko. Die App läuft bereits so. |
| **Mit SFU** | Zentraler Mix, stabilere Verbindung bei ungleichen Leitungen, Aufnahme des Gesamtmixes serverseitig möglich. Kosten: ein weiterer Knoten muss laufen, wenn Sessions stattfinden. |
| **Meine Empfehlung** | **Ohne SFU bleiben**, solange es privat und bei 4 Nutzern ist. TURN braucht ihr wirklich (für Firewalls), SFU nicht. Wenn später mehr als 4 gleichzeitig reinhören sollen, ist die Entscheidung neu zu treffen. |

---

## 2. Wenn ja: woher kommt die Caddyfile auf `sfu-1`?

Heute liegt sie dort nicht, und der Sync schliesst sie absichtlich aus (sie
enthält host-spezifisches ACME). Drei Wege:

| Weg | Was passiert | Nachteil |
|---|---|---|
| **A: als verwaltete Datei in den Flottenstart legen** | Beim Start wird die Caddyfile aus einer Vorlage mit dem Hostnamen erzeugt und mitinstalliert. | Die Vorlage muss mit jedem Hostnamen funktionieren — das ist genau die Änderung, die bei `INFRA-HETZNER-002` schon einmal Ärger gemacht hat (Origin-TLS überschrieben). |
| **B: TLS über Cloudflare, kein eigener ACME-Container** | `sfu-1` bleibt hinter Cloudflare, Caddy entfällt dort ganz. | SFU-Medienverkehr läuft über UDP; Cloudflare proxyt kein UDP. Für den Signalisierungs-/Web-Teil ginge es, für RTP nicht. |
| **C: Caddyfile einmalig manuell auf den Knoten** | Einmal von Hand ablegen, danach in Ruhe lassen. | Nicht reproduzierbar; beim nächsten Neuaufsetzen fehlt sie wieder genau so wie jetzt. |

**Meine Empfehlung:** **A**, aber erst nach Punkt 1. Und dann mit demselben
Schutz, den `INFRA-HETZNER-002` nachträglich bekommen hat: die Vorlage darf eine
vorhandene Origin-Konfiguration nicht überschreiben.

---

## 3. Welche Ports müssen offen sein?

Aus dem Repo (nicht geraten — dieselben Zahlen stehen in
`services/portal-worker/src/index.js` und `scripts/hetzner/provision.py`):

| Protokoll | Port(s) | Zweck |
|---|---|---|
| UDP | 3478 | TURN |
| TCP | 3478 | TURN |
| UDP | 49152–49201 | RTP-Medien |
| TCP | 49152–49201 | RTP über TCP (Notpfad) |

**Bereits erledigt:** `INFRA-HETZNER-014` hat die Firewall-Regeln von den IPs der
*vorherigen* Flotte gelöst. Die Regeln zeigen jetzt auf die richtigen Adressen —
gemessen und dokumentiert. Diese Entscheidung ist also **nicht mehr offen**,
sondern war ein Fehler, der behoben ist.

---

## 4. Verträgt `sfu-1` beide Rollen (TURN + SFU)?

`INFRA-HETZNER-006` hat gezeigt, dass so etwas schiefgeht: `edge-1` war mit
~4,56 GiB Limits auf einem 4-GB-Servertyp **überbucht**. Bevor `sfu-1` zusätzlich
den SFU fährt, ist derselbe Abgleich nötig: Summe der Container-Limits gegen den
Servertyp von `sfu-1`.

**Meine Empfehlung:** erst rechnen, dann schalten. Wenn die Summe den Typ
übersteigt, ist das kein „wir probieren es mal", sondern ein garantierter
Ausfall im laufenden Betrieb.

---

## 5. Wann darf es Geld kosten?

| Zustand | Kosten |
|---|---|
| Flotte aus (heute) | **0 €** Struktur, nur die Volumes/Backups |
| `sfu-1` läuft | laufender Stundenpreis des Servertyps, solange er an ist |
| Flotte komplett | 5 Knoten (siehe `PRINCIPLES.md`) |

Ohne öffentliche Instanz und ohne laufende Sessions gibt es **keinen Grund**,
`sfu-1` durchlaufen zu lassen. Der Idle-Shutdown (`PROD-P3-F9`) ist genau dafür
da — er hängt aber an echter App-Nutzung, nicht an einem Timer allein.

**Meine Empfehlung:** SFU scharf machen **nur** für einen geplanten Testlauf,
danach wieder aus. Und vorher `PROD-P3-F9` so weit haben, dass der Knoten
zuverlässig von allein ausgeht.

---

## Kurzfassung

| # | Entscheidung | Meine Empfehlung |
|---|---|---|
| 1 | SFU überhaupt? | **Nein**, bei 4 Nutzern Mesh + TURN |
| 2 | Caddyfile-Weg | A, und erst nach 1 |
| 3 | Ports | nicht offen — war ein behobener Fehler |
| 4 | Doppelrolle auf `sfu-1` | erst Limits rechnen |
| 5 | Kosten | nur für geplante Testläufe einschalten |

`TODO(operator):` Wenn ihr 1 mit „ja" beantwortet, ist `INFRA-HETZNER-015` ein
echter Auftrag — dann gehören 2, 4 und 5 vorher geklärt, sonst wiederholt sich
der Zustand „Container steht auf Created".
