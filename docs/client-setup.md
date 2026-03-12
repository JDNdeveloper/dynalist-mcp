# MCP Client Setup

## Environment isolation

MCP clients launch server subprocesses in a minimal environment that does NOT inherit your shell PATH or environment variables. This means `bun`, `node`, and env vars set in `.bashrc`/`.zshrc` will not be available.

Workarounds:
- **`env` field**: set environment variables directly in the MCP config. Values are literal strings (no `$HOME` or `~` expansion).
- **Absolute paths**: use the full path to `bun` in the `command` field (e.g. `/Users/you/.bun/bin/bun`).
- **Wrapper script**: a bash script that sets up PATH and env vars, then exec's the real command. Best when env vars are dynamic.

All paths in MCP config files must be absolute. `~` and `$HOME` are not expanded by any MCP client.

## Claude Desktop

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

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

## Claude Code

`.mcp.json` in the project root or `~/.claude.json` globally:

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

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `command not found: bun` | PATH not inherited | Use absolute path to `bun` in `command` field |
| `DYNALIST_API_TOKEN is required` | Env vars not inherited | Set the token in the `env` field |
| `~` or `$HOME` in paths | No shell expansion | Use absolute paths everywhere |
