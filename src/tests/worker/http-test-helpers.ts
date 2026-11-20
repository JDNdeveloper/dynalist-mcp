/**
 * HTTP variant of src/tests/tools/test-helpers.ts for the parity suite.
 * The vitest parity project aliases the tool tests' "./test-helpers"
 * import to this module, so the unchanged tool tests run over OAuth and
 * Streamable HTTP into the Durable Object instead of an in-memory
 * transport. Any behavior difference between transports fails the suite.
 */

import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { setTestConfig, type Config } from "../../config";
import { DummyDynalistServer, MockDynalistClient } from "../dummy-server";
import { DEFAULT_TEST_CONFIG, type TestContext } from "../tools/test-helpers";
import { FILE_TREE_CACHE_KEY } from "../../worker/durable-object-store";
import {
  GithubStub,
  authorize,
  connectMcpClient,
  installOutboundStubs,
  mcpObjectStub,
  resetDurableObject,
} from "./harness";

export {
  callTool,
  callToolOk,
  callToolError,
  parseErrorContent,
  getSyncToken,
  standardSetup,
  type TestContext,
} from "../tools/test-helpers";

// OAuth grants persist in KV for the whole test file, so one token
// serves every test in it.
let cachedAccessToken: string | null = null;

/**
 * Same contract as the in-memory createTestContext, but the MCP client
 * talks to the Worker over HTTP.
 */
export async function createTestContext(
  setupFn?: (server: DummyDynalistServer) => void,
  config?: Partial<Config>,
): Promise<TestContext> {
  setTestConfig({ ...DEFAULT_TEST_CONFIG, ...config });

  const server = new DummyDynalistServer();
  server.init();
  if (setupFn) {
    setupFn(server);
  }
  installOutboundStubs(server, new GithubStub());
  await resetDurableObject();

  cachedAccessToken ??= await authorize();
  const mcpClient = await connectMcpClient(cachedAccessToken);

  // Tests call ac.invalidateCache() synchronously. The real controller
  // lives in the Durable Object, so the cache entry is dropped from its
  // storage through a pending promise that the next request awaits.
  //
  // NOTE: the tool tests that call it also change the access rules, which
  // forces a refetch through the config hash anyway, so the suite would
  // not notice if this shim stopped working.
  let pendingInvalidation: Promise<void> = Promise.resolve();
  const ac = {
    invalidateCache: () => {
      pendingInvalidation = runInDurableObject(mcpObjectStub(), (_instance, state) => {
        state.storage.kv.delete(FILE_TREE_CACHE_KEY);
      });
    },
  } as unknown as TestContext["ac"];
  const originalCallTool = mcpClient.callTool.bind(mcpClient);
  mcpClient.callTool = (async (...args: Parameters<typeof mcpClient.callTool>) => {
    await pendingInvalidation;
    return originalCallTool(...args);
  }) as typeof mcpClient.callTool;

  return {
    server,
    mockClient: new MockDynalistClient(server),
    ac,
    mcpClient,
    cleanup: async () => {
      await mcpClient.close();
      setTestConfig(null);
      vi.restoreAllMocks();
    },
  };
}
