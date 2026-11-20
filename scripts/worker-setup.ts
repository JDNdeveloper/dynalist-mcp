/**
 * Guided setup for deploying dynalist-mcp to Cloudflare Workers.
 * Run with: bun run worker-setup
 *
 * `bun run worker-config [path]` runs only the config step: it validates
 * a local config file and uploads it as DYNALIST_MCP_CONFIG_JSON. With a
 * path it does not prompt.
 *
 * Every step detects completed state and offers to skip, so rerunning
 * the script to rotate one secret is safe. Secret values go to wrangler
 * on stdin only: they never appear in argv, on disk, or in output.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline/promises";
import {
  parseAllowedGithubUsers,
  validateConfigJson,
  validateDynalistApiToken,
  validateGithubClientId,
  validateGithubClientSecret,
  type ValidationResult,
} from "../src/worker/env-validation";

const REPO_ROOT = resolve(import.meta.dir, "..");
const TEMPLATE_PATH = join(REPO_ROOT, "wrangler.example.jsonc");
const CONFIG_PATH = join(REPO_ROOT, "wrangler.jsonc");
const DYNALIST_FILE_LIST_URL = "https://dynalist.io/api/v1/file/list";

// Cloudflare Worker names and workers.dev subdomains: lowercase letters,
// digits, and hyphens, not starting or ending with a hyphen.
const CLOUDFLARE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ─── Output ──────────────────────────────────────────────────────────

function heading(text: string): void {
  console.log(`\n== ${text} ==\n`);
}

function fatal(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

// ─── Prompts ─────────────────────────────────────────────────────────

/**
 * Prompt for a visible line of input with readline editing. Surrounding
 * whitespace is trimmed.
 */
async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompt for input in raw mode, echoing nothing. Surrounding whitespace
 * is trimmed.
 */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) fatal("Hidden prompts need an interactive terminal.");
  process.stdout.write(question);
  return new Promise((resolvePromise) => {
    let value = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolvePromise(value.trim());
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  for (;;) {
    const answer = (await promptLine(question + suffix)).toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

// ─── Wrangler ────────────────────────────────────────────────────────

interface WranglerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a wrangler command. `stdin` carries secret values so they never
 * appear in argv.
 */
async function wrangler(args: string[], stdin?: string): Promise<WranglerResult> {
  const proc = Bun.spawn(["bunx", "wrangler", ...args], {
    cwd: REPO_ROOT,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ─── Steps ───────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
  heading("1. Preflight");
  const version = await wrangler(["--version"]);
  if (version.exitCode !== 0) {
    fatal("wrangler did not run. Install dependencies with `bun install`, then rerun this script.");
  }
  console.log(`wrangler ${version.stdout.trim()}`);

  const whoami = await wrangler(["whoami"]);
  const output = whoami.stdout + whoami.stderr;
  if (whoami.exitCode !== 0 || /not authenticated/i.test(output)) {
    fatal("wrangler is not logged in. Run `bunx wrangler login`, then rerun this script.");
  }
  console.log("wrangler is logged in.");
}

interface WorkerUrls {
  workerName: string;
  mcpUrl: string;
  callbackUrl: string;
}

async function promptCloudflareName(question: string, fallback: string | undefined): Promise<string> {
  for (;;) {
    const hint = fallback ? ` [${fallback}]` : "";
    const value = (await promptLine(`${question}${hint}: `)) || fallback || "";
    if (CLOUDFLARE_NAME_PATTERN.test(value)) return value;
    console.log("Use lowercase letters, digits, and hyphens, not starting or ending with a hyphen.");
  }
}

/**
 * Read the worker name and MCP URL from an existing wrangler.jsonc, to
 * offer them as defaults on reruns.
 */
function readExistingConfig(): { workerName?: string; subdomain?: string } {
  if (!existsSync(CONFIG_PATH)) return {};
  const text = readFileSync(CONFIG_PATH, "utf-8");
  const workerName = /"name":\s*"([^"]+)"/.exec(text)?.[1];
  const subdomain = /"MCP_RESOURCE":\s*"https:\/\/[^.]+\.([^.]+)\.workers\.dev\/mcp"/.exec(text)?.[1];
  return { workerName, subdomain };
}

async function chooseWorkerUrls(): Promise<WorkerUrls> {
  heading("2. Worker URL");
  console.log("Your Worker is served at https://<worker name>.<workers.dev subdomain>.workers.dev.");
  console.log("Find your workers.dev subdomain in the Cloudflare dashboard under Workers & Pages.\n");
  const existing = readExistingConfig();
  const workerName = await promptCloudflareName("Worker name", existing.workerName ?? "dynalist-mcp");
  const subdomain = await promptCloudflareName("workers.dev subdomain", existing.subdomain);
  const origin = `https://${workerName}.${subdomain}.workers.dev`;
  const urls = { workerName, mcpUrl: `${origin}/mcp`, callbackUrl: `${origin}/callback` };
  console.log(`\nMCP URL (add this as the connector URL): ${urls.mcpUrl}`);
  console.log(`GitHub OAuth callback URL:               ${urls.callbackUrl}`);
  return urls;
}

async function findKvNamespaceId(title: string): Promise<string | undefined> {
  const list = await wrangler(["kv", "namespace", "list"]);
  if (list.exitCode !== 0) fatal(`Listing KV namespaces failed:\n${list.stderr}`);
  const namespaces = JSON.parse(list.stdout.slice(list.stdout.indexOf("["))) as { id: string; title: string }[];
  return namespaces.find((namespace) => namespace.title === title)?.id;
}

/**
 * Rebuild the URLs from a kept wrangler.jsonc, which wins over the names
 * typed in step 2, so the printed callback URL matches what deploys.
 */
function urlsFromKeptConfig(typed: WorkerUrls): WorkerUrls {
  const text = readFileSync(CONFIG_PATH, "utf-8");
  const workerName = /"name":\s*"([^"]+)"/.exec(text)?.[1];
  const mcpUrl = /"MCP_RESOURCE":\s*"([^"]+)"/.exec(text)?.[1];
  if (!workerName || !mcpUrl) fatal("wrangler.jsonc has no name or MCP_RESOURCE. Delete it and rerun this script.");
  const urls = { workerName, mcpUrl, callbackUrl: mcpUrl.replace(/\/mcp$/, "/callback") };
  if (urls.mcpUrl !== typed.mcpUrl) {
    console.log("wrangler.jsonc names a different Worker URL than the one you entered. Using wrangler.jsonc:");
    console.log(`  MCP URL:                   ${urls.mcpUrl}`);
    console.log(`  GitHub OAuth callback URL: ${urls.callbackUrl}`);
  }
  return urls;
}

async function setUpKvAndConfig(urls: WorkerUrls): Promise<WorkerUrls> {
  heading("3. KV namespace and wrangler.jsonc");
  if (existsSync(CONFIG_PATH) && await confirm("wrangler.jsonc already exists. Keep it?", true)) {
    return urlsFromKeptConfig(urls);
  }

  const title = `${urls.workerName}-oauth-kv`;
  let id = await findKvNamespaceId(title);
  if (id) {
    console.log(`Reusing KV namespace "${title}".`);
  } else {
    const created = await wrangler(["kv", "namespace", "create", title]);
    if (created.exitCode !== 0) fatal(`Creating the KV namespace failed:\n${created.stderr}`);
    id = await findKvNamespaceId(title);
    if (!id) fatal(`Created KV namespace "${title}" but could not find its ID.`);
    console.log(`Created KV namespace "${title}".`);
  }

  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const config = template
    .replace('"name": "dynalist-mcp"', `"name": "${urls.workerName}"`)
    .replace("<OAUTH_KV_NAMESPACE_ID>", id)
    .replace("https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp", urls.mcpUrl);
  writeFileSync(CONFIG_PATH, config);
  console.log("Wrote wrangler.jsonc (gitignored).");
  return urls;
}

async function listExistingSecrets(): Promise<Set<string>> {
  // Fails when the Worker does not exist yet, which means no secrets.
  const list = await wrangler(["secret", "list", "--format", "json"]);
  if (list.exitCode !== 0) return new Set();
  try {
    const secrets = JSON.parse(list.stdout) as { name: string }[];
    return new Set(secrets.map((secret) => secret.name));
  } catch {
    return new Set();
  }
}

interface SecretSpec {
  name: string;
  explanation: string[];
  hidden: boolean;
  // Rewrites raw input before validation (e.g. spaces around commas).
  normalize?: (value: string) => string;
  validate: (value: string) => ValidationResult<unknown> | Promise<ValidationResult<unknown>>;
  // Confirms a parsed value with the user before upload. Returns false to re-prompt.
  confirmValue?: (value: string) => Promise<boolean>;
}

async function verifyDynalistToken(value: string): Promise<ValidationResult<string>> {
  const format = validateDynalistApiToken(value);
  if (!format.ok) return format;
  try {
    const response = await fetch(DYNALIST_FILE_LIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: value }),
    });
    const body = await response.json() as { _code?: string };
    if (body._code?.toLowerCase() === "ok") return { ok: true, value };
    return { ok: false, rule: `Dynalist rejected the token (${body._code ?? `HTTP ${response.status}`})` };
  } catch (err) {
    return { ok: false, rule: `could not reach Dynalist to verify it (${err instanceof Error ? err.message : String(err)})` };
  }
}

async function putSecret(name: string, value: string): Promise<void> {
  const result = await wrangler(["secret", "put", name], value);
  if (result.exitCode !== 0) fatal(`Setting ${name} failed:\n${result.stderr}`);
  console.log(`Set ${name}.`);
}

/**
 * Prompt for one secret until a valid value is entered or the existing
 * value is kept, then upload it.
 */
async function promptSecret(spec: SecretSpec, existing: Set<string>): Promise<void> {
  console.log(`\n-- ${spec.name} --`);
  for (const line of spec.explanation) console.log(line);
  const alreadySet = existing.has(spec.name);
  if (alreadySet) console.log("Already set. Press Enter to keep the existing value.");

  for (;;) {
    const raw = spec.hidden ? await promptHidden(`${spec.name}: `) : await promptLine(`${spec.name}: `);
    const value = spec.normalize ? spec.normalize(raw) : raw;
    if (value === "") {
      if (alreadySet && await confirm("Keep the existing value?", false)) return;
      if (!alreadySet) console.log("A value is required.");
      continue;
    }
    if (/\s/.test(value)) {
      console.log("The value must not contain whitespace.");
      continue;
    }
    const result = await spec.validate(value);
    if (!result.ok) {
      console.log(`Invalid value: ${spec.name} ${result.rule}.`);
      continue;
    }
    if (spec.confirmValue && !await spec.confirmValue(value)) continue;
    await putSecret(spec.name, value);
    return;
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Read and validate a config file. Returns its contents, or the reason
 * it was rejected.
 */
function readConfigFile(input: string): { ok: true; raw: string } | { ok: false; reason: string } {
  const path = expandHome(input);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, reason: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = validateConfigJson(raw);
  if (!result.ok) return { ok: false, reason: `Invalid config: ${result.rule}` };
  return { ok: true, raw };
}

/**
 * Prompt for a local config file path and upload its contents as
 * DYNALIST_MCP_CONFIG_JSON. Skipping leaves any existing value.
 */
async function promptConfigFile(existing: Set<string>): Promise<void> {
  const name = "DYNALIST_MCP_CONFIG_JSON";
  console.log(`\n-- ${name} (optional) --`);
  console.log("Access rules and other settings, using the same JSON as the local ~/.dynalist-mcp.json.");
  console.log("Enter the path to a local config file. The script uploads its contents.");
  console.log("`logFile` is not supported on Workers.");
  const defaultPath = join(homedir(), ".dynalist-mcp.json");
  const fallback = existsSync(defaultPath) ? defaultPath : undefined;
  const skipHint = existing.has(name) ? "keep the existing value" : "skip";

  for (;;) {
    const hint = fallback ? ` [${fallback}, or "-" to ${skipHint}]` : ` [Enter to ${skipHint}]`;
    let input = await promptLine(`Config file path${hint}: `);
    if (input === "-" || (input === "" && !fallback)) {
      console.log(existing.has(name) ? "Kept the existing value." : "Skipped. The Worker uses default settings.");
      return;
    }
    if (input === "") input = fallback!;

    const file = readConfigFile(input);
    if (!file.ok) {
      console.log(file.reason);
      continue;
    }
    await putSecret(name, file.raw);
    return;
  }
}

async function setSecrets(urls: WorkerUrls): Promise<void> {
  heading("4. Secrets");
  const existing = await listExistingSecrets();

  const specs: SecretSpec[] = [
    {
      name: "DYNALIST_API_TOKEN",
      explanation: [
        "The Dynalist account this server reads and writes.",
        "Get it at https://dynalist.io/developer. Input is hidden.",
      ],
      hidden: true,
      validate: verifyDynalistToken,
    },
    {
      name: "GITHUB_CLIENT_ID",
      explanation: [
        "GitHub sign-in protects the server. Create a GitHub OAuth app at",
        "https://github.com/settings/applications/new with:",
        `  Homepage URL:               ${urls.mcpUrl.replace(/\/mcp$/, "")}`,
        `  Authorization callback URL: ${urls.callbackUrl}`,
        "Then paste the app's Client ID.",
      ],
      hidden: false,
      validate: validateGithubClientId,
    },
    {
      name: "GITHUB_CLIENT_SECRET",
      explanation: [
        "In the same GitHub OAuth app, click \"Generate a new client secret\" and paste it.",
        "Input is hidden.",
      ],
      hidden: true,
      validate: validateGithubClientSecret,
    },
    {
      name: "ALLOWED_GITHUB_USERS",
      explanation: [
        "Comma-separated GitHub usernames allowed to sign in (usually just yours).",
        "Every other GitHub account is rejected.",
      ],
      hidden: false,
      // The Worker trims entries, so spaces after commas are accepted.
      normalize: (value) => value.split(",").map((entry) => entry.trim()).join(","),
      validate: (value) => parseAllowedGithubUsers(value),
      confirmValue: async (value) => {
        const parsed = parseAllowedGithubUsers(value);
        if (!parsed.ok) return false;
        console.log("Allowed GitHub users:");
        for (const user of parsed.value) console.log(`  ${user}  (https://github.com/${user})`);
        return confirm("Is this list correct?", false);
      },
    },
  ];

  for (const spec of specs) {
    await promptSecret(spec, existing);
  }
  await promptConfigFile(existing);
}

// Setting a secret deploys a new Worker version, which restarts the
// Durable Object, so secret and config changes apply without a deploy.
const SECRETS_LIVE_MESSAGE = "Secret changes are live now. No deploy is needed for them.";

async function main(): Promise<void> {
  console.log("dynalist-mcp Cloudflare Workers setup");
  await preflight();
  const urls = await setUpKvAndConfig(await chooseWorkerUrls());
  await setSecrets(urls);

  heading("Done");
  console.log(SECRETS_LIVE_MESSAGE);
  console.log("On first setup, or after code changes, deploy the code with: bun run deploy");
  console.log(`Add ${urls.mcpUrl} as a custom connector (see docs/client-setup.md).`);
}

/**
 * Validate a config file and upload only DYNALIST_MCP_CONFIG_JSON.
 */
async function configOnly(path: string | undefined): Promise<void> {
  console.log("dynalist-mcp Cloudflare Workers config update");
  if (!existsSync(CONFIG_PATH)) fatal("wrangler.jsonc not found. Run `bun run worker-setup` first.");
  await preflight();
  heading("Config");
  if (path === undefined) {
    await promptConfigFile(await listExistingSecrets());
  } else {
    const file = readConfigFile(path);
    if (!file.ok) fatal(file.reason);
    await putSecret("DYNALIST_MCP_CONFIG_JSON", file.raw);
  }
  console.log(`\n${SECRETS_LIVE_MESSAGE}`);
}

const args = process.argv.slice(2);
if (args[0] === "--config-only") {
  if (args.length > 2) fatal("Usage: bun run worker-config [path-to-config-file]");
  await configOnly(args[1]);
} else if (args.length > 0) {
  fatal("Usage: bun run worker-setup");
} else {
  await main();
}
