# Dynalist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dynalist.io](https://dynalist.io/) - the infinite document outliner.

Enables Claude and other AI assistants to read, write, and manipulate Dynalist documents programmatically.

## Features

### Read Operations
- **list_documents** - List all documents and folders in your account
- **search_documents** - Search documents/folders by name (returns ID, URL, type)
- **read_node_as_markdown** - Extract bullet points as Markdown (supports deep links, depth limits, notes)
- **search_in_document** - Search content within a document (returns parents + optional children)

### Write Operations
- **send_to_inbox** - Add items to your Dynalist inbox (supports hierarchical markdown)
- **edit_node** - Modify existing nodes (content, note, checkbox, heading, color)
- **insert_node** - Insert a single new node
- **insert_nodes_from_markdown** - Bulk import from indented markdown/bullet lists

### Structure Operations
- **delete_node** - Remove a node (optionally with all children)
- **move_node** - Move node with explicit parent/index
- **move_node_relative** - Move node + subtree relative to another node (after/before/as_child)

## Setup

### 1. Get your Dynalist API Token

Visit https://dynalist.io/developer and generate an API token.

### 2. Install dependencies

```bash
npm install
npm run build
```

### 3. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dynalist": {
      "command": "node",
      "args": ["/FULL/PATH/TO/dynalist-mcp/dist/index.js"],
      "env": {
        "DYNALIST_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Usage Examples

### Extract bullets from a deep link

```
read_node_as_markdown with url: "https://dynalist.io/d/abc123#z=xyz789"
```

Returns Markdown preserving hierarchy:
```markdown
- Parent item
    - Child item
        - Grandchild with checkbox [x]
    - Another child
```

### Bulk insert from markdown

```
insert_nodes_from_markdown with:
  file_id: "abc123"
  parent_node_id: "xyz789"
  markdown: "- Item 1\n    - Sub-item\n- Item 2"
```

### Search in document

```
search_in_document with:
  file_id: "abc123"
  query: "meeting notes"
```

### Add to inbox

```
send_to_inbox with content: "Remember to review the PR"
```

## Development

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run inspector  # Test with MCP Inspector
```

### Testing with MCP Inspector

```bash
DYNALIST_API_TOKEN=your_token npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
