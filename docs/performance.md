# Performance

The server minimizes API calls and computation through caching at multiple levels: document content, file tree paths, and configuration. Each cache has its own invalidation strategy tuned to how frequently the underlying data changes.

## Document cache

The `DocumentStore` class maintains an LRU cache of up to 5 recent document reads. On a cache hit, the store calls `checkForUpdates()` (a lightweight API endpoint that returns only version numbers) instead of re-reading the full document. If the version matches, the cached response is returned. If it differs, the stale entry is evicted and a fresh read is issued.

This matters because agents frequently read the same document multiple times in a conversation: once to display content, again before a write (to obtain the version), and again after a write (to verify). The cache eliminates redundant full reads for unchanged documents while still detecting concurrent edits via the version check.

Cache entries are invalidated after writes (via the version guard's `finally` block) and after `send_to_inbox` (which modifies the inbox document). The `invalidateAll()` method is available but not currently used in normal operation.

## File tree cache

The `AccessController` caches the file tree (the `listFiles()` response, resolved into a path map) with a configurable TTL (default 5 minutes). Every access control check uses this cached path map to resolve file IDs to title-based paths for rule evaluation.

The cache is invalidated in three situations:

- **After file mutations.** `create_document`, `create_folder`, `rename_document`, `move_document`, and `move_folder` all call `ac.invalidateCache()` after the API call succeeds, since file paths have changed.
- **On denial retry.** When a file is denied by access control, the controller retries with a fresh cache to handle stale paths from external renames or moves. This prevents a false denial when a file was recently moved to an allowed path.
- **On config reload.** The controller tracks a `configVersion` counter and invalidates the cache when the config changes, since access rules may have been added or modified.

## Config reloading

The config file (`~/.dynalist-mcp.json`) is checked on every tool invocation, but the check is a `stat()` call that reads only the file's modification time. If the mtime has not changed since the last load, the cached config is returned without reading or parsing the file. Only when the mtime changes does the server read and re-validate the JSON.

Config fields are split into two categories:

- **Hot-reloaded** (`access`, `logLevel`, `logFile`): updated on every file change. Access rules must always be current for security; log settings are useful to change for live debugging.
- **Startup-only** (`readDefaults`, `sizeWarning`, `cache`): read once at server initialization and frozen. Their values are baked into Zod schema `.default()` calls at tool registration time, so they become part of the JSON Schema transmitted to agents. Changing these fields in the config file after startup has no effect until the server is restarted.

A `configVersion` counter increments on every reload. Other modules (like `AccessController`) compare against this counter to detect config changes with a simple integer comparison instead of redundant file reads.

## Rate limit handling

The Dynalist API returns `TooManyRequests` when the rate limit is exceeded. The client retries with capped exponential backoff: 5 seconds base delay, capped at 10 seconds, up to 10 attempts (95 seconds maximum). The API's rate limit window clears in approximately 45-50 seconds, so 10 retries provides roughly 2x headroom.

## Change batching

The Dynalist API silently drops changes beyond its burst limit (approximately 500 changes per request). The client batches large change sets into chunks of 200 changes per request to stay safely within this limit. Each batch is a separate `editDocument` call, and the returned `batches_sent` count feeds into the version guard's post-write delta check.

## Node maps

When a document is read, helper functions build in-memory maps for O(1) lookups:

- `buildNodeMap()`: Maps node ID to the full node object. Used by every tool that needs to look up a specific node.
- `buildParentMap()`: Maps each node ID to its parent ID and index within the parent's children array. Used by search tools for ancestor lookups and by write tools for position resolution.

These maps are built once per document read and shared across the tool's execution. Without them, operations like ancestor chain lookups or sibling index resolution would require O(n) linear scans of the node array.

## Lazy field inclusion

Read and search tools minimize response size through selective field inclusion:

- **Notes** are included only when non-empty.
- **Heading** and **color** are included only when set to a non-default value (not `none`/`0`).
- **Parent context** is only computed when `parent_levels` is not `"none"`.

This sparse output reduces JSON serialization overhead and token consumption for typical documents where most nodes have no heading, color, or note.

## Lightweight version checks

The `check_document_versions` tool calls `checkForUpdates()` without fetching document content. Agents can use this to monitor many documents for changes in a single call, then only issue full `read_document` calls for documents whose version has changed. This is particularly useful for workflows that poll for updates across a set of documents.

## Batch ACL checks

The `list_documents` and `search_documents` tools evaluate access control policies for all files in a single batch via `ac.getPolicies()`, which populates the path cache once and evaluates all IDs against it. This is more efficient than calling `ac.getPolicy()` individually for each file, which would require separate cache lookups and potential denial retries per file.
