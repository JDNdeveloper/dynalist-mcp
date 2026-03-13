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
- See `collapsed: true` with hidden children? Set `include_collapsed_children: true`.
- Need everything? Set `max_depth: null` and `include_collapsed_children: true`.

**Node properties:**
- `checked`, `checkbox`: only present when the node has a checkbox. Omitted for plain nodes.
- `heading`: 0 = none, 1 = H1, 2 = H2, 3 = H3. Omitted when 0.
- `color`: 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple. Omitted when 0.
- `note`: omitted when empty (not present in JSON, saves tokens).
- `depth_limited`: true when the depth limit caused children to be hidden.
- `children_count`: always present, shows total direct children regardless of visibility.

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
  "versions": { "file_id_1": 42, "file_id_2": 17 },
  "denied": ["file_id_3"]
}
```

A version of `-1` means the document was not found. `denied` lists file IDs rejected by access control (IDs only, no metadata leaked).

## Write tools

### `send_to_inbox`

Send items to your Dynalist inbox. The target document is the user's configured inbox and cannot be changed via this tool. For inserting into a specific document, use `insert_node` or `insert_nodes`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | | Text content (single line or indented markdown with `- bullets`) |
| `note` | string | no | | Note for the first/root item |
| `checkbox` | boolean | no | config | Whether to add checkboxes |

**Response**:
```json
{
  "file_id": "...",
  "first_node_id": "...",
  "url": "...",
  "total_created": 5
}
```

### `edit_node`

Edit an existing node. Only specified fields are updated. Omitted fields are left unchanged (not reset to defaults). This is a partial update.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node ID to edit |
| `content` | string | no | | New content text |
| `note` | string | no | | New note text. Set to `""` to clear. Supports multiline. |
| `checked` | boolean | no | | Checked state |
| `checkbox` | boolean | no | | Whether to show checkbox |
| `heading` | number | no | | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | | 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple |

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "url": "..."
}
```

### `insert_node`

Insert a single new node. For inserting multiple nodes with hierarchy, use `insert_nodes` instead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `parent_id` | string | yes | | Parent node ID |
| `content` | string | yes | | Content text |
| `note` | string | no | | Note text |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |
| `checkbox` | boolean | no | `false` | Add a checkbox |
| `heading` | number | no | | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | | 0-6 (see `edit_node` color values) |
| `checked` | boolean | no | | Checked state. Automatically enables checkbox. |

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "parent_id": "...",
  "url": "..."
}
```

### `insert_nodes`

Insert multiple nodes from indented text, preserving hierarchy. Preferred over calling `insert_node` in a loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | no | root | Parent node ID |
| `content` | string | yes | | Indented text with `- bullets` or plain indented text |
| `position` | string | no | `"as_last_child"` | `"as_first_child"` or `"as_last_child"` |

Example input:
```
- Top level item
  - Child item
    - Grandchild
- Another top level item
```

**Response**:
```json
{
  "file_id": "...",
  "total_created": 12,
  "root_node_ids": ["...", "...", "..."],
  "url": "..."
}
```

## Structure tools

### `delete_node`

Delete a node from a document. By default, the node and its entire subtree are deleted. Set `include_children: false` to promote children up to the deleted node's parent instead (the node is removed but its children survive in place).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node ID to delete |
| `include_children` | boolean | no | `true` | Delete entire subtree if true; promote children if false |

**Response**:
```json
{
  "file_id": "...",
  "deleted_count": 5,
  "promoted_children": 3
}
```

`promoted_children` is present only when children were promoted (i.e. `include_children` was set to false and the node had children).

### `move_node`

Move a node and its entire subtree to a new position relative to a reference node.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node to move |
| `reference_node_id` | string | yes | | Reference node for positioning |
| `position` | string | yes | | `"after"`, `"before"`, `"first_child"`, `"last_child"` |

**Position values:**
- `after`: immediately after the reference (same parent).
- `before`: immediately before the reference (same parent).
- `first_child`: as first child inside the reference.
- `last_child`: as last child inside the reference.

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "url": "..."
}
```

## File management tools

### `create_document`

Create a new empty document in a folder. Use `insert_node` or `insert_nodes` to add content afterward.

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

### `move_file`

Move a document or folder to a different parent folder. If moving a folder, all its contents move with it.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | File ID to move |
| `parent_folder_id` | string | yes | | Destination folder file ID |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "parent_folder_id": "..." }`
