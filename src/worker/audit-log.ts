/**
 * Long-term record of sign-in attempts. Workers Logs keeps data for only
 * a few days, so each attempt is also written to a SQLite table in the
 * Durable Object, where it stays until deleted by hand.
 *
 * Rows go straight to disk and are never held in memory, so the table's
 * size does not affect the Durable Object's memory use.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";

/** Create the audit table if it does not exist. */
export function initAuditLog(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       timestamp TEXT NOT NULL,
       line TEXT NOT NULL
     )`,
  );
}

/** Append one line to the audit table. */
export function appendAuditLog(sql: SqlStorage, line: string): void {
  sql.exec("INSERT INTO audit_log (timestamp, line) VALUES (?, ?)", new Date().toISOString(), line);
}

// The Durable Object registers its SQL storage here so its own entries
// are written directly, without an RPC call to itself.
let localSql: SqlStorage | null = null;

export function setLocalAuditSql(sql: SqlStorage): void {
  localSql = sql;
}

// The Worker has no storage of its own. It forwards lines to the Durable
// Object using the environment and execution context of the request being
// served, because `waitUntil` is only valid for the request that owns it.
const requestContext = new AsyncLocalStorage<{ env: Env; ctx: ExecutionContext }>();

export function runWithAuditContext<T>(env: Env, ctx: ExecutionContext, callback: () => T): T {
  return requestContext.run({ env, ctx }, callback);
}

/**
 * Run Durable Object code outside any Worker request context. When the
 * Worker and the object share an isolate, the Worker's context would
 * otherwise leak into the object and send its log lines through RPC to
 * itself.
 */
export function runInDurableObjectContext<T>(callback: () => T): T {
  return requestContext.exit(callback);
}

/**
 * Record an audit entry. Inside a Worker request the entry goes to the
 * Durable Object by RPC, because its SQL storage cannot be used from
 * another request's context. A failed write is dropped so that auditing
 * can never break a request.
 */
export function recordAuditLog(line: string): void {
  try {
    const context = requestContext.getStore();
    if (context) {
      const stub = context.env.MCP_OBJECT.get(context.env.MCP_OBJECT.idFromName("default"));
      context.ctx.waitUntil(stub.recordAuditLog(line).catch(() => {}));
    } else if (localSql) {
      appendAuditLog(localSql, line);
    }
  } catch {
    // Dropped on purpose, see above.
  }
}
