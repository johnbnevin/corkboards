/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@core': path.resolve(__dirname, '../core/src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, './src/test/setup.ts')],
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/rss-proxy.php': {
        target: 'https://corkboards.me',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
        // Rolldown (Vite 8 default) requires the function form — the object
        // form was dropped. Each branch matches the package's node_modules
        // path so transitive deps don't get pulled into a vendor chunk.
        manualChunks(id: string) {
          if (!id.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|react-router-dom)\//.test(id)) return 'vendor-react';
          if (id.includes('/node_modules/@radix-ui/')) return 'vendor-radix';
          if (id.includes('/node_modules/@nostrify/') || id.includes('/node_modules/nostr-tools/')) return 'vendor-nostr';
          if (/\/node_modules\/(react-markdown|remark-gfm|remark-breaks)\//.test(id)) return 'vendor-markdown';
          return undefined;
        },
      }
    }
  }
})
