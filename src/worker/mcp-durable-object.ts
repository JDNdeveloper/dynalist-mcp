/**
 * The single Durable Object that serves MCP requests. It owns the
 * long-lived DynalistClient, AccessController, and DocumentStore, and
 * builds a fresh McpServer per request from them, which reproduces the
 * stdio server's one-process model.
 *
 * The object's memory is wiped when it hibernates (about 10 seconds
 * after its last request), so state that must survive between tool
 * calls goes through DurableObjectPersistentStore.
 */

import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { log, setLogSink } from "../config";
import { DynalistClient } from "../dynalist-client";
import { AccessController } from "../access-control";
import { DEFAULT_DOCUMENT_CACHE_CAPACITY, DocumentStore } from "../document-store";
import { createDynalistServer } from "../server";
import { installEnvConfigLoader } from "./env-config-loader";
import { DurableObjectPersistentStore } from "./durable-object-store";
import { appendAuditLog, initAuditLog, runInDurableObjectContext, setLocalAuditSql } from "./audit-log";
import { workersLogSink } from "./log-sink";
import type { Env } from "./env";

export class DynalistMcpDurableObject extends DurableObject<Env> {
  private handler: StatelessMcpHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initAuditLog(ctx.storage.sql);
    setLocalAuditSql(ctx.storage.sql);
    setLogSink(workersLogSink);
    installEnvConfigLoader(env.DYNALIST_MCP_CONFIG_JSON);

    const client = new DynalistClient(env.DYNALIST_API_TOKEN, { apiBase: env.DYNALIST_API_BASE });
    const persistent = new DurableObjectPersistentStore(ctx.storage.kv);
    const shared = {
      client,
      ac: new AccessController(client, persistent),
      store: new DocumentStore(client, DEFAULT_DOCUMENT_CACHE_CAPACITY, persistent),
    };
    this.handler = createMcpHandler(() => createDynalistServer(shared), {
      // Without this, handler failures become a generic 500 with nothing logged.
      onerror: (error) => log("error", `MCP handler error: ${error.message}`),
    });
  }

  /** Called by the Worker to store an audit entry from its own isolate. */
  async recordAuditLog(line: string): Promise<void> {
    runInDurableObjectContext(() => appendAuditLog(this.ctx.storage.sql, line));
  }

  async fetch(request: Request): Promise<Response> {
    // The handler only reads OAuth props from its context argument, and
    // the Worker has already verified the token before forwarding.
    return runInDurableObjectContext(() => this.handler(request, this.env, this.ctx as unknown as ExecutionContext));
  }
}
