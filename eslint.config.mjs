import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'out/', 'out-int/', '.vscode-test/', '*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // src/core is pure Node: the VS Code API must stay in src/vscode adapters
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['vscode'] }],
    },
  },
  {
    // the '**' glob sentinel is a deliberate, documented \x00 escape
    files: ['src/core/vouchignore.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
)
