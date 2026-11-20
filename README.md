# Dynalist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dynalist.io](https://dynalist.io/), the infinite document outliner.

Claude and other AI assistants can read, write, search, and organize Dynalist documents programmatically.

### Features

- **19 tools** for reading, writing, searching, and organizing documents.
- **Path-based access control** with deny/read/allow policies, glob matching, and ID anchoring.
- **Configurable defaults** for read depth, collapsed items, notes, checked items, size warnings, and more.
- **Structured responses** with JSON (`structuredContent`) on success and plain text on errors, for broad client compatibility.
- **Native-feeling output** via MCP instructions that guide agents to render outlines, show diff previews before writes, and handle large documents gracefully.
- **Concurrent edit detection** so writes against stale data are caught before or immediately after they happen.
- **Built-in caching** to minimize API calls across repeated reads, access control checks, and config reloads.
- **Thoroughly tested** with an in-memory API mock, race simulation at every write-path window, and weak-model instruction validation using Claude Haiku.

For Dynalist API documentation, see [apidocs.dynalist.io](https://apidocs.dynalist.io/).

## Getting started

These steps run the server locally. To host it on Cloudflare Workers for Claude web or ChatGPT, see [Remote hosting](docs/remote-hosting.md) instead.

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

#### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.dynalist]
command = "/absolute/path/to/bun"
args = ["/absolute/path/to/dynalist-mcp/src/index.ts"]
env = { DYNALIST_API_TOKEN = "your-api-token" }
```

#### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "dynalist": {
      "type": "local",
      "command": ["/absolute/path/to/bun", "/absolute/path/to/dynalist-mcp/src/index.ts"],
      "env": {
        "DYNALIST_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

#### Claude Desktop

**Option A: `.mcpb` bundle**

Download the latest `.mcpb` file from the [releases page](https://github.com/JDNdeveloper/dynalist-mcp/releases). Go to **Settings > Extensions > Advanced settings > Install Extension** and select the downloaded file. You will be prompted for your API token during setup.

**Option B: Manual config**

Add the same JSON as the Claude Code config snippet to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

- **Windows**: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

- **Windows (legacy)**: `%APPDATA%\Claude\claude_desktop_config.json`

## Tips

### Agent skills

You can create "skills" in Dynalist: items containing step-by-step instructions for how an agent can accomplish a task. You can then ask your agent to, for example, "follow my dynalist skill for weekly review".

To use this, add a Dynalist URL pointing to your skills item or document in your agent instructions file (e.g. `CLAUDE.md`, `AGENTS.md`, or Claude Desktop system prompt):

```markdown
Dynalist skills: https://dynalist.io/d/...
```

Examples:

- "Follow my dynalist skill for weekly review"
- "Run my dynalist skill to plan the sprint"

### Copying item links quickly

When directing your agent to a specific Dynalist item (e.g. "handle this item: https://..."), you need the item's URL. The fastest way to get it is to bind a keyboard shortcut to **Copy current item link** in **Settings > Keymap**. With that bound, a single keystroke copies the deep link to your clipboard, ready to paste directly into your agent harness.

## Documentation

- [**Tools reference**](docs/tools.md): Parameter tables, response shapes, and examples for all tools.
- [**Configuration**](docs/configuration.md): Config file reference, environment variables, field table, and logging.
- [**Access control**](docs/access-control.md): Path-based ACL rules, glob syntax, specificity precedence, ID anchoring, and examples.
- [**Client setup**](docs/client-setup.md): Troubleshooting, environment isolation, remote connectors, and additional MCP client details.
- [**Remote hosting**](docs/remote-hosting.md): Deploying to Cloudflare Workers with GitHub sign-in.
- [**API coverage**](docs/api-coverage.md): Mapping between Dynalist API endpoints and MCP tools.
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
bun run test:worker  # Run the Worker tests in the Workers runtime
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
├── index.ts                      # Stdio entry point
├── server.ts                     # Shared MCP server factory (identity, instructions, tools)
├── config.ts                     # Zod-validated config core with pluggable loaders
├── config-file.ts                # Config file loader with mtime-based reloading
├── persistent-store.ts           # State that must survive across requests (batch state, file tree cache)
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── document-store.ts             # LRU-cached document reader with version checks
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── sync-token.ts                 # Opaque sync token generation (sha256-based)
├── version-guard.ts              # Pre/post-write version checks for race detection
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── descriptions.ts           # Shared parameter descriptions and guidance constants
│   ├── node-metadata.ts          # Heading/color string enums and API translation maps
│   ├── meta.ts                   # Meta tools (get_instructions)
│   ├── read.ts                   # Read tools
│   ├── write.ts                  # Write tools
│   ├── structure.ts              # Structure tools (delete, move, reorder)
│   └── files.ts                  # File management tools
├── utils/
│   └── dynalist-helpers.ts       # Shared tool helpers
├── worker/
│   ├── index.ts                  # Cloudflare Worker entry point
│   ├── app.ts                    # OAuth provider wiring, allowlist re-check, Durable Object forwarding
│   ├── github-handler.ts         # Consent page and GitHub sign-in
│   ├── mcp-durable-object.ts     # Durable Object that serves MCP requests
│   └── env-validation.ts         # Secret and binding validators (shared with the setup script)
└── tests/
    ├── tools/                    # Tool integration tests against dummy server
    └── worker/                   # Worker tests and HTTP parity harness (Workers runtime)
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

**Local (stdio):** the server runs as a local subprocess of the MCP client (e.g. Claude Desktop, Claude Code) and communicates via stdin/stdout. In this mode there is no network listener, no HTTP server, no port binding. The server is not accessible from outside the machine or from other processes on the same machine.

**Remote (Cloudflare Workers):** the server is reachable at a public URL, so anyone on the internet can send it requests. It protects them as follows:

- **OAuth 2.1 with GitHub sign-in.** Every MCP request needs an access token. Tokens are issued only after GitHub sign-in, and only to the usernames in `ALLOWED_GITHUB_USERS`. The allowlist is re-checked on every request, so removing a username revokes its existing grants.
- **Consent page.** Any client can register itself, so every authorization shows a consent page naming the client and where access is sent. This stops a link from silently authorizing someone else's client against your GitHub session. The page cannot be framed or forged.
- **Worker secrets.** The Dynalist token and GitHub client secret live in Worker secrets, never in the repo or in responses. Grants store only your GitHub username. The GitHub access token is discarded after sign-in.
- **Fail closed.** If any secret or binding is missing or invalid, including an empty allowlist, every route returns 503.

### LLM access risks

Whether local or remote, the LLM interacting with the server has full read/write access to your Dynalist data (subject to access control policy, if configured). The LLM could read sensitive content, modify or delete items, or exfiltrate data by including it in responses. Use the access control system to limit exposure.

To enforce global read-only mode (all reads allowed, all writes blocked):

```json
{
  "access": {
    "default": "read"
  }
}
```

See [docs/access-control.md](docs/access-control.md) for more granular options.

### Access control limitations

The access control system is best-effort and should not be relied upon as a hard security boundary. Known limitations:

1. **Content leakage**: content within allowed documents may contain links or references to denied documents, exposing their IDs or titles. The ACL system does not scrub content.
2. **Cache staleness**: the file tree cache (default 5 minutes TTL) means external renames/moves may cause rules to match incorrectly until the cache refreshes.
3. **Inbox bypass**: the `send_to_inbox` tool cannot check per-document access because the inbox file ID is unknown until after sending. It is blocked when the global access policy is not writable, but narrower deny rules cannot prevent inbox writes.

Users who need strict isolation should use separate Dynalist accounts rather than relying solely on ACLs.

### Specificity-wins precedence

Rule precedence is based on path specificity, **not** policy severity. Unlike AWS IAM (where explicit deny always wins), a more-specific `allow` overrides a less-specific `deny`.

For example, if `/Private/**` is `deny` but `/Private/Shopping List` is `allow`, the Shopping List is accessible because the exact match is more specific. Deny rules are not absolute ceilings. They can be overridden by more specific rules underneath them.

Audit your rules so that no more-specific allow/read rules punch holes through broader deny rules.

## Acknowledgments

Originally forked from [cristip73/dynalist-mcp](https://github.com/cristip73/dynalist-mcp).
