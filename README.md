# Dynalist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dynalist.io](https://dynalist.io/), the infinite document outliner.

Claude and other AI assistants can read, write, search, and organize Dynalist documents programmatically.

### Features

- **17 tools** for reading, writing, searching, and organizing documents.
- **Path-based access control** with deny/read/allow policies, glob matching, and ID anchoring.
- **Configurable defaults** for read depth, collapsed nodes, notes, checked items, size warnings, and more.
- **Read-only mode** to prevent all write operations.
- **Structured responses** with both JSON (`structuredContent`) and plain text for backwards compatibility.
- **Native-feeling output** via MCP instructions that guide agents to render outlines, show diff previews before writes, and handle large documents gracefully.
- **Concurrent edit detection** so writes against stale data are caught before or immediately after they happen.
- **Built-in caching** to minimize API calls across repeated reads, access control checks, and config reloads.
- **Thoroughly tested** with an in-memory API mock, race simulation at every write-path window, and weak-model instruction validation using Claude Haiku.

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

### 3. Connect

All paths in the config must be absolute. MCP clients do not expand `~` or `$HOME`. See [docs/client-setup.md](docs/client-setup.md) for troubleshooting and environment isolation details.

#### Claude Code

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

#### Claude Desktop

**Option A: `.mcpb` bundle**

Download the latest `.mcpb` file from the [releases page](https://github.com/JDNdeveloper/dynalist-mcp/releases). Go to **Settings -> Extensions -> Advanced settings -> Install Extension** and select the downloaded file. You will be prompted for your API token during setup.

**Option B: Manual config**

Add the same JSON as above to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

- **Windows**: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

- **Windows (legacy)**: `%APPDATA%\Claude\claude_desktop_config.json`

## Documentation

- [**Tools reference**](docs/tools.md): Parameter tables, response shapes, and examples for all tools. Generated from source schemas.
- [**Configuration**](docs/configuration.md): Config file reference, environment variables, field table, and logging. Generated from source schemas.
- [**Access control**](docs/access-control.md): Path-based ACL rules, glob syntax, specificity precedence, ID anchoring, and examples.
- [**Client setup**](docs/client-setup.md): Troubleshooting, environment isolation, and additional MCP client details.
- [**API coverage**](docs/api-coverage.md): Mapping between Dynalist API endpoints and MCP tools. Generated from source.
- [**Agent UX**](docs/agent-ux.md): How MCP instructions shape agent behavior for rendering, confirmations, size management, and composability.
- [**Concurrency**](docs/concurrency.md): Version guards, position resolution, deletion ordering, cache invalidation, and race simulation testing.
- [**Performance**](docs/performance.md): Document cache, file tree cache, config reloading, rate limit retry, change batching, and node maps.
- [**Testing**](docs/testing.md): Dummy server, race simulation, agent-driven live testing, and weak-model instruction validation.

## Development

```bash
bun run start        # Run the MCP server
bun run typecheck    # Type-check without emitting (run after making changes)
bun test             # Run the full test suite
bun test --watch     # Run tests in watch mode
bun run inspector    # Debug with MCP Inspector
```

**Typecheck is required after making changes** to catch type errors before committing.

### Testing with MCP Inspector

> **Warning:** MCP Inspector and MCP clients (e.g. Claude Code) connect to a live Dynalist account and can modify and delete data. Make sure your `DYNALIST_API_TOKEN` points to a **test account**, not your real one.

```bash
DYNALIST_API_TOKEN=your_token bun run inspector
```

### Project structure

```
src/
├── index.ts                      # Entry point, server identity, instructions
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── document-store.ts             # LRU-cached document reader with version checks
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── version-guard.ts              # Pre/post-write version checks for race detection
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── descriptions.ts           # Shared parameter descriptions and guidance constants
│   ├── node-metadata.ts          # Heading/color string enums and API translation maps
│   ├── read.ts                   # Read tools
│   ├── write.ts                  # Write tools
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools
├── utils/
│   ├── url-parser.ts             # Build Dynalist URLs
│   └── dynalist-helpers.ts       # Shared tool helpers
└── tests/
    └── tools/                    # Tool integration tests against dummy server
```

## Bundling and releasing

The project can be packaged as a `.mcpb` bundle for single-click installation in MCP clients. The bundled server targets Node.js, so end users do not need Bun installed.

```bash
bun run bundle       # Typecheck, test, build dist/index.js, generate manifest, pack .mcpb
bun run release      # Bundle + git tag + GitHub release with .mcpb asset (maintainer only)
```

`bun run release` requires maintainer push access, a clean working tree on the `main` branch, and a version bump in `package.json` (single source of truth for both the package and the generated `manifest.json`).

## Security model

### Transport

This server uses MCP stdio transport: it runs as a local subprocess of the MCP client (e.g. Claude Desktop, Claude Code) and communicates via stdin/stdout. There is no network listener, no HTTP server, no port binding. The server is not accessible from outside the machine or from other processes on the same machine.

### LLM access risks

While the server itself is local-only, the LLM interacting with it has full read/write access to your Dynalist data (subject to access control policy, if configured). The LLM could read sensitive content, modify or delete nodes, or exfiltrate data by including it in responses. Use the access control system and `readOnly` mode to limit exposure.

### Access control limitations

The access control system is best-effort and should not be relied upon as a hard security boundary. Known limitations:

1. **Content leakage**: content within allowed documents may contain links or references to denied documents, exposing their IDs or titles. The ACL system does not scrub content.
2. **Cache staleness**: the file tree cache (default 5 minutes TTL) means external renames/moves may cause rules to match incorrectly until the cache refreshes.
3. **Inbox bypass**: the inbox is always writable regardless of deny rules.

Users who need strict isolation should use separate Dynalist accounts rather than relying solely on ACLs.

### Specificity-wins precedence

Rule precedence is based on path specificity, **not** policy severity. Unlike AWS IAM (where explicit deny always wins), a more-specific `allow` overrides a less-specific `deny`.

For example, if `/Private/**` is `deny` but `/Private/Shopping List` is `allow`, the Shopping List is accessible because the exact match is more specific. Deny rules are not absolute ceilings. They can be overridden by more specific rules underneath them.

Audit your rules so that no more-specific allow/read rules punch holes through broader deny rules.

## Acknowledgments

Originally forked from [cristip73/dynalist-mcp](https://github.com/cristip73/dynalist-mcp).
