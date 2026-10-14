import { defineConfig } from 'vite';
export default defineConfig({
  root: '.',
  build: { outDir: 'dist' },
  server: { port: 30010, host: '0.0.0.0', allowedHosts: ['soncad.dnaboy.org', 'soncad.iotok.org'] },
});
