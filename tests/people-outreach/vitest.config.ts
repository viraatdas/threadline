import { defineConfig } from "vitest/config";

export default defineConfig({
  root: new URL("./", import.meta.url).pathname,
  resolve: {
    alias: {
      "@": new URL("../../", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./setup.ts"],
    include: ["./**/*.test.{ts,tsx}"],
  },
});
