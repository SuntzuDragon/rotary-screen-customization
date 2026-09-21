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
  // This file is plain JS and in no tsconfig, so it cannot be type-checked.
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
);
