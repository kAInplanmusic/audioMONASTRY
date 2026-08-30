/**
 * DB-Kompatibilitäts-Shim – re-exportiert den Plattform-Adapter.
 * (Interface-Boundary-Regel: kein direkter indexedDB-Zugriff mehr hier.)
 */
export { openDB, saveToDB } from './indexedDB';
