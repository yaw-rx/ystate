import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';

export default tseslint.config(
    { ignores: ['**/dist/**', 'node_modules/**', '*.config.js', '*.config.ts'] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: {
                    loadTypeScriptPlugins: true,
                },
                tsconfigRootDir: import.meta.dirname,
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            '@typescript-eslint/consistent-type-exports': 'error',
            '@typescript-eslint/only-throw-error': 'error',
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
);