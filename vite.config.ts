import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import compression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    react(),
    compression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 10240,
    }),
    compression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 10240,
    }),
    process.env.ANALYZE === 'true' && visualizer({
      filename: 'dist/stats.html',
      open: true,
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'lodash': 'lodash-es',
      'react-is': path.resolve(__dirname, './node_modules/react-is/index.js'),
    },
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
    hmr: {
      overlay: true,
    },
  },
  build: {
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core
          'vendor-react': ['react', 'react-dom', 'react-is'],
          
          // Supabase split into smaller chunks
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-auth': ['@supabase/auth-js'],
          'vendor-storage': ['@supabase/storage-js'],
          'vendor-functions': ['@supabase/functions-js'],
          
          // ===== PERFORMANCE: Split charts into smaller chunks =====
          'vendor-charts-core': ['recharts'],
          'vendor-charts-utils': ['use-sync-external-store'],
          
          // ===== PERFORMANCE: Split PDF into smaller chunks =====
          'vendor-pdf-core': ['jspdf'],
          'vendor-pdf-utils': ['jspdf-autotable', 'html2canvas'],
          
          // ===== PERFORMANCE: Split icons =====
          'vendor-icons': ['lucide-react'],
          
          // UI libraries
          'vendor-ui': ['sonner', 'class-variance-authority', 'clsx', 'tailwind-merge'],
          
          // Utilities
          'vendor-utils': ['lodash-es', 'es-toolkit'],
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    cssCodeSplit: true,
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@supabase/supabase-js',
      '@supabase/auth-js',
      'lucide-react',
      'sonner',
      'lodash-es',
      'es-toolkit',
      'react-is',
      'recharts',
      'use-sync-external-store',
      'use-sync-external-store/shim/with-selector',
    ],
    exclude: ['jspdf', 'html2canvas', 'jspdf-autotable'],
    esbuildOptions: {
      target: 'es2020',
      treeShaking: true,
    },
  },
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
    target: 'es2020',
    treeShaking: true,
  },
  css: {
    devSourcemap: false,
    modules: {
      localsConvention: 'camelCase',
    },
  },
});