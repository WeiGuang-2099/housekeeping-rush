import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base 用相对路径，这样同一份构建既能在本地预览，也能放在 GitHub Pages 的子路径下。
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
