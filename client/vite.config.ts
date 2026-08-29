import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One .env at the repo root rather than a second copy in /client. Vite still
  // exposes only VITE_-prefixed variables to the browser.
  envDir: '..',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
