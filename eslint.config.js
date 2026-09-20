// Deep-Audit-300 – konservative ESLint-Flat-Config.
// Findings werden vom Audit-CLI als Warnstufen erfasst; bestehender Code muss
// nicht sofort fehlerfrei sein. Reine Stil-/CommonJS-Regeln sind auf "warn"
// bzw. für JS-Dateien deaktiviert, damit sie nicht als Medium-Findings zählen.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// PROD-P1-F4-Nachlauf: Der Lint-Lauf ist Teil von `npm run verify`. Liegen
// Agenten-Worktrees unter `.worktrees/` (gitignoriert, aber real auf der
// Platte), findet der TypeScript-Parser mehrere Kandidaten fuer
// `tsconfigRootDir` und bricht JEDE TS-Datei mit einem Parsing-Fehler ab
// (am 2026-09-20 gemessen: 5915 Fehler, 0 Warnungen - der gesamte verify-Lauf
// damit unbrauchbar, obwohl kein Code kaputt war).
// Deshalb: Wurzel explizit festnageln UND die Worktrees nicht mitlinten (sonst
// zaehlt jede Datei mehrfach und die Gate-Zahlen sind nicht mehr vergleichbar).
const repoRoot = dirname(fileURLToPath(import.meta.url));

const reactHooksRules =
  reactHooks.configs?.flat?.recommended?.rules ??
  reactHooks.configs?.recommended?.rules ??
  {};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'public/**',
      'services/**/target/**',
      // Agenten-Worktrees: eigene Kopie des Repos, nicht Teil des Gates. Ohne
      // diesen Eintrag zaehlt jede Datei doppelt und der Parser findet mehrere
      // tsconfig-Wurzeln (siehe Kommentar oben).
      '.worktrees/**',
      '**/*.min.js',
      '**/*.d.ts',
    ],
  },
  {
    // EINE Wurzel fuer den TypeScript-Parser. Ohne diese Festlegung rät
    // typescript-eslint anhand der lintierten Dateien und scheitert, sobald
    // mehr als ein tsconfig.json-Kandidat erreichbar ist.
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: repoRoot,
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs}'],
    rules: {
      // CommonJS-Dateien in services/* sind bewusst CommonJS (require).
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooksRules,
      // any ist im WebAudio-/Feature-Detection-Code bewusst vorhanden und wird
      // als Low-Rauschen nicht mehr separat gezählt (kein Gate-Relevanz).
      '@typescript-eslint/no-explicit-any': 'off',
      // TypeScript-Dateien nutzen NUR die @typescript-eslint-Variante, nicht die
      // Core-Regel (sonst doppelte Findings).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Bewusst deaktiviert: Das Projekt nutzt Non-Null-Assertions und any an
      // vielen Stellen; der Audit soll zählen statt den Bestand zu blockieren.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  {
    rules: {
      // Reine Stil-Regeln als Warnung statt Error (kein Medium-Gate-Relevanz).
      'prefer-const': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
);
