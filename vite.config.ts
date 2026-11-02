import { defineConfig } from 'vite';

// base './' so the built app works from any sub-folder on the server (e.g. /pc-cad-view/)
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
  server: { host: true },
});
