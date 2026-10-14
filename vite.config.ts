import { defineConfig } from 'vite';
export default defineConfig({
  root: '.',
  build: { outDir: 'dist' },
  server: { port: 3011, host: '0.0.0.0', allowedHosts: ['soncad.iotok.org'] },
});
