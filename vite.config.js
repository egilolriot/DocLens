import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built app works when served from any path
  // (e.g. Firebase Hosting, GitHub Pages, or a plain static server).
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
});
