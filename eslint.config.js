// Path: eslint.config.js
// ESLint flat config for TypeScript

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // TypeScript strict rules
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      
      // General rules
      'no-console': 'off',
      'prefer-const': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.cjs', '*.mjs', 'scripts/**'],
  }
);
