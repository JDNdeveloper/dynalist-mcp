/**
 * Guided setup for deploying dynalist-mcp to Cloudflare Workers.
 * Run with: bun run worker-setup
 *
 * `bun run worker-config [path]` runs only the config step: it validates
 * a local config file and uploads it as DYNALIST_MCP_CONFIG_JSON. With a
 * path it does not prompt.
 *
 * Every step detects completed state and offers to keep it, so rerunning
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
const DEFAULT_CONFIG_FILE = join(homedir(), ".dynalist-mcp.json");
const CONFIG_SECRET = "DYNALIST_MCP_CONFIG_JSON";
const DYNALIST_FILE_LIST_URL = "https://dynalist.io/api/v1/file/list";

// Cloudflare Worker names and workers.dev subdomains: lowercase letters,
// digits, and hyphens, not starting or ending with a hyphen.
const CLOUDFLARE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ─── Output ──────────────────────────────────────────────────────────

function heading(text: string): void {
  console.log(`\n== ${text} ==`);
}

function subheading(text: string): void {
  console.log(`\n-- ${text} --`);
}

function fatal(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

/**
 * Show a path with the home directory as `~`, so output stays short.
 */
function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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

/**
 * Show a numbered menu and return the zero-based index of the chosen
 * option. Pressing Enter picks the first option.
 */
async function choose(options: string[]): Promise<number> {
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option}`));
  for (;;) {
    const answer = await promptLine("Choose [1]: ");
    if (answer === "") return 0;
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) return choice - 1;
    console.log(`Enter a number from 1 to ${options.length}.`);
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
  heading("Wrangler");
  const version = await wrangler(["--version"]);
  if (version.exitCode !== 0) {
    fatal("wrangler did not run. Run `bun install`, then rerun this script.");
  }
  const whoami = await wrangler(["whoami"]);
  const output = whoami.stdout + whoami.stderr;
  if (whoami.exitCode !== 0 || /not authenticated/i.test(output)) {
    fatal("wrangler is not logged in. Run `bunx wrangler login`, then rerun this script.");
  }
  console.log("wrangler is installed and logged in.");
}

interface WorkerUrls {
  workerName: string;
  mcpUrl: string;
  callbackUrl: string;
}

function printUrls(urls: WorkerUrls): void {
  console.log(`\nConnector URL:  ${urls.mcpUrl}`);
  console.log(`Redirect URI:   ${urls.callbackUrl}`);
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
 * Read the Worker URLs from an existing wrangler.jsonc, or undefined if
 * there is none.
 */
function readExistingUrls(): (WorkerUrls & { subdomain?: string }) | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  const text = readFileSync(CONFIG_PATH, "utf-8");
  const workerName = /"name":\s*"([^"]+)"/.exec(text)?.[1];
  const mcpUrl = /"MCP_RESOURCE":\s*"([^"]+)"/.exec(text)?.[1];
  if (!workerName || !mcpUrl) fatal("wrangler.jsonc has no name or MCP_RESOURCE. Delete it and rerun this script.");
  const subdomain = /^https:\/\/[^.]+\.([^.]+)\.workers\.dev\/mcp$/.exec(mcpUrl)?.[1];
  return { workerName, mcpUrl, callbackUrl: mcpUrl.replace(/\/mcp$/, "/callback"), subdomain };
}

async function findKvNamespaceId(title: string): Promise<string | undefined> {
  const list = await wrangler(["kv", "namespace", "list"]);
  if (list.exitCode !== 0) fatal(`Listing KV namespaces failed:\n${list.stderr}`);
  const namespaces = JSON.parse(list.stdout.slice(list.stdout.indexOf("["))) as { id: string; title: string }[];
  return namespaces.find((namespace) => namespace.title === title)?.id;
}

/**
 * Choose the Worker URL, create or reuse the OAuth KV namespace, and
 * write wrangler.jsonc. An existing wrangler.jsonc can be kept as-is.
 */
async function setUpWorker(): Promise<WorkerUrls> {
  heading("Worker");
  const existing = readExistingUrls();
  if (existing) {
    console.log(`Current connector URL: ${existing.mcpUrl}`);
    if (await choose(["Keep this Worker", "Set up a different Worker"]) === 0) {
      printUrls(existing);
      return existing;
    }
  }

  console.log("Your Worker URL is https://<worker name>.<subdomain>.workers.dev.");
  console.log("Find your subdomain in the Cloudflare dashboard under Workers & Pages.\n");
  const workerName = await promptCloudflareName("Worker name", existing?.workerName ?? "dynalist-mcp");
  const subdomain = await promptCloudflareName("workers.dev subdomain", existing?.subdomain);
  const origin = `https://${workerName}.${subdomain}.workers.dev`;
  const urls = { workerName, mcpUrl: `${origin}/mcp`, callbackUrl: `${origin}/callback` };

  // The KV namespace stores OAuth state such as clients and grants.
  const title = `${workerName}-oauth-kv`;
  let id = await findKvNamespaceId(title);
  if (id) {
    console.log(`\nReusing KV namespace "${title}".`);
  } else {
    const created = await wrangler(["kv", "namespace", "create", title]);
    if (created.exitCode !== 0) fatal(`Creating the KV namespace failed:\n${created.stderr}`);
    id = await findKvNamespaceId(title);
    if (!id) fatal(`Created KV namespace "${title}" but could not find its ID.`);
    console.log(`\nCreated KV namespace "${title}".`);
  }

  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const config = template
    .replace('"name": "dynalist-mcp"', `"name": "${workerName}"`)
    .replace("<OAUTH_KV_NAMESPACE_ID>", id)
    .replace("https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp", urls.mcpUrl);
  writeFileSync(CONFIG_PATH, config);
  console.log("Wrote wrangler.jsonc (gitignored).");
  printUrls(urls);
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
  // One line saying what the secret is, shown every time.
  summary: string;
  // Where to get the value, shown only when entering a new one.
  instructions: string[];
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
 * value is kept, then upload it. An existing value is kept by default.
 */
async function promptSecret(spec: SecretSpec, existing: Set<string>): Promise<void> {
  subheading(spec.name);
  console.log(spec.summary);
  const alreadySet = existing.has(spec.name);
  if (alreadySet && await choose(["Keep the current value", "Enter a new value"]) === 0) {
    console.log("Kept.");
    return;
  }

  for (const line of spec.instructions) console.log(line);
  const label = spec.hidden ? "Value (hidden): " : "Value: ";
  for (;;) {
    const raw = spec.hidden ? await promptHidden(label) : await promptLine(label);
    const value = spec.normalize ? spec.normalize(raw) : raw;
    if (value === "") {
      if (alreadySet) {
        console.log("Kept the current value.");
        return;
      }
      console.log("A value is required.");
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
    return { ok: false, reason: `Could not read ${displayPath(path)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = validateConfigJson(raw);
  if (!result.ok) return { ok: false, reason: `Invalid config: ${result.rule}` };
  return { ok: true, raw };
}

/**
 * Validate a config file and upload it. Returns false if the file was
 * rejected, after printing the reason.
 */
async function uploadConfigFile(path: string): Promise<boolean> {
  const file = readConfigFile(path);
  if (!file.ok) {
    console.log(file.reason);
    return false;
  }
  await putSecret(CONFIG_SECRET, file.raw);
  return true;
}

/**
 * Offer a menu to upload a local config file as DYNALIST_MCP_CONFIG_JSON,
 * or to leave the current value (or the defaults) in place.
 */
async function promptConfigFile(existing: Set<string>): Promise<void> {
  subheading(`${CONFIG_SECRET} (optional)`);
  console.log("Access rules and other settings, from a local config file.");
  const alreadySet = existing.has(CONFIG_SECRET);

  for (;;) {
    const options: { label: string; run: () => Promise<boolean> }[] = [];
    if (existsSync(DEFAULT_CONFIG_FILE)) {
      const verb = alreadySet ? "Reload from" : "Upload";
      options.push({ label: `${verb} ${displayPath(DEFAULT_CONFIG_FILE)}`, run: () => uploadConfigFile(DEFAULT_CONFIG_FILE) });
    }
    options.push({
      label: "Specify a file path",
      run: async () => {
        const path = await promptLine("Config file path: ");
        return path === "" ? false : uploadConfigFile(path);
      },
    });
    options.push({
      label: alreadySet ? "Keep as-is" : "Skip (use default settings)",
      run: async () => {
        console.log(alreadySet ? "Kept." : "Skipped.");
        return true;
      },
    });

    if (await options[await choose(options.map((option) => option.label))].run()) return;
  }
}

async function setSecrets(urls: WorkerUrls): Promise<void> {
  heading("Secrets");
  const existing = await listExistingSecrets();

  const specs: SecretSpec[] = [
    {
      name: "DYNALIST_API_TOKEN",
      summary: "The Dynalist account this server reads and writes.",
      instructions: ["Get it at https://dynalist.io/developer."],
      hidden: true,
      validate: verifyDynalistToken,
    },
    {
      name: "GITHUB_CLIENT_ID",
      summary: "Client ID of the GitHub OAuth app used for sign-in.",
      instructions: [
        "Create an OAuth app at https://github.com/settings/applications/new:",
        `  Application name:           ${urls.workerName}`,
        `  Homepage URL:               ${urls.mcpUrl.replace(/\/mcp$/, "")}`,
        `  Redirect URI:               ${urls.callbackUrl}`,
        "  Allow wildcard matching:    off",
        "  Enable Device Flow:         off",
        "  Expire user access tokens:  on",
        "Then copy its Client ID.",
      ],
      hidden: false,
      validate: validateGithubClientId,
    },
    {
      name: "GITHUB_CLIENT_SECRET",
      summary: "Client secret of the same GitHub OAuth app.",
      instructions: ["In the app, click \"Generate a new client secret\"."],
      hidden: true,
      validate: validateGithubClientSecret,
    },
    {
      name: "ALLOWED_GITHUB_USERS",
      summary: "GitHub usernames allowed to sign in. Everyone else is rejected.",
      instructions: ["Separate usernames with commas."],
      hidden: false,
      // The Worker trims entries, so spaces after commas are accepted.
      normalize: (value) => value.split(",").map((entry) => entry.trim()).join(","),
      validate: (value) => parseAllowedGithubUsers(value),
      confirmValue: async (value) => {
        const parsed = parseAllowedGithubUsers(value);
        if (!parsed.ok) return false;
        console.log("Allowed:");
        for (const user of parsed.value) console.log(`  https://github.com/${user}`);
        return confirm("Correct?", true);
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
  const urls = await setUpWorker();
  await setSecrets(urls);

  heading("Done");
  console.log(SECRETS_LIVE_MESSAGE);
  console.log("On first setup or after code changes, run: bun run deploy");
  console.log("Then add the connector URL in your client (see docs/client-setup.md).");
}

/**
 * Validate a config file and upload only DYNALIST_MCP_CONFIG_JSON.
 */
async function configOnly(path: string | undefined): Promise<void> {
  console.log("dynalist-mcp Cloudflare Workers config update");
  if (!existsSync(CONFIG_PATH)) fatal("wrangler.jsonc not found. Run `bun run worker-setup` first.");
  await preflight();
  heading("Secrets");
  if (path === undefined) {
    await promptConfigFile(await listExistingSecrets());
  } else {
    const file = readConfigFile(path);
    if (!file.ok) fatal(file.reason);
    await putSecret(CONFIG_SECRET, file.raw);
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
