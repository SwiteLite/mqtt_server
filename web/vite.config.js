import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Dev: proxy /temperatures vers Express (:3000)
// Prod: build dans web/dist, servi par Express
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/temperatures': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
});
