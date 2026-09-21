import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 长轮询 / HTTP API 走 Vite 代理，避免开发态跨域。
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
      '/collab/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
});
