import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Live tests (real 9Router calls) are opt-in via RUN_LIVE=1 and isolated.
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});
