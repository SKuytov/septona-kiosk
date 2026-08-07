import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Assets must resolve relatively: inside the APK the app is served from a file-like origin.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: { pdfjs: ['pdfjs-dist'], react: ['react', 'react-dom'] },
      },
    },
  },
  server: { host: true, port: 5173 },
});
