import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 后端端口可被 API_PORT 覆盖。
 *
 * 默认 8787 是"人手动 npm run server"的端口；自动化验收会指定另一个端口，
 * 免得撞上开发者自己开着的那个服务 —— 撞上就会静默地用错服务（错的 .env、
 * 错的记忆文件），验收结论当场失真。宁可验收时用一个独立的端口和临时数据目录。
 *
 * 这里刻意不写 `process.env`：tsconfig 的 types 只有 vite/client，没有 @types/node，
 * 直接引用 process 会让 `npm run typecheck` 报 TS2591。走 globalThis 既能取到，
 * 也不给项目平白引入一份 node 类型定义（那样反而会让前端代码误以为能用 node API）。
 */
const NODE_ENV_VARS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const API_PORT = NODE_ENV_VARS.API_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    host: '127.0.0.1',
    /**
     * 把 /api 代理到本地 Node 服务（server/server.mjs）。
     * 为什么不在前端直接 fetch('http://127.0.0.1:8787')：
     *  · 走代理后前端与 API 同源，不需要 CORS，也不会把端口写死在代码里
     *  · 生产构建后同一份前端代码由 Node 服务自己托管，路径完全一致
     */
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
