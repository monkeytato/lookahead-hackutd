import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bridge (server/index.ts) owns the serial port and the Nemotron key; the web app reaches it via /api.
const BRIDGE = `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 8787}`;

// `vite build --mode artifact` (npm run build:artifact): the static demo published as a claude.ai
// artifact. Relative asset URLs, its own outDir, and the in-page bridge (src/state/localBridge.ts).
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  return {
    plugins: [react()],
    base: artifact ? './' : '/',
    define: artifact ? { 'import.meta.env.VITE_LOCAL_BRIDGE': JSON.stringify('1') } : {},
    build: artifact ? { outDir: 'dist-artifact', emptyOutDir: true } : {},
    server: {
      proxy: { '/api': { target: BRIDGE, changeOrigin: false } },
    },
  };
});
