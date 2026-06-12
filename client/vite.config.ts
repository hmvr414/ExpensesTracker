import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? `http://localhost:${process.env.VITE_API_PORT ?? 3000}`,
        changeOrigin: true,
      },
      '/uploads': {
        target: process.env.VITE_API_URL ?? `http://localhost:${process.env.VITE_API_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    // Cap test parallelism: a worker per core OOMs the 16 GB dev machine when
    // test runs overlap with the rest of the dev workstation stack.
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 2,
      },
    },
  },
});
