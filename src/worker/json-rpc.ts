/**
 * JSON-RPC error responses for failures that happen outside the MCP
 * server, so agents see an explicit message instead of an opaque HTTP
 * error page.
 */

// JSON-RPC "Internal error".
const INTERNAL_ERROR_CODE = -32603;

export const PLATFORM_FAILURE_MESSAGE =
  "The server failed while handling this request. A write may have been partially applied. " +
  "Re-read the affected document before retrying.";

export const MISCONFIGURED_MESSAGE =
  "The server is misconfigured. The owner must check the Worker logs.";

export const NOT_ALLOWED_MESSAGE =
  "This GitHub account is not allowed to use this server. Ask the owner to add it to ALLOWED_GITHUB_USERS.";

/**
 * Read the JSON-RPC request ID from a request body without consuming the
 * original request. Returns null when the body is not a single JSON-RPC
 * request.
 */
export async function readJsonRpcId(request: Request): Promise<string | number | null> {
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === "object" && "id" in body) {
      const id = (body as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
  } catch {
    // Not JSON, or no body.
  }
  return null;
}

/**
 * Build a JSON-RPC error response with the given HTTP status.
 */
export function jsonRpcErrorResponse(id: string | number | null, message: string, status: number): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR_CODE, message } },
    { status },
  );
}
