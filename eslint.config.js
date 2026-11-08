import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
export default ts.config(
  {
    ignores: [
      'dist/**',
      '**/target/**',
      'node_modules/**',
      'src-tauri/gen/**',
      'test-results/**',
      'test-results-native/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: hooks.configs.recommended.rules,
  },
  {
    // Later work uses features/editor's boundary, so replacing the component stays in one file.
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['src/features/editor/MonacoEditors.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['monaco-editor', 'monaco-editor/*'],
              message: 'Use CodeEditor from src/features/editor.',
            },
          ],
        },
      ],
    },
  },
);
