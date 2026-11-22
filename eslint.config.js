// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Platform globals core must not touch (see tsconfig.core.json). */
const PLATFORM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'self',
  'globalThis',
  'process',
  'Buffer',
  'require',
  '__dirname',
  '__filename',
].map((name) => ({ name, message: 'src/core must stay platform-neutral.' }));

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'infra/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...PLATFORM_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', '../renderer/*', '../transport/*', '*/renderer/*', '*/transport/*'],
              message: 'src/core must stay platform-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tool configs need default exports.
    files: ['*.config.ts', '*.config.js'],
    rules: { 'no-restricted-exports': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' } },
  },
);
