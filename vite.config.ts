import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bridge (server/index.ts) owns the serial port and the Nemotron key; the web app reaches it via /api.
const BRIDGE = `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: BRIDGE, changeOrigin: false } },
  },
});
