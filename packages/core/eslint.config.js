/**
 * Lint config for @corkboards/core.
 *
 * Core was previously linted by nobody: web's eslint runs with cwd
 * packages/web and mobile's with cwd packages/mobile, so neither ever reached
 * ../core/src. That let the package every platform shares be the one place with
 * no lint coverage at all.
 *
 * Core is pure TypeScript — no DOM, no React — so this config drops the
 * React/react-refresh plugins web needs and adds nothing platform-specific. The
 * custom rules are imported from web's eslint-rules directory to keep ONE
 * source of truth for them; that is a lint-tooling reference only and creates
 * no runtime or build dependency from core on web.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import customRules from '../web/eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      // Core is platform-agnostic, but it does use the standard web-ish globals
      // that exist on every target it runs on (URL, crypto, TextEncoder,
      // console, setTimeout). It must NOT use DOM globals — `document` and
      // `window` are deliberately absent here so a stray reference fails lint.
      globals: {
        ...globals.es2020,
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      custom: customRules,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'custom/no-placeholder-comments': 'error',
      'no-warning-comments': ['error', { terms: ['fixme', 'todo'] }],
    },
  },
);
