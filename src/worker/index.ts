/**
 * Cloudflare Worker entry point. See app.ts for request handling.
 */

import { handleWorkerRequest } from "./app";
import type { Env } from "./env";

export { DynalistMcpDurableObject } from "./mcp-durable-object";

export default {
  fetch: handleWorkerRequest,
} satisfies ExportedHandler<Env>;
