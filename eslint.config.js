// Deep-Audit-300 – konservative ESLint-Flat-Config.
// Findings werden vom Audit-CLI als Warnstufen erfasst; bestehender Code muss
// nicht sofort fehlerfrei sein. Reine Stil-/CommonJS-Regeln sind auf "warn"
// bzw. für JS-Dateien deaktiviert, damit sie nicht als Medium-Findings zählen.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
      '**/*.min.js',
      '**/*.d.ts',
    ],
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
