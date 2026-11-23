/**
 * OAuth authorization pages: /authorize shows a consent dialog, then
 * hands the owner to GitHub, and /callback checks the GitHub login
 * against the allowlist before any grant is issued.
 *
 * The consent dialog stays even though only allowlisted accounts can
 * sign in. Dynamic client registration lets anyone register a client, so
 * without it an attacker could send the owner a link that silently
 * authorizes the attacker's client against the owner's GitHub session.
 *
 * The library's consent helpers bind each form handle and GitHub state
 * to the browser with __Host- cookies and forbid framing, so the pages
 * need no CSRF token of their own.
 */

import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { log } from "../config";
import { recordAuditLog } from "./audit-log";
import { isAllowedGithubUser, parseAllowedGithubUsers } from "./env-validation";
import { createCodeVerifier, s256CodeChallenge } from "./pkce";
import type { Env, GrantProps } from "./env";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

interface UpstreamData {
  codeVerifier: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function htmlPage(title: string, body: string, status: number, headers: Headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  .warning { color: #a33; }
  button { font-size: 1rem; padding: 0.4rem 1rem; margin-right: 0.5rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(page, { status, headers });
}

function errorPage(message: string, status: number, headers?: Headers): Response {
  return htmlPage("Authorization failed", `<h1>Authorization failed</h1>\n<p>${escapeHtml(message)}</p>`, status, headers);
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopbackWarning = details.redirectIsLoopback
    ? `<p class="warning"><strong>This sends access to an app on your computer.</strong> ` +
      `Continue only if you just started signing in from it.</p>`
    : "";
  const scopes = details.scope.length > 0
    ? `<p>Requested scopes: ${details.scope.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(", ")}</p>`
    : "";
  const body = `<h1>Allow ${name} to access your Dynalist?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
${scopes}
<p>Approving signs you in with GitHub. Only allowlisted GitHub accounts can finish.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
  return htmlPage(`Authorize ${details.clientName}`, body, 200, headers);
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

async function showConsent(request: Request, oauth: OAuthHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  // Describe first: a failed client lookup then leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return consentPage(details, consent.handle, consent.headers);
}

async function submitConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return redirect(denied.redirectTo, denied.headers);
  }

  const approved = await oauth.approveConsent(request, handle);
  const codeVerifier = createCodeVerifier();
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { codeVerifier } satisfies UpstreamData,
    headers: approved.headers,
  });

  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", callbackUrl(request));
  githubUrl.searchParams.set("scope", "read:user");
  githubUrl.searchParams.set("state", upstream.state);
  githubUrl.searchParams.set("code_challenge", await s256CodeChallenge(codeVerifier));
  githubUrl.searchParams.set("code_challenge_method", "S256");
  githubUrl.searchParams.set("allow_signup", "false");
  return redirect(githubUrl.toString(), upstream.headers);
}

/**
 * Exchange the GitHub code and return the signed-in login. The GitHub
 * access token is used once here and then discarded.
 */
async function fetchGithubLogin(request: Request, env: Env, code: string, codeVerifier: string): Promise<string | null> {
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request),
      code_verifier: codeVerifier,
    }),
  });
  // GitHub outages return HTML, so a parse failure counts as a failed exchange.
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    log("warn", `GitHub code exchange failed: ${tokenBody.error ?? `HTTP ${tokenResponse.status}`}.`);
    return null;
  }

  const userResponse = await fetch(GITHUB_USER_URL, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${tokenBody.access_token}`,
      "User-Agent": "dynalist-mcp",
    },
  });
  if (!userResponse.ok) {
    log("warn", `GitHub user lookup failed: HTTP ${userResponse.status}.`);
    return null;
  }
  const user = await userResponse.json().catch(() => ({})) as { login?: unknown };
  return typeof user.login === "string" && user.login !== "" ? user.login : null;
}

async function handleCallback(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const { request: authRequest, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    return redirect(authorizationErrorRedirect(authRequest, "access_denied"), headers);
  }

  const login = await fetchGithubLogin(request, env, code, data.codeVerifier);
  if (login === null) {
    return errorPage("GitHub sign-in failed. Start again from your MCP client.", 502, headers);
  }

  // Env validation guarantees the allowlist parses, so a failure here
  // means it was changed underneath a running isolate. Reject.
  const allowlist = parseAllowedGithubUsers(env.ALLOWED_GITHUB_USERS);
  if (!allowlist.ok || !isAllowedGithubUser(login, allowlist.value)) {
    const rejection = `Rejected sign-in from GitHub account "${login}", which is not on the allowlist.`;
    log("warn", rejection);
    recordAuditLog(rejection);
    return errorPage("This GitHub account is not allowed to use this server.", 403, headers);
  }

  // Logged at warn so the line shows with the default logLevel.
  const signIn = `Signed in GitHub account "${login}".`;
  log("warn", signIn);
  recordAuditLog(signIn);
  const props: GrantProps = { login: login.toLowerCase() };
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: props.login,
    metadata: {},
    scope: authRequest.scope,
    props,
  });
  return redirect(redirectTo, headers);
}

/**
 * Handle every non-API route: the authorization pages and the GitHub
 * callback. OAuthProvider serves discovery, token, and registration
 * endpoints itself.
 */
export async function handleAuthorizationRoutes(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/authorize" && request.method === "GET") return await showConsent(request, oauth);
    if (pathname === "/authorize" && request.method === "POST") return await submitConsent(request, env, oauth);
    if (pathname === "/callback" && request.method === "GET") return await handleCallback(request, env, oauth);
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    // A redirect back to the client is safe only once the library has
    // validated the client and its redirect URI.
    if (error instanceof AuthorizationError && error.redirectTo) {
      return redirect(error.redirectTo);
    }
    if (error instanceof AuthorizationError) {
      return errorPage(`${error.description} Start again from your MCP client.`, 400);
    }
    if (error instanceof CimdFetchError) {
      return errorPage("This app could not be verified.", 400);
    }
    throw error;
  }
}
