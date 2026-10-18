import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import eslintConfigPrettier from 'eslint-config-prettier';
import { flatConfigs as importFlatConfigs } from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { config, configs as tseslintConfigs } from 'typescript-eslint';

const blockStatements = ['if', 'for', 'while', 'switch', 'try', 'function', 'class'];

export default config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.astro/**'],
  },
  eslint.configs.recommended,
  tseslintConfigs.recommended,
  importFlatConfigs.recommended,
  importFlatConfigs.typescript,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: {
      unicorn,
      '@stylistic': stylistic,
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
    rules: {
      'import-x/no-unresolved': ['error', { ignore: ['^bun:', '^astro:'] }],
      // Oxlint correctness (error) and suspicious (warn) unicorn rules.
      // consistent-function-scoping stays off. The unicorn recommended preset is not enabled.
      'unicorn/no-await-in-promise-methods': 'error',
      'unicorn/no-empty-file': 'error',
      'unicorn/no-invalid-fetch-options': 'error',
      'unicorn/no-invalid-remove-event-listener': 'error',
      'unicorn/no-new-array': 'error',
      'unicorn/no-single-promise-in-promise-methods': 'error',
      'unicorn/no-thenable': 'error',
      'unicorn/no-unnecessary-await': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/no-useless-length-check': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/prefer-set-size': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-accessor-recursion': 'warn',
      'unicorn/no-array-fill-with-reference-type': 'warn',
      'unicorn/no-array-reverse': 'warn',
      'unicorn/no-array-sort': 'warn',
      'unicorn/no-confusing-array-with': 'warn',
      'unicorn/no-instanceof-builtins': 'warn',
      'unicorn/prefer-add-event-listener': 'warn',
      'unicorn/require-module-specifiers': 'warn',
      'unicorn/require-post-message-target-origin': 'warn',
      '@stylistic/lines-between-class-members': ['error', 'always'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        { blankLine: 'always', prev: '*', next: blockStatements },
        { blankLine: 'always', prev: blockStatements, next: '*' },
      ],
    },
  },
  eslintConfigPrettier,
);
