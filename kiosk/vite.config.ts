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
          react: ['react', 'react-dom'],
          /*
            The PDF engine is deliberately NOT named here. Naming a chunk puts it in the
            initial graph, so the engine was fetched and parsed before the panel could show
            anything even though the only thing importing it is loaded on demand. Left alone,
            it is bundled into the viewer's own chunk and arrives with it.
          */
        },
      },
    },
  },
  server: { host: true, port: 5173 },
});
