/**
 * eqMONK · Rack-Modul (Brücke)
 * ============================
 * Die EQ-Oberfläche gibt es genau einmal: `EQPluginTerminal` (36-Band-Para-EQ
 * mit Kurve, Fadern, A/B und Session-Persistenz über `writePluginSettings('eq', …)`).
 *
 * Der frühere 6-Band-Eigenbau an dieser Stelle war ein zweiter, abweichender EQ.
 * `App.tsx` rendert für `eq` diesen Namen – dadurch blieb das neue Terminal
 * unsichtbar; `tests/e2e/pluginPersistence.spec.ts` suchte `slider "EQ-Gain"`
 * und lief 90 s in den Timeout (Befund 2026-11-05). Diese Datei ist deshalb nur
 * noch die Brücke zum Terminal und enthält keine eigene Bedienlogik mehr.
 */
export { EQPluginTerminal as EqRack } from '../EQPluginTerminal';
