import appiumConfig from '@appium/eslint-config-appium-ts';
import unicorn from 'eslint-plugin-unicorn';

export default [
  ...appiumConfig,
  {
    files: ['**/*.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      unicorn: unicorn,
    },
    rules: {
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: [
            // ─── PUBLIC METHODS ─────────────────────────────────────────────────────
            'public-static-method',
            'public-instance-method',

            // ─── PROTECTED METHODS ──────────────────────────────────────────────────
            'protected-static-method',
            'protected-instance-method',

            // ─── PRIVATE METHODS ────────────────────────────────────────────────────
            'private-static-method',
            'private-instance-method',
          ],
        },
      ],
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
        },
      ],
    },
    ignores: ['**/build/**', '**/node_modules/**'],
  },
];
