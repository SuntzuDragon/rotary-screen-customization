import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/.wrangler/', 'firmware/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware rules resolve each file through the tsconfig that owns it.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Empty arrows here are deliberate no-ops: default `onStatus = () => {}`
      // callbacks and best-effort `.catch(() => {})` while tearing a port down.
      // An empty named function or method is still reported.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
    },
  },
  { files: ['web/**'], languageOptions: { globals: globals.browser } },
  { files: ['worker/**'], languageOptions: { globals: globals.serviceworker } },
  // Tool config files belong to no tsconfig, so they cannot be type-checked.
  {
    files: ['eslint.config.js', '**/vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
