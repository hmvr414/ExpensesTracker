import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_API_PORT ?? 3000}`,
        changeOrigin: true,
      },
      '/uploads': {
        target: `http://localhost:${process.env.VITE_API_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
  },
});
