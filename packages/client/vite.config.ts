import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 长轮询 / HTTP API 走 Vite 代理，避免开发态跨域。
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/collab/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
