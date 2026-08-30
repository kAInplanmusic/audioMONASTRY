# audioMONASTRY – Windows: Xonar-U7-Geräte erkennen + Aggregations-Anleitung
$ErrorActionPreference = "SilentlyContinue"

Write-Host "=== Erkannte Audio-Geräte (ASUS Xonar U7) ==="
Get-PnpDevice -Class AudioEndpoint | Where-Object {
    $_.FriendlyName -match "Xonar|U7|ASUS"
} | Select-Object FriendlyName, Status | Format-Table -AutoSize

Write-Host @"

So erzeugst du EIN Aggregat-Gerät für 12.x/18.x/24.x:

OPTION A – ASIO4ALL (empfohlen, niedrigste Latenz):
  1. https://www.asio4all.org installieren
  2. ASIO4ALL-Offline-Settings öffnen
  3. Alle Xonar U7 aktivieren (WDM-Devices)
  4. In audioMONASTRY/Spatial das ASIO4ALL-Aggregat als Ausgabe wählen

OPTION B – Voicemeeter Potato:
  1. https://vb-audio.com/Voicemeeter/potato.htm installieren
  2. Hardware Out A1/A2/A3 = je eine Xonar U7
  3. Kanal-Routing nach dem audioMONASTRY-Kanalplan (D1: FL..SR, D2: CH9..16, …)

OPTION C – Windows-Bordmittel:
  1. mmsys.cpl → Wiedergabe → alle U7 sichtbar?
  2. Aufnahme → Stereomix aktivieren (falls verfügbar)
  3. Als Ausgabe in audioMONASTRY wählen

Kanalplan je U7: 1 FL · 2 FR · 3 C · 4 LFE · 5 RL · 6 RR · 7 SL · 8 SR
"@
