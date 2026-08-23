import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  {
    // The app now lives at the repo root, so a bare `eslint .` — and the stop
    // hook, which passes changed files explicitly — can reach repo-level
    // tooling state that was never part of the old frontend/ subtree.
    // Mirrors the same block in .prettierignore.
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      '.claude/**',
      '.impeccable/**',
      '.design-sync/**',
      'scripts/benchmark.mjs',
    ],
  },
  ...nextCoreWebVitals,
];

export default eslintConfig;
