import { execSync } from 'node:child_process';

import { defineConfig } from 'vite';

/**
 * Stamp the build so a stale cache is obvious at a glance. Without this the
 * only way to know whether a hard reload actually took is to look for a
 * behaviour change, which is a terrible signal when the change you are testing
 * is itself unreliable.
 */
function buildSha(): string {
  // CI provides the commit directly; locally, ask git.
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    // Full ISO instant; the page renders it in the viewer's own timezone.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    // `pnpm dev` here talks to `wrangler dev` in ../worker. Set API_ORIGIN
    // to point it at the deployed Worker instead, for UI work that wants real
    // devices and real data without running the backend locally.
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
