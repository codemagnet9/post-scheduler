// eslint.config.js (flat config)
// The import boundary that makes reaching around the registry a BUILD FAILURE. Anything outside
// src/providers may import ONLY the registry and the shared types — never a concrete adapter and
// never a specific capability descriptor. If a service imports src/providers/adapters/* or does
// `if (provider === 'instagram')`, this fails lint (and CI).
//
// The rules below inspect a TypeScript AST, so ESLint MUST parse with @typescript-eslint/parser —
// the default espree parser chokes on `interface`/type annotations and the whole boundary silently
// never runs. languageOptions.parser wires it in for every TS file.
import importPlugin from 'eslint-plugin-import';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/providers/**'], // inside providers, adapters may import each other freely
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { import: importPlugin, '@typescript-eslint': tsPlugin },
    // no-restricted-paths must RESOLVE each import to a file to know it lands in the adapter zone.
    // Without a resolver that understands .ts + directory index files, the rule silently skips every
    // import and enforces nothing — which is exactly how the boundary sat dead since Phase 3.
    settings: { 'import/resolver': { node: { extensions: ['.ts', '.js', '.json'] } } },
    rules: {
      // Explicit `any` erases the type system's guarantees; it must be a deliberate, commented waiver
      // (there are exactly two, both bridging drizzle's loose execute() signature).
      '@typescript-eslint/no-explicit-any': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // No module outside src/providers may reach into the adapter layer, EXCEPT the
              // registration barrel (adapters/index.ts) — it exports nothing (`export {}`), only runs
              // registerAdapter side-effects, so the composition root (server.ts / worker.ts) can
              // load it at startup without ever holding a concrete adapter reference.
              target: './src',
              from: './src/providers/adapters',
              except: ['index.ts'],
              message: 'Do not import a concrete adapter. Resolve it via src/providers/registry.ts.',
            },
            {
              // ...nor into a specific network's capability descriptor.
              target: './src',
              from: './src/providers/capabilities',
              message: 'Read capabilities via the adapter/registry, not a per-network file.',
            },
          ],
        },
      ],
      // Belt-and-suspenders: ban provider-name string branching outside the adapter layer.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "BinaryExpression[operator='==='][left.name='provider'], BinaryExpression[operator='==='][right.name='provider']",
          message: "No branching on provider name outside the adapter layer — use the capability descriptor.",
        },
      ],
    },
  },
  {
    // The adapter layer itself is exempt from the boundary (it IS the boundary).
    files: ['src/providers/**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { import: importPlugin, '@typescript-eslint': tsPlugin },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
];
