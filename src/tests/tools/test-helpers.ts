/**
 * Shared helpers for tool integration tests.
 * Sets up an MCP client-server pair connected in-memory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccessController } from "../../access-control";
import { setTestConfig, type Config } from "../../config";
import { registerReadTools } from "../../tools/read";
import { registerWriteTools } from "../../tools/write";
import { registerStructureTools } from "../../tools/structure";
import { registerFileTools } from "../../tools/files";
import { DocumentStore } from "../../document-store";
import { DummyDynalistServer, MockDynalistClient } from "../dummy-server";

export interface TestContext {
  server: DummyDynalistServer;
  mockClient: MockDynalistClient;
  ac: AccessController;
  mcpClient: Client;
  cleanup: () => Promise<void>;
}

/**
 * Create a fully wired test context: dummy server, MCP server with
 * all tools registered, and an MCP client ready to call tools.
 *
 * Call `cleanup()` when done (e.g. in afterEach).
 */
export async function createTestContext(
  setupFn?: (server: DummyDynalistServer) => void,
  config?: Partial<Config>,
): Promise<TestContext> {
  // Inject a default config to isolate tests from the developer's
  // real config file. Tests can pass overrides via the config parameter.
  setTestConfig({
    readDefaults: { maxDepth: 3, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
    readOnly: false,
    cache: { ttlSeconds: 300 },
    logLevel: "warn",
    ...config,
  });

  const server = new DummyDynalistServer();
  server.init();
  if (setupFn) {
    setupFn(server);
  }

  const mockClient = new MockDynalistClient(server);
  const ac = new AccessController(mockClient);

  const store = new DocumentStore(mockClient);

  const mcpServer = new McpServer({ name: "test-server", version: "1.0.0" });
  registerReadTools(mcpServer, mockClient, ac, store);
  registerWriteTools(mcpServer, mockClient, ac, store);
  registerStructureTools(mcpServer, mockClient, ac, store);
  registerFileTools(mcpServer, mockClient, ac);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  await mcpClient.connect(clientTransport);

  return {
    server,
    mockClient,
    ac,
    mcpClient,
    cleanup: async () => {
      await mcpClient.close();
      await mcpServer.close();
      setTestConfig(null);
    },
  };
}

/**
 * Call a tool and return the structured content from the response.
 * Throws if the tool call itself fails at the protocol level.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ structuredContent?: unknown; content?: unknown; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return result as { structuredContent?: unknown; content?: unknown; isError?: boolean };
}

/**
 * Call a tool and extract the structuredContent, asserting no error.
 */
export async function callToolOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await callTool(client, name, args);
  if (result.isError) {
    throw new Error(`Tool ${name} returned error: ${JSON.stringify(parseErrorContent(result))}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

/**
 * Parse error fields from a raw tool result's text content block.
 * Works with any result shape (MCP client responses, direct wrapToolHandler
 * returns, etc.) as long as it has a content array with a JSON text block.
 */
export function parseErrorContent(result: { content?: unknown }): Record<string, unknown> {
  const contentArray = result.content as { type: string; text: string }[];
  return JSON.parse(contentArray[0].text) as Record<string, unknown>;
}

/**
 * Call a tool and extract the error fields, asserting it IS an error.
 */
export async function callToolError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ error: string; message: string }> {
  const result = await callTool(client, name, args);
  if (!result.isError) {
    throw new Error(`Expected tool ${name} to return error but got: ${JSON.stringify(result.structuredContent)}`);
  }
  return parseErrorContent(result) as { error: string; message: string };
}

/**
 * Read a document and return its current version number.
 * Convenience for tests that need to supply expected_version.
 */
export async function getVersion(
  client: Client,
  fileId: string,
): Promise<number> {
  const result = await callToolOk(client, "read_document", { file_id: fileId });
  return result.version as number;
}

/**
 * Standard test data setup used by most tool tests.
 */
export function standardSetup(server: DummyDynalistServer): void {
  server.addFolder("folder_a", "Folder A", "root_folder");
  server.addFolder("folder_b", "Folder B", "root_folder");

  server.addDocument("doc1", "Test Document", "folder_a", [
    server.makeNode("root", "Test Document", ["n1", "n2", "n3"]),
    server.makeNode("n1", "First item", ["n1a", "n1b"]),
    server.makeNode("n1a", "Child A", []),
    server.makeNode("n1b", "Child B", [], { note: "A note on child B" }),
    server.makeNode("n2", "Second item", ["n2a"]),
    server.makeNode("n2a", "Nested child", []),
    server.makeNode("n3", "Third item", [], { checked: true, checkbox: true }),
  ]);

  server.addDocument("doc2", "Another Document", "folder_b", [
    server.makeNode("root", "Another Document", ["m1"]),
    server.makeNode("m1", "Only item", []),
  ]);

  server.addDocument("inbox_doc", "Inbox", "root_folder", [
    server.makeNode("inbox_root", "Inbox", []),
  ]);
  server.setInbox("inbox_doc", "inbox_root");
}
