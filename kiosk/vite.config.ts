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
        manualChunks: {
          // The legacy engine build, for older Android WebViews — see src/lib/pdfEngine.ts.
          pdfjs: ['pdfjs-dist/legacy/build/pdf.mjs'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: { host: true, port: 5173 },
});
