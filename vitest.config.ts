import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "vmThreads",
    isolate: false,
    include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts", "src/hooks/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      // Ratchet: roughly where the suite measures today; CI fails on drops.
      thresholds: { statements: 82, branches: 70, functions: 80, lines: 85 },
    },
  },
});
