import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base 用相对路径，这样同一份构建既能在本地预览，也能放在 GitHub Pages 的子路径下。
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    // 界面的测试用 .tsx 写，在 Node 里用 react-dom/server 渲染成字符串，不需要浏览器环境。
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
