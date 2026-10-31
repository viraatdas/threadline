import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname), "server-only": path.resolve(__dirname, "tests/server-only.ts") },
  },
  // Migrating a fresh PGlite takes a few seconds, more on a busy machine.
  test: { environment: "node", include: ["tests/**/*.test.ts"], globals: true, hookTimeout: 60_000 },
});
