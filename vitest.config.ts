import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    // Server logs are shown only for failing tests (keeps `npm run deploy` readable).
    silent: "passed-only",
  },
});
