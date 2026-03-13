# Tools Reference

## Read tools

### `list_documents`

List all documents and folders in your Dynalist account. Returns the folder hierarchy so you can understand the organizational structure. Use the returned `file_id` values as parameters for all other tools.

**Parameters**: none.

**Response**:
```json
{
  "root_file_id": "abc123",
  "count": 5,
  "documents": [
    { "file_id": "...", "title": "...", "url": "...", "permission": "owner" }
  ],
  "folders": [
    { "file_id": "...", "title": "...", "children": ["...", "..."] }
  ]
}
```

Documents with a `read` access policy include `"access_policy": "read"`. Same applies to `search_documents` matches.

### `search_documents`

Search for documents and folders by name. Client-side filter on the file tree.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | | Text to search for (case-insensitive) |
| `type` | string | no | `"all"` | Filter: `"document"`, `"folder"`, or `"all"` |

**Response**:
```json
{
  "count": 3,
  "query": "notes",
  "matches": [
    {
      "file_id": "...", "title": "...", "type": "document",
      "url": "...", "permission": "owner"
    }
  ]
}
```

Folders include `children` instead of `url`/`permission`.

### `read_document`

Read a Dynalist document as a structured JSON node tree. Omit `node_id` to read from the document root. Provide `node_id` to zoom into a specific subtree.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | no | root | Node to start reading from |
| `max_depth` | number \| null | no | `5` | Depth limit. 0 = target only, null = unlimited |
| `include_collapsed_children` | boolean | no | `false` | Include children of collapsed nodes |
| `include_notes` | boolean | no | `true` | Include node notes |
| `include_checked` | boolean | no | `true` | Include checked/completed nodes |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "My Document",
  "version": 42,
  "url": "https://dynalist.io/d/...",
  "node": {
    "node_id": "...",
    "content": "Top-level item",
    "collapsed": false,
    "children_count": 2,
    "children": [
      {
        "node_id": "...",
        "content": "Child item",
        "note": "A note on this node",
        "heading": 1,
        "color": 2,
        "collapsed": false,
        "children_count": 0,
        "children": []
      }
    ]
  }
}
```

**Controlling output size:**
- Response too large? Lower `max_depth` or rely on collapsed node filtering.
- See `depth_limited: true`? Call `read_document` with that node's `node_id` to zoom in.
- See `collapsed: true` with hidden children? Pass the node's `node_id` to zoom in (the starting node always expands), or set `include_collapsed_children: true` to expand all collapsed nodes.
- Need everything? Set `max_depth: null` and `include_collapsed_children: true`.
- The starting node (the `node_id` you pass, or the document root) always shows its children regardless of collapsed state, matching the Dynalist UI zoom behavior.

**Node properties:**
- `checked`, `checkbox`: only present when the node has a checkbox. Omitted for plain nodes.
- `heading`: 0 = none, 1 = H1, 2 = H2, 3 = H3. Omitted when 0.
- `color`: 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple. Omitted when 0.
- `note`: omitted when empty (not present in JSON, saves tokens).
- `depth_limited`: true when the depth limit caused children to be hidden.
- `children_count`: always present, shows total direct children regardless of visibility.
- `version`: document version number. Pass this as `expected_version` to write tools to detect concurrent edits.

### `search_in_document`

Search for text in a document. Use `parent_levels` to include ancestor breadcrumbs, the most efficient way to understand where matches live in the hierarchy without a separate `read_document` call.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `query` | string | yes | | Text to search for (case-insensitive) |
| `search_notes` | boolean | no | `true` | Also search in notes |
| `parent_levels` | number | no | `1` | How many parent levels to include (0 = none) |
| `include_children` | boolean | no | `false` | Include direct children of each match |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "...",
  "url": "...",
  "count": 5,
  "query": "search term",
  "matches": [
    {
      "node_id": "...",
      "content": "...",
      "url": "...",
      "collapsed": false,
      "parents": [{ "node_id": "...", "content": "..." }],
      "children": [{ "node_id": "...", "content": "..." }]
    }
  ]
}
```

`checked`, `checkbox`, `heading`, and `color` follow the same conditional inclusion rules as `read_document` (omitted at default values). `parents` is present only when `parent_levels > 0` and ancestors exist. `children` is present only when `include_children: true` and the node has children.

### `get_recent_changes`

Get nodes created or modified within a time period. Timestamps are milliseconds since epoch. Date-only strings like `"2025-03-11"` are treated as start-of-day for `since` and end-of-day for `until`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `since` | string \| number | yes | | Start date (ISO string or ms timestamp) |
| `until` | string \| number | no | now | End date |
| `type` | string | no | `"both"` | `"created"`, `"modified"`, or `"both"` |
| `parent_levels` | number | no | `1` | Parent context levels (0 = none) |
| `sort` | string | no | `"newest_first"` | `"newest_first"` or `"oldest_first"` |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "...",
  "url": "...",
  "count": 3,
  "matches": [
    {
      "node_id": "...",
      "content": "...",
      "url": "...",
      "change_type": "created",
      "created": 1710000000000,
      "modified": 1710000000000,
      "collapsed": false,
      "parents": [{ "node_id": "...", "content": "..." }]
    }
  ]
}
```

`checked`, `checkbox`, `heading`, and `color` follow the same conditional inclusion rules as `read_document` (omitted at default values). `parents` is present only when `parent_levels > 0` and ancestors exist.

### `check_document_versions`

Check version numbers for documents without fetching content. Useful for detecting changes before expensive reads. The version number increases on every edit.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_ids` | string[] | yes | | Array of document file IDs to check |

**Response**:
```json
{
  "versions": { "file_id_1": 42, "file_id_2": 17, "file_id_3": -1 }
}
```

A version of `-1` means the document was not found or access was denied.

## Write tools

### `send_to_inbox`

Send a single item to your Dynalist inbox. The target document is the user's configured inbox and cannot be changed via this tool. For inserting into a specific document or inserting hierarchical content, use `insert_nodes`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | | Text content for the inbox item |
| `note` | string | no | | Note for the item |
| `checkbox` | boolean | no | config | Whether to add a checkbox |

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "url": "..."
}
```

### `edit_nodes`

Edit one or more existing nodes. Only specified fields are updated per node. Omitted fields are left unchanged (not reset to defaults). For a single node, pass a one-element array.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `nodes` | array | yes | | Array of node edit objects (see below) |
| `expected_version` | number | yes | | Document version from `read_document`. Aborts if stale. |

**Node edit object fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `node_id` | string | yes | Node ID to edit |
| `content` | string | no | New content text |
| `note` | string | no | New note text. Set to `""` to clear. Supports multiline. |
| `checked` | boolean | no | Checked state |
| `checkbox` | boolean | no | Whether to show checkbox |
| `heading` | number | no | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple |

Example input:
```json
{
  "file_id": "abc123",
  "expected_version": 42,
  "nodes": [
    { "node_id": "node1", "content": "Updated text", "color": 3 },
    { "node_id": "node2", "checked": true }
  ]
}
```

**Response**:
```json
{
  "file_id": "...",
  "edited_count": 2,
  "node_ids": ["node1", "node2"],
  "version_warning": "..."
}
```

`version_warning` is present only when a concurrent edit was detected during the write.

### `insert_nodes`

Insert one or more nodes into a Dynalist document as a JSON tree. Supports nested hierarchy and per-node fields (note, checkbox, checked, heading, color). For a single node, pass a one-element array.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | no | root | Parent node ID. Inferred from `reference_node_id` when using `after`/`before`. |
| `nodes` | array | yes | | Array of node objects (see below) |
| `position` | string | no | `"as_last_child"` | `"as_first_child"`, `"as_last_child"`, `"after"`, or `"before"` |
| `index` | number | no | | Exact child index for root-level nodes. Overrides `position`. 0 = first, -1 = last. Cannot be combined with `reference_node_id`. |
| `reference_node_id` | string | no | | Sibling node to insert relative to. Required when position is `"after"` or `"before"`. Cannot be combined with `"as_first_child"`/`"as_last_child"` or `index`. |
| `expected_version` | number | yes | | Document version from `read_document`. Aborts if stale. |

**Node object fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Content text. Supports multiline. |
| `note` | string | no | Note text. Supports multiline. |
| `checkbox` | boolean | no | Whether to show a checkbox |
| `checked` | boolean | no | Checked (completed) state |
| `heading` | number | no | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple |
| `children` | array | no | Nested child node objects (same shape, recursive) |

Example input:
```json
{
  "file_id": "abc123",
  "expected_version": 42,
  "nodes": [
    {
      "content": "Top level item",
      "children": [
        { "content": "Child item", "note": "A note on this child" },
        { "content": "Another child", "checkbox": true }
      ]
    },
    { "content": "Second top level item", "heading": 1 }
  ]
}
```

**Response**:
```json
{
  "file_id": "...",
  "total_created": 4,
  "root_node_ids": ["...", "..."],
  "url": "...",
  "version_warning": "..."
}
```

`version_warning` is present only when a concurrent edit was detected during the write.

## Structure tools

### `delete_nodes`

Delete one or more nodes from a document. By default, each node and its entire subtree are deleted. For a single deletion, pass a one-element array. If two nodes in the array overlap (one is an ancestor of the other), the descendant is automatically deduplicated.

`include_children: false` is a **niche option** that promotes (unwraps) a single node's children up to its parent instead of deleting them. This is only supported when deleting a single node (`node_ids` must have exactly one element). The vast majority of deletions should use the default. Only use `include_children: false` when the user explicitly wants to remove a grouping node (e.g. a section header) while keeping its items.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_ids` | string[] | yes | | Node IDs to delete. For a single deletion, pass a one-element array. |
| `include_children` | boolean | no | `true` | Delete entire subtree if true; promote children if false (single node only) |
| `expected_version` | number | yes | | Document version from `read_document`. Aborts if stale. |

**Response**:
```json
{
  "file_id": "...",
  "deleted_count": 5,
  "promoted_children": 3,
  "version_warning": "..."
}
```

`promoted_children` is present only when children were promoted (`include_children: false`). `version_warning` is present only when a concurrent edit was detected during the write.

### `move_nodes`

Move one or more nodes (and their subtrees) to new positions within a document. Moves are applied sequentially, so later moves can reference positions created by earlier moves. For a single move, pass a one-element array.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `moves` | array | yes | | Array of move objects (see below) |
| `expected_version` | number | yes | | Document version from `read_document`. Aborts if stale. |

**Move object fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `node_id` | string | yes | Node to move (its entire subtree moves with it) |
| `reference_node_id` | string | yes | Reference node for positioning |
| `position` | string | yes | `"after"`, `"before"`, `"first_child"`, `"last_child"` |

**Position values:**
- `after`: immediately after the reference (same parent).
- `before`: immediately before the reference (same parent).
- `first_child`: as first child inside the reference.
- `last_child`: as last child inside the reference.

Example input:
```json
{
  "file_id": "abc123",
  "expected_version": 42,
  "moves": [
    { "node_id": "node1", "reference_node_id": "node3", "position": "after" },
    { "node_id": "node2", "reference_node_id": "node1", "position": "after" }
  ]
}
```

**Response**:
```json
{
  "file_id": "...",
  "moved_count": 2,
  "node_ids": ["node1", "node2"],
  "version_warning": "..."
}
```

`version_warning` is present only when a concurrent edit was detected during the write.

## File management tools

### `create_document`

Create a new empty document in a folder. Use `insert_nodes` to add content afterward.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `parent_folder_id` | string | yes | | Folder file ID |
| `title` | string | no | `""` | Document title |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "title": "...", "url": "..." }`

### `create_folder`

Create a new empty folder inside another folder.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `parent_folder_id` | string | yes | | Parent folder file ID |
| `title` | string | no | `""` | Folder title |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "title": "..." }`

### `rename_document`

Rename a document. The `file_id` does not change.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `title` | string | yes | | New title |

**Response**: `{ "file_id": "...", "title": "..." }`

### `rename_folder`

Rename a folder. The `file_id` does not change.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Folder file ID |
| `title` | string | yes | | New title |

**Response**: `{ "file_id": "...", "title": "..." }`

### `move_document`

Move a document to a different parent folder, or reorder it within its current folder by passing the same parent_folder_id with a new index. Returns an error if the file_id refers to a folder.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID to move |
| `parent_folder_id` | string | yes | | Destination folder file ID |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "parent_folder_id": "..." }`

### `move_folder`

Move a folder to a different parent folder, or reorder it within its current folder by passing the same parent_folder_id with a new index. All contents (documents and subfolders) move with it. Returns an error if the file_id refers to a document.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Folder file ID to move |
| `parent_folder_id` | string | yes | | Destination folder file ID |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "parent_folder_id": "..." }`
