import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Local only: bind to 127.0.0.1 and proxy the API (which is also bound to 127.0.0.1). WEB_PORT / PORT change the ports.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    // the simulator's pure functions are shared with the API (src/analytics/simulator.ts) — allow only that file,
    // never the repo root (it holds bank.db and accounts.json)
    fs: { allow: ['.', '../src/analytics/simulator.ts'] },
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 4310}` },
  },
});
