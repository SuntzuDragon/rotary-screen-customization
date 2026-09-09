import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    // `npm run dev` here talks to `wrangler dev` in ../worker.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
