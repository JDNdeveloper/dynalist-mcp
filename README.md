# Dynalist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dynalist.io](https://dynalist.io/) -- the infinite document outliner.

Enables Claude and other AI assistants to read, write, search, and organize Dynalist documents programmatically via 17 MCP tools.

For Dynalist API documentation, see [apidocs.dynalist.io](https://apidocs.dynalist.io/).

## Getting started

### 1. Install

```bash
git clone https://github.com/JDNdeveloper/dynalist-mcp.git
cd dynalist-mcp
bun install
```

Requires [Bun](https://bun.sh/) v1.0+.

### 2. Get your API token

Visit [dynalist.io/developer](https://dynalist.io/developer) and generate an API token.

### 3. Connect to Claude Code

Add to `.mcp.json` in your project root (or `~/.claude.json` globally):

```json
{
  "mcpServers": {
    "dynalist": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/dynalist-mcp/src/index.ts"],
      "env": {
        "DYNALIST_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### 3 (alt). Connect to Claude Desktop

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Use the same JSON format as above.

**Important:** All paths must be absolute. MCP clients do not expand `~` or `$HOME`. See [docs/client-setup.md](docs/client-setup.md) for troubleshooting and environment isolation details.

## Security model

### Transport

This server uses MCP stdio transport: it runs as a local subprocess of the MCP client (e.g. Claude Desktop, Claude Code) and communicates via stdin/stdout. There is no network listener, no HTTP server, no port binding. The server is not accessible from outside the machine or from other processes on the same machine.

### LLM access risks

While the server itself is local-only, the LLM interacting with it has full read/write access to your Dynalist data (subject to access control policy, if configured). This means the LLM could potentially read sensitive content, modify or delete nodes, or exfiltrate data by including it in responses. Use the access control system and `readOnly` mode to limit exposure.

### Access control limitations

The access control system is best-effort and should not be relied upon as a hard security boundary. Known limitations:

1. **Content leakage**: content within allowed documents may contain links or references to denied documents, exposing their IDs or titles. The ACL system does not scrub content.
2. **Cache staleness**: the file tree cache (default 5 minutes TTL) means external renames/moves may cause rules to match incorrectly until the cache refreshes.
3. **Inbox bypass**: the inbox is always writable regardless of deny rules.

Users who need strict isolation should use separate Dynalist accounts rather than relying solely on ACLs.

### Specificity-wins precedence

Rule precedence is based on path specificity, **not** policy severity. Unlike AWS IAM (where explicit deny always wins), a more-specific `allow` overrides a less-specific `deny`.

For example, if `/Private/**` is `deny` but `/Private/Shopping List` is `allow`, the Shopping List is accessible because the exact match is more specific. Deny rules are not absolute ceilings -- they can be overridden by more specific rules underneath them.

Audit your rules to ensure no more-specific allow/read rules punch holes through broader deny rules.

## Configuration

See [docs/configuration.md](docs/configuration.md) for the full config file reference, environment variables, field table, and logging options.

Quick start: set `DYNALIST_API_TOKEN` to your token from [dynalist.io/developer](https://dynalist.io/developer). Optionally create `~/.dynalist-mcp.json` for access control rules, read defaults, and other settings.

## Access control

See [docs/access-control.md](docs/access-control.md) for path-based ACL rules, glob syntax, specificity precedence, ID anchoring, and examples.

## MCP client integration

See [docs/client-setup.md](docs/client-setup.md) for Claude Desktop, Claude Code, and general MCP client configuration.

## Tools reference

See [docs/tools.md](docs/tools.md) for full parameter tables, response shapes, and usage notes for all 17 tools.

**Read tools:** `list_documents`, `search_documents`, `read_document`, `search_in_document`, `get_recent_changes`, `check_document_versions`

**Write tools:** `send_to_inbox`, `edit_node`, `insert_node`, `insert_nodes`

**Structure tools:** `delete_node`, `move_node`

**File management tools:** `create_document`, `create_folder`, `rename_document`, `rename_folder`, `move_file`

## Dynalist API coverage

See [docs/api-coverage.md](docs/api-coverage.md) for the full mapping between Dynalist API endpoints and MCP tools.

## Development

```bash
bun run start        # Run the MCP server
bun run typecheck    # Type-check without emitting (run after making changes)
bun test             # Run the full test suite
bun test --watch     # Run tests in watch mode
bun run inspector    # Debug with MCP Inspector
```

**Typecheck is required after making changes** to ensure no type errors are introduced.

### Testing with MCP Inspector

```bash
DYNALIST_API_TOKEN=your_token bun run inspector
```

### Project structure

```
src/
├── index.ts                      # Entry point, server identity, instructions
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── read.ts                   # Read tools
│   ├── write.ts                  # Write tools
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools
├── utils/
│   ├── url-parser.ts             # Build Dynalist URLs
│   ├── markdown-parser.ts        # Parse indented text into trees
│   └── dynalist-helpers.ts       # Shared tool helpers
└── tests/
    └── tools/                    # Tool integration tests against dummy server
```

## Acknowledgments

Originally forked from [cristip73/dynalist-mcp](https://github.com/cristip73/dynalist-mcp).
