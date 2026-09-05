import { fileURLToPath, URL } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  // Next.js 使用 jsx: preserve 交给框架编译；Vitest 需要在导入组件时先把
  // TSX 转换为 JavaScript，因此测试项目显式启用 automatic JSX transform。
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    name: "@insightforge/web",
    setupFiles: [fileURLToPath(new URL("./test-setup.ts", import.meta.url))],
  },
});
