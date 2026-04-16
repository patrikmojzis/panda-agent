import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**/*.live.test.ts"],
    environment: "node",
  },
});
