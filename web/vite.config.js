import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Build sur PC (pas sur la BeagleBone — Vite est trop lourd pour elle).
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    target: 'es2019'
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/temperatures': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
});
