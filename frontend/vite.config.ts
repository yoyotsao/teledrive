import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  
  return {
    plugins: [
      react(),
      nodePolyfills({
        include: [
          'buffer', 'util', 'stream', 'events', 'crypto', 'assert', 'process',
          'net', 'fs', 'os', 'path', 'zlib', 'constants',
        ],
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
    ],
    server: {
      // Local-only by default. LAN access must be an explicit, credential-free
      // development choice via VITE_DEV_HOST and VITE_ALLOWED_HOSTS.
      host: env.VITE_DEV_HOST || '127.0.0.1',
      port: 3000,
      allowedHosts,
      proxy: {
        '/api/v1': {
          target: process.env.VITE_BACKEND_URL || env.VITE_BACKEND_URL || 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
    cacheDir: '.vite',
    build: {
      commonjsOptions: {
        ignoreDynamicRequires: true,
      },
      rollupOptions: {
        output: {
          manualChunks: {
            telegram: ['telegram'],
          },
        },
      },
    },
    define: {
      'import.meta.env.VITE_TELEGRAM_API_ID': JSON.stringify(env.VITE_TELEGRAM_API_ID || ''),
      'import.meta.env.VITE_TELEGRAM_API_HASH': JSON.stringify(env.VITE_TELEGRAM_API_HASH || ''),
      global: 'globalThis',
      Buffer: 'globalThis.Buffer',
    },
  };
});
