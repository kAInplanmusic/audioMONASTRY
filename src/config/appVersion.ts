/**
 * UI2-P1-005: Die eine Versionsquelle ist `package.json`. Vite (und Vitest)
 * setzen `__APP_VERSION__` beim Bauen daraus ein; die Oberflaeche liest nur
 * diese Konstante.
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
