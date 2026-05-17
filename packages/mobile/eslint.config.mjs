import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'android',
      'ios',
      '.expo',
      'dist',
      'build',
      '__mocks__',
      // Type declarations
      'src/types',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        // React Native globals
        __DEV__: 'readonly',
        // Web globals used in shared code
        ...globals.browser,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Hard violations: conditional hooks, missing deps. Always errors.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The v6 "experimental" rules are over-aggressive for ported code.
      // We downgrade to warnings so the lint can stay green while we audit.
      // These ARE real signals — fix when touching the file, don't bulk-edit
      // to silence them.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      // Defer "no unused import" to the unused-imports plugin so it can auto-fix
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      // RN allows `any` for native bridge types more often than web
      '@typescript-eslint/no-explicit-any': 'warn',
      // Common in React Native — avoids needing display names on inline components
      'react/display-name': 'off',
    },
  },
);
