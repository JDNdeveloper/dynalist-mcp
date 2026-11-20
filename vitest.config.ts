import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const workerPlugin = () => cloudflareTest({
  wrangler: { configPath: "./src/tests/worker/wrangler.test.jsonc" },
});

// Both projects run inside the Workers runtime.
export default defineConfig({
  test: {
    projects: [
      {
        // Worker-specific tests. File names end in .vitest.ts so `bun test`
        // does not pick them up.
        plugins: [workerPlugin()],
        test: {
          name: "worker",
          include: ["src/tests/worker/**/*.vitest.ts"],
        },
      },
      {
        // Parity suite: the unchanged tool integration tests, run over
        // OAuth and Streamable HTTP into the Durable Object. Their
        // "./test-helpers" import resolves to the HTTP harness.
        plugins: [workerPlugin()],
        resolve: {
          alias: [
            { find: /^bun:test$/, replacement: "vitest" },
            {
              find: /^\.\/test-helpers$/,
              replacement: fileURLToPath(new URL("./src/tests/worker/http-test-helpers.ts", import.meta.url)),
            },
          ],
        },
        test: {
          name: "parity",
          include: ["src/tests/tools/**/*.test.ts"],
          setupFiles: ["./src/tests/worker/parity-setup.ts"],
        },
      },
    ],
  },
});
