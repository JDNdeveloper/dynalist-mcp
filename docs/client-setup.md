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

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.dynalist]
command = "/absolute/path/to/bun"
args = ["/absolute/path/to/dynalist-mcp/src/index.ts"]
env = { DYNALIST_API_TOKEN = "your-api-token" }
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

## Remote connectors

These clients connect to a server you deploy to Cloudflare Workers. Set it up first with [Remote hosting](remote-hosting.md). Your connector URL is `https://<worker>.<subdomain>.workers.dev/mcp`.

### Claude custom connector

Works on Claude web, desktop, and mobile on every plan (Free allows one custom connector). Connectors belong to your Claude account, so one added on the web is available in the other apps.

1. Open **Customize > Connectors** ([claude.ai/customize/connectors](https://claude.ai/customize/connectors)), choose **+ Add**, then **Add custom connector**. On Team and Enterprise, an Owner adds it under **Organization settings > Connectors** (**Add > Custom > Web**) instead, and each member then chooses **Connect** on it under **Customize > Connectors**.
2. Enter a name (e.g. "Dynalist") and your connector URL, then choose **Continue**.
3. Review the detected authentication settings and choose **Continue**. Under **Authentication**, choose **Sign in now**. Under **OAuth client**, keep **Use Claude's published identity (Recommended)**. The Worker also supports **Register automatically**, but not **Use your own OAuth client**. Choose **Add**.
4. On the consent page, check that the app is Claude and that access goes to `claude.ai`, then choose **Allow**.
5. Sign in with an allowlisted GitHub account.
6. In a conversation, enable the connector from the **+** button, under **Connectors**.

If Claude renders Dynalist trees without fenced code blocks or skips previews before writes, add this to your Claude profile preferences or project instructions:

```markdown
Before your first Dynalist tool call in a conversation, call the Dynalist `get_instructions` tool and follow its instructions.
```

### ChatGPT custom MCP server

Custom MCP servers are added from ChatGPT on the web. Write tools need a Business, Enterprise, or Edu plan, and on Business only workspace admins and owners can add the server. Pro allows read tools only. Free does not support custom MCP servers.

1. Open **Plugins** ([chatgpt.com/plugins](https://chatgpt.com/plugins)), choose the plus button, then **Add custom MCP server**.
2. Enter a name. Under **Connection**, enter your connector URL as the **Server URL**.
3. Choose **OAuth** as the authentication method, without static client credentials. ChatGPT then registers itself with the Worker.
4. Review the risk warning, choose **I understand and want to continue**, then **Create as a plugin**.
5. Install the plugin from your personal plugins. On the consent page, check that access goes to `chatgpt.com`, then choose **Allow** and sign in with an allowlisted GitHub account.
6. In a conversation, type `@` and select the plugin.

ChatGPT asks you to confirm every tool call that can modify data. Read-only tools run without confirmation. You can remember an approval for a tool for the rest of a conversation. After updating the server, choose **Refresh** on the plugin's entry in **Plugins** so ChatGPT picks up changed tools.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `command not found: bun` | PATH not inherited | Use absolute path to `bun` in `command` field |
| `DYNALIST_API_TOKEN is required` | Env vars not inherited | Set the token in the `env` field |
| `~` or `$HOME` in paths | No shell expansion | Use absolute paths everywhere |
| Remote connector shows "The server is misconfigured" | A Worker secret or binding is missing or invalid | Check the Worker logs (`bunx wrangler tail`), then rerun `bun run worker-setup` |
| GitHub sign-in shows "not allowed" | The GitHub account is not in `ALLOWED_GITHUB_USERS` | Add it with `bun run worker-setup` |
