// eslint.config.js (flat config)
// The import boundary that makes reaching around the registry a BUILD FAILURE. Anything outside
// src/providers may import ONLY the registry and the shared types — never a concrete adapter and
// never a specific capability descriptor. If a service imports src/providers/adapters/* or does
// `if (provider === 'instagram')`, this fails lint (and CI).
import importPlugin from 'eslint-plugin-import';

export default [
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/providers/**'], // inside providers, adapters may import each other freely
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // No module outside src/providers may reach into the adapter layer...
              target: './src',
              from: './src/providers/adapters',
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
    plugins: { import: importPlugin },
    rules: {},
  },
];
