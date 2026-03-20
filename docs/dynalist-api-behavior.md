# Dynalist API Behavior Reference

Canonical reference for how the Dynalist API (https://apidocs.dynalist.io/) actually
behaves, based on exhaustive testing against a real account.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/file/list` | List all documents and folders. |
| `/file/edit` | Create, rename, or move files/folders. No delete. |
| `/doc/read` | Read a document's nodes. |
| `/doc/edit` | Insert, edit, move, or delete nodes within a document. |
| `/doc/check_for_updates` | Check version numbers without fetching content. |
| `/inbox/add` | Add an item to the user's inbox. |

## `/file/list` response

```
{
  root_file_id: string,
  files: [
    {
      id: string,
      title: string,
      type: "document" | "folder" | "root",
      permission: number,       // 0=none, 1=read, 2=edit, 3=manage, 4=owner
      collapsed?: boolean,      // folders only, not always present
      children?: string[]       // folders and root only, array of child file IDs
    }
  ]
}
```

- Exactly one file has `type: "root"`. Its `id` matches `root_file_id`. It is a structural
  container for the top-level files, not a user-visible folder. It has an empty title and
  a `children` array listing the top-level file IDs.
- Documents do not have `children`.
- Permission is a number (0-4), but the MCP layer maps it to strings for readability:
  `"owner"`, `"manage"`, `"edit"`, `"read"`, `"none"`.
- Files with `permission: 0` do not appear in the response at all.

## `/doc/read` response: node shape

```
{
  file_id: string,
  title: string,
  version: number,
  nodes: [
    {
      id: string,
      content: string,
      note: string,
      created: number,          // milliseconds since epoch
      modified: number,         // milliseconds since epoch
      children?: string[],      // child node IDs (omitted for leaf nodes)
      checked?: boolean,        // present only when true
      checkbox?: boolean,       // present only when true
      heading?: number,         // 1=H1, 2=H2, 3=H3, omitted when 0
      color?: number,           // 1=red, 2=orange, 3=yellow, 4=green, 5=blue, 6=purple, omitted when 0
      collapsed?: boolean       // always present
    }
  ]
}
```

- The root node has the document title as `content`.
- `note` is always present (empty string when no note).
- `children` is documented as always present (empty array for leaf nodes), but in practice
  the API has been observed to omit it entirely for leaf nodes. Code must not assume
  `children` is always present. Verified (2026-03-13): a leaf node used as the parent for
  a multi-item insert returned no `children` field, causing a crash on `.length` access.
- `checked`, `checkbox`, `heading`, `color` are omitted when at their default (falsy) values.
- `collapsed` is always present, even when `false`.
- `created` and `modified` are millisecond Unix timestamps.
- The `nodes` array is flat (not nested). Parent-child relationships are expressed through
  the `children` arrays.

### `heading` values

The API documents `heading` as an integer 0-3 but does not label the levels. Verified
against the Dynalist UI (2026-03-13):

| Value | Meaning |
|-------|---------|
| 0 | No heading (default, omitted from response) |
| 1 | H1 (largest) |
| 2 | H2 |
| 3 | H3 (smallest) |

### `color` values

The API documents `color` as an integer 0-6 but does not map numbers to colors. Verified
against the Dynalist UI (2026-03-13):

| Value | Color |
|-------|-------|
| 0 | No color (default, omitted from response) |
| 1 | Red |
| 2 | Orange |
| 3 | Yellow |
| 4 | Green |
| 5 | Blue |
| 6 | Purple |

## Multiline content

Both `content` and `note` fields support literal newline characters. The API stores and
returns them faithfully. In the Dynalist web UI, newlines in `content` render as line breaks
within the same node (equivalent to Cmd+Shift+Enter on macOS / Ctrl+Shift+Enter on Windows),
and newlines in `note` render as line breaks in the note area. Code blocks (triple-backtick
fences) in notes also render correctly.

Verified against the Dynalist UI (2026-03-13).

## `/doc/edit`: node actions

### Insert

```json
{ "action": "insert", "parent_id": "...", "index": 0, "content": "..." }
```

Supported fields: `content`, `note`, `checked`, `checkbox`, `heading` (1-3), `color` (1-6).

- `parent_id` and `index` are required.
- `index: 0` = first child, `index: -1` = last child.
- Response includes `new_node_ids` array with IDs in the same order as the changes array.
- Setting `checked: true` without `checkbox: true` is accepted but semantically
  inconsistent (the API stores `checked` but the UI has no checkbox to display).

### Edit

```json
{ "action": "edit", "node_id": "...", "content": "new content" }
```

Supported fields: `content`, `note`, `checked`, `checkbox`, `heading` (1-3), `color` (1-6).

- **Omitting a field leaves it unchanged.** This is critical: edit is a partial update,
  not a full replacement. The dummy server must implement this behavior.
- Empty `content` (""): allowed. Node stored with empty content.
- Empty `note` (""): clears the note.
- `heading: 0`: removes heading. `color: 0`: removes color.
- `collapsed` is NOT supported in edit actions. The field is silently ignored.

### Move

```json
{ "action": "move", "node_id": "...", "parent_id": "...", "index": 0 }
```

- Moves the node and all its descendants.
- `index: -1` = last child of new parent.
- The API uses **post-removal indexing**: it removes the node from its current
  position first, then inserts at the given index. For same-parent moves where
  the node is earlier than the target index, the removal shifts all subsequent
  siblings down by 1. The caller must subtract 1 from the target index to
  compensate, or the node will land one position too late.
- Moving a node to be a child of itself: API silently accepts but the node becomes
  orphaned (unreachable from the root tree). Our tool validates and rejects this.
- Moving the root node: API returns a non-JSON response or `LockFail`, and the
  entire account becomes permanently locked (all subsequent API calls across all
  documents return `LockFail`). Verified (2026-03-13) against the live API. Our
  tool validates and rejects this. See [forum discussion](https://talk.dynalist.io/t/api-move-action-on-root-node-breaks-account/10074).
- **Cross-document moves are not supported.** Node IDs are scoped to their document,
  not global. Verified (2026-03-13) against the live API with two approaches:
  - Source-anchored (`file_id` = source doc, `parent_id` = root of dest doc): API
    returns `Ok` but silently does nothing. The foreign `parent_id` is not recognized
    within the source document's node list, so the move is a no-op.
  - Destination-anchored (`file_id` = dest doc, `node_id` from source doc): API
    returns `NodeNotFound` because the node ID does not exist in the dest document.
  The Dynalist desktop/web client supports cross-document drag-and-drop, so it likely
  uses a private API endpoint not exposed in the public API.

### Delete

```json
{ "action": "delete", "node_id": "..." }
```

- **Deletes only the specified node.** Children become orphaned (exist in `nodes` array
  but are unreachable from the root tree). This differs from the Dynalist web UI, which
  does recursive deletion. See [forum discussion](https://talk.dynalist.io/t/api-node-deletion-orphans-the-child-nodes/10071).
- Orphaned nodes are invisible from root traversal, but are searchable (they exist in the
  raw `nodes` array) and readable by direct node ID.
- Orphans persist indefinitely. No evidence of server-side garbage collection.
- Deleting the root node: API silently ignores (no error, no effect).

### Batch changes

- Multiple changes can be sent in a single request via the `changes` array.
- The API silently drops changes beyond its burst limit (~500 changes per request).
  Our client batches in chunks of 200 to stay within the limit.
- `new_node_ids` in the response corresponds to insert actions only, in order.

### Batch insert ordering

The API snapshots parent state before processing a batch of changes. Index -1
("last child") is resolved against the snapshot, not the live state. When multiple
inserts target the same parent with `index: -1`, they all resolve to the same
position and the resulting order is reversed relative to the input order.

Verified (2026-03-13): inserting `[A, B, C]` under an empty parent with `index: -1`
for all three produces child order `[C, B, A]`.

Explicit sequential indices (0, 1, 2, ...) are not affected because each item targets
a distinct position. The API processes them in batch order, and splice semantics at
distinct indices produce the expected result.

Verified (2026-03-13): inserting `[D, E, F]` with indices `[0, 1, 2]` under a parent
with 3 existing children produces `[D, E, F, ...existing]`.

**Workaround**: to preserve input order when appending, read the parent's current
child count and use explicit indices starting from that count (e.g. `[count, count+1,
count+2]`) instead of -1. Similarly, for prepending, use `[0, 1, 2, ...]` instead
of all 0s.

### Batch move ordering

Batch moves with explicit indices are processed sequentially: each move sees the
result of all prior moves in the same batch. This means index arithmetic based on
the pre-batch state works correctly when each successive move targets the next
index (e.g. `[N, N+1, N+2]`), because each move inserts at its target position
and shifts later siblings right.

Verified (2026-03-13) with two cases:

**First-child case**: Target at index 0 under Parent, with children [A, B, C] and
a Sibling After at index 1. Batch moves A, B, C to Parent at indices 0, 1, 2.
Result: [A, B, C, Target, Sibling After]. Children preserve original order and
appear at Target's former position.

**Middle-child case**: Sibling Before at index 0, Target at index 1, Sibling After
at index 2. Batch moves A, B, C to Parent at indices 1, 2, 3. Result:
[Sibling Before, A, B, C, Target, Sibling After]. Same correct behavior.

**Index -1 in batch moves**: like batch inserts, move index -1 ("last child") is
resolved against a snapshot taken before the batch, not the live state. When
multiple moves target the same parent with index -1, they all resolve to the same
position and the resulting order is reversed relative to the input order. The
`move_nodes` tool avoids this by resolving `last_child` to explicit indices based
on the mutable in-memory child count.

Verified (2026-03-13): moving B then C to root as last_child with index -1
produces [Parent, C, B] (reversed). Using explicit indices 1 and 2 produces the
correct [Parent, B, C].

## Rate limiting

The API uses a **token bucket algorithm** with per-endpoint steady-state rates and burst
capacities. Exceeding either limit returns `_code: "TooManyRequests"` with HTTP 200 (not
an HTTP error status). No `Retry-After` header is provided.

### Per-endpoint request limits

From the [official docs](https://apidocs.dynalist.io/):

| Endpoint              | Steady rate   | Burst          |
|-----------------------|---------------|----------------|
| `/file/list`          | 6 req/min     | 10 requests    |
| `/file/edit`          | 60 req/min    | 50 requests    |
| `/doc/read`           | 30 req/min    | 100 requests   |
| `/doc/check_for_updates` | 60 req/min | 50 requests    |
| `/doc/edit`           | 60 req/min    | 20 requests    |
| `/inbox/add`          | 60 req/min    | 20 requests    |

### Per-change limit (`/doc/edit` only)

In addition to the request-level limit, `/doc/edit` has a separate per-change budget:
240 changes/min steady rate, 500-change burst. A batch of N changes costs N against this
budget (not 1).

### Observed behavior

- Recovery from `TooManyRequests` takes ~45-50 seconds empirically.
- Per-batch API response time when not rate limited: ~160-200ms.
- Insert, edit, delete, and move all share the same change budget.

## `/file/edit`: file actions

### Create

```json
{ "action": "create", "type": "document", "parent_id": "...", "title": "...", "index": 0 }
```

- `type`: `"document"` or `"folder"`.
- Empty or omitted title: creates with title "Untitled".
- Duplicate titles: allowed. Multiple files with the same title get separate IDs.
- Creating inside a document ID (not a folder): API rejects (`results: [false]`).

### Edit (rename)

```json
{ "action": "edit", "type": "document", "file_id": "...", "title": "new title" }
```

- Renaming a non-existent file: API silently ignores (`results: [false]`).
- Renaming a read-only shared document: API silently ignores (`results: [false]`).
- Renaming with edit or manage permission: succeeds.

### Move

```json
{ "action": "move", "type": "document", "file_id": "...", "parent_id": "...", "index": 0 }
```

- The `type` field must match the actual file type. Sending `type: "document"` for a
  folder causes a silent failure.
- Moving to a non-existent folder: API silently ignores (`results: [false]`).

### Response shape

```json
{
  "_code": "Ok",
  "results": [true],
  "created": ["new_file_id"]
}
```

- `results`: array of booleans, one per change. `true` = success, `false` = failure.
  Failures are silent (no error code or message per-change).
- `created`: array of new file IDs for create actions. Only present when creates succeed.

### No delete action

The `/file/edit` endpoint does not support a delete action. Files and folders can only
be deleted through the Dynalist web UI.

## `/doc/check_for_updates` response

```json
{
  "versions": { "file_id_1": 33, "file_id_2": 83 }
}
```

- `versions` is an object mapping file IDs to integer version numbers, NOT an array.
- Non-existent or inaccessible document IDs are silently dropped from the response.
- Empty `file_ids` input returns `{"versions": {}}`.

## `/inbox/add`

- Returns `file_id`, `node_id`, `index` of the created inbox item.
- Fails with `NoInbox` error if no inbox location is configured in Dynalist settings.

## Error codes

All API responses use `_code` and `_msg` fields. On success, `_code` is `"Ok"`.

| Code | Meaning |
|------|---------|
| `Ok` | Success. |
| `InvalidToken` | API token is invalid or missing. |
| `TooManyRequests` | Rate limit exceeded. Retry after ~45-50s. |
| `NotFound` | Document or file does not exist. |
| `NodeNotFound` | Node ID does not exist in the document. |
| `Unauthorized` | No permission for this operation (e.g., write on read-only shared doc). |
| `NoInbox` | No inbox location configured in Dynalist settings. |
| `LockFail` | Document locked by another operation. |
| `Invalid` | Malformed request or invalid parameters. |

## Permissions behavior

The API returns numeric permission levels on files:

| Level | Label | Read | Write nodes | Rename file |
|-------|-------|------|-------------|-------------|
| 0 | none | File hidden from `/file/list` | N/A | N/A |
| 1 | read | Yes | No (`Unauthorized` error) | No (silently ignored) |
| 2 | edit | Yes | Yes | Yes |
| 3 | manage | Yes | Yes | Yes |
| 4 | owner | Yes | Yes | Yes |

- Write attempts on read-only documents return `Unauthorized` with the message
  "Unauthorized document access".
- Rename/move on read-only documents: API silently ignores (`results: [false]`). No error.

## Timestamps

- All timestamps (`created`, `modified`) are milliseconds since epoch.
- Both ISO date strings (`"2026-03-12"`) and millisecond integers are accepted as
  query parameters in our MCP tools.

## Root node ID

In all observed API responses, the root node of every document has the literal ID
`"root"`. `findRootNodeId` relies on this: it checks for a node with `id === "root"`
before falling back to the traversal algorithm (first node not referenced as any other
node's child). This avoids misidentifying orphaned nodes as the root when they happen
to appear earlier in the `nodes` array.

## Orphaned nodes

Nodes whose parent has been deleted via the raw API (single-node delete) become orphaned:

- Present in the flat `nodes` array from `/doc/read`.
- Not reachable via any node's `children` array (invisible from root traversal).
- Findable via search (which scans all nodes).
- Readable by direct node ID.
- Persist indefinitely (no server-side garbage collection observed).
- Can be deleted by node ID but cannot be moved back into the tree.

Our `delete_nodes` tool avoids creating orphans by doing recursive deletion (children
before parents). This ordering also makes the operation idempotent on partial failure:
if interrupted mid-batch, surviving nodes remain connected to the tree and can be
re-collected and deleted on retry.
