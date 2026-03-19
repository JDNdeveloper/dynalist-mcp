# MCP Client Setup

## Environment isolation

MCP clients launch server subprocesses in a minimal environment that does NOT inherit your shell PATH or environment variables. This means `bun`, `node`, and env vars set in `.bashrc`/`.zshrc` will not be available.

Workarounds:
- **`env` field**: set environment variables directly in the MCP config. Values are literal strings (no `$HOME` or `~` expansion).
- **Absolute paths**: use the full path to `bun` in the `command` field (e.g. `/Users/you/.bun/bin/bun`).
- **Wrapper script**: a bash script that sets up PATH and env vars, then exec's the real command. Best when env vars are dynamic.

All paths in MCP config files must be absolute. `~` and `$HOME` are not expanded by any MCP client.

## Claude Desktop

**Option A: `.mcpb` bundle**

Download the latest `.mcpb` file from the [releases page](https://github.com/JDNdeveloper/dynalist-mcp/releases). Go to **Settings > Extensions > Advanced settings > Install Extension** and select the downloaded file. You will be prompted for your API token during setup.

**Option B: Manual config**

Add the Claude Code config snippet (see below) to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (legacy)**: `%APPDATA%\Claude\claude_desktop_config.json`

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

## OpenCode

`~/.config/opencode/opencode.json`:

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

OpenCode does not currently pass MCP instructions to agents (see: [issue #7373](https://github.com/anomalyco/opencode/issues/7373)). Until that is fixed, add the following to your `AGENTS.md` so the agent reads the instructions explicitly at the start of each session:

```markdown
**CRITICAL**: Before your first Dynalist tool call in a session, read `<absolute-path-to>/dynalist-mcp/docs/instructions.md`.
```

Replace `<absolute-path-to>` with the absolute path where you cloned this repo.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `command not found: bun` | PATH not inherited | Use absolute path to `bun` in `command` field |
| `DYNALIST_API_TOKEN is required` | Env vars not inherited | Set the token in the `env` field |
| `~` or `$HOME` in paths | No shell expansion | Use absolute paths everywhere |
