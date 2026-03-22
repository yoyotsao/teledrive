import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
    define: {
      'import.meta.env.VITE_TELEGRAM_API_ID': JSON.stringify(env.VITE_TELEGRAM_API_ID || ''),
      'import.meta.env.VITE_TELEGRAM_API_HASH': JSON.stringify(env.VITE_TELEGRAM_API_HASH || ''),
    },
  };
});
