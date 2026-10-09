import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["client/**", "server/**", "shared/**", "index.client.tsx", "index.server.ts"],
      reporter: ["text-summary", ["text", { maxCols: 120 }], "json-summary"],
    },
  },
});
