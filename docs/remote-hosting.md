# Remote hosting on Cloudflare Workers

Deploy your own instance of the server to Cloudflare Workers so you can add it as a custom connector in Claude (web, desktop, and mobile) and ChatGPT. One deployment serves one Dynalist account. Only the GitHub accounts you allowlist can sign in.

The local stdio server keeps working unchanged. Both share the same tools and behavior.

## How it works

One Worker is both the OAuth server and the MCP endpoint (`/mcp`, Streamable HTTP). When you add the connector, your client registers itself, you approve it on a consent page, and you sign in with GitHub. The Worker issues a grant only if your GitHub username is on the allowlist, and it re-checks the allowlist on every MCP request.

Authenticated requests go to a single Durable Object, which keeps batch state and the access control file tree cache in its storage. This keeps `batch_index` writes and caching working across separate tool calls, as they do locally.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up). The free plan is enough to deploy. See [Cloudflare plan](#cloudflare-plan) for the current recommendation.
- A [GitHub account](https://github.com/) to sign in with.
- [Bun](https://bun.sh/) v1.0+.
- Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer).

## Setup

### 1. Install

```bash
git clone https://github.com/JDNdeveloper/dynalist-mcp.git
cd dynalist-mcp
bun install
```

### 2. Log in to Cloudflare

```bash
bunx wrangler login
```

### 3. Run the setup script

```bash
bun run worker-setup
```

The script walks through each step and explains every value it asks for:

1. **Wrangler.** Checks that wrangler runs and is logged in.
2. **Worker.** Asks for the Worker name and your workers.dev subdomain (shown in the Cloudflare dashboard under **Workers & Pages**). Creates the `OAUTH_KV` namespace that stores OAuth state, and writes `wrangler.jsonc` from `wrangler.example.jsonc`. `wrangler.jsonc` holds account-specific values and is gitignored. Then prints your connector URL and GitHub redirect URI.
3. **Secrets.** Prompts for each secret and sets it with `wrangler secret put`:
   - `DYNALIST_API_TOKEN`: verified against Dynalist before it is saved.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: from a GitHub OAuth app. The script prints the exact values to enter when you [create the app](https://github.com/settings/applications/new): the application name, the homepage URL, the **Redirect URI** (`https://<worker>.<subdomain>.workers.dev/callback`), and the other form options.
   - `ALLOWED_GITHUB_USERS`: comma-separated GitHub usernames allowed to sign in, usually just yours. The script echoes the parsed list for confirmation.
   - `DYNALIST_MCP_CONFIG_JSON` (optional): a local config file. The script offers `~/.dynalist-mcp.json` if it exists, or another path, and uploads its contents. The same config works locally and remotely, except `logFile`, which Workers does not support.

The script rejects empty and malformed values and never passes them to wrangler. Hidden prompts echo nothing. Secret values go to wrangler on stdin, so they never appear in the process list, on disk, or in output.

The script is safe to rerun. Each step detects what is already done and offers to keep it, so rerunning it to rotate one secret leaves the rest alone.

### 4. Deploy

```bash
bun run deploy
```

Deploying is needed only for the first setup and for code changes. Setting a secret deploys a new Worker version on its own, so secret and config changes are live as soon as the script sets them. On a new account, the first secret creates a placeholder Worker, which `bun run deploy` replaces with the server.

### 5. Connect a client

Add your connector URL (`https://<worker>.<subdomain>.workers.dev/mcp`) as a custom connector. See [Client setup](client-setup.md#claude-custom-connector) for Claude and ChatGPT steps.

## Updating

- **Code:** pull the latest changes and run `bun run deploy`.
- **Config:** run `bun run worker-config` to validate a local config file and upload only `DYNALIST_MCP_CONFIG_JSON`. Pass the path to skip the prompt, e.g. `bun run worker-config ~/.dynalist-mcp.json`. The change is live immediately.
- **Other secrets:** rerun `bun run worker-setup` and choose "Keep the current value" for each one you are not changing.
- **Renaming your GitHub account:** the allowlist matches usernames, and GitHub lets anyone register a username once it is freed. Before renaming or deleting an allowlisted account, update `ALLOWED_GITHUB_USERS`.
- **Revoking access:** remove the username from `ALLOWED_GITHUB_USERS` with `bun run worker-setup`. Existing grants for that account stop working on their next request.

## Logs

Logs go to Workers Logs, filtered by the `logLevel` config setting. View them in the Cloudflare dashboard, or stream them with:

```bash
bunx wrangler tail
```

Logs never contain the Dynalist token, OAuth tokens, or other secrets.

## Misconfiguration

The Worker validates every secret and binding on the first request. If anything is missing or malformed, including an empty or invalid `ALLOWED_GITHUB_USERS` or an invalid `DYNALIST_MCP_CONFIG_JSON`, every route returns HTTP 503 and clients show "The server is misconfigured." The response never says which value failed, because the URL is public. The Worker log names each failing value and the rule it broke.

## Cloudflare plan

The free plan is enough for personal use. In the rare case a request hits a Cloudflare limit, the client reports that a write may have been partially applied. Check the document in Dynalist before asking it to try again.

## Environment reference

See [Configuration](configuration.md#cloudflare-workers-environment) for every Worker secret and variable.
