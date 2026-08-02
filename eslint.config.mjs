import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      // 未使用的参数以 _ 开头即可放行
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      curly: 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'esbuild.mjs'],
  },
);
