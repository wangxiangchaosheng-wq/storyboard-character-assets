import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 骨架阶段：API 代理到本地 serve（`pnpm serve`），端上不感知服务地址
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});