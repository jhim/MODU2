import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: '../dist/client', emptyOutDir: true },
  test: { environment: 'node', include: ['../tests/unit/**/*.test.ts', '../tests/api/**/*.test.ts'] }
});
