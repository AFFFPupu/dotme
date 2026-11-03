// /setup/status: what this install has configured and what is missing, so an
// agent (or a person) installing dotme can check every step. JSON for agents,
// a short page for browsers. It never shows a secret, only whether it is set,
// and it names no data repo, so it is safe to leave public.

import { escape, html, say } from "./html";
import { countPasskeys } from "./passkeys";

export interface SetupEnv {
  OWNER_PASSPHRASE?: string;
  MCP_RESOURCE?: string;
  EXPORT_TOKEN?: string;
  STORAGE?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  OAUTH_KV?: KVNamespace;
}

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
  // What to do next. "Human:" marks a step an agent must hand over, such as typing a secret.
  fix?: string;
}

export const EXPIRY_WARN_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const SECRET = (name: string) => `Human: run \`npm run wrangler -- secret put ${name}\` and type the value at the prompt.`;
const NEW_TOKEN = "Human: create a new fine-grained token (Contents read and write on the data repo only, 366 days), then run `npm run wrangler -- secret put GITHUB_TOKEN` and paste it.";

// GitHub sends the token's expiry on every API response, as "2027-11-03 12:00:00 UTC" or with an offset like "+0100".
export function parseTokenExpiry(header: string | null | undefined): Date | null {
  const m = header?.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysLeft(expires: Date, now = new Date()): number {
  return Math.floor((expires.getTime() - now.getTime()) / DAY);
}

export function expiryCheck(expires: Date | null, now = new Date()): Check {
  if (!expires) return { id: "github_token_expiry", status: "ok", detail: "The token has no expiry date." };
  const days = daysLeft(expires, now);
  const date = expires.toISOString().slice(0, 10);
  if (expires.getTime() <= now.getTime()) return { id: "github_token_expiry", status: "fail", detail: `The token expired on ${date}.`, fix: NEW_TOKEN };
  if (days < EXPIRY_WARN_DAYS) {
    return { id: "github_token_expiry", status: "warn", detail: `The token expires on ${date}, in ${days} day${days === 1 ? "" : "s"}.`, fix: NEW_TOKEN };
  }
  return { id: "github_token_expiry", status: "ok", detail: `The token expires on ${date}, in ${days} days.` };
}

// One-line warning for owner pages, or "" while the token has more than 30 days left.
export function expiryWarning(expires: Date | null, now = new Date()): string {
  const check = expiryCheck(expires, now);
  if (check.status === "ok") return "";
  return `<div class="box notice"><p><strong>${escape(check.detail)}</strong> Approvals stop working when it expires. Create a new token and run <code>npm run wrangler -- secret put GITHUB_TOKEN</code>. <a href="/setup/status">Setup status</a></p></div>`;
}

const isLocal = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

function passphraseCheck(env: SetupEnv): Check {
  if (!env.OWNER_PASSPHRASE) return { id: "owner_passphrase", status: "fail", detail: "OWNER_PASSPHRASE is not set; sign-in and approvals are off.", fix: SECRET("OWNER_PASSPHRASE") };
  if (env.OWNER_PASSPHRASE.length < 12) {
    return { id: "owner_passphrase", status: "warn", detail: "OWNER_PASSPHRASE is set but shorter than 12 characters.", fix: SECRET("OWNER_PASSPHRASE") };
  }
  return { id: "owner_passphrase", status: "ok", detail: "OWNER_PASSPHRASE is set." };
}

// The URL clients connect to and every token is bound to. `npm run deploy` pins it with MCP_RESOURCE.
// A Deploy to Cloudflare install has no MCP_RESOURCE, so it is the address the request reached, which
// on Workers is always one of the Worker's own hostnames (its workers.dev name or a route it owns).
export function resourceFor(configured: string | undefined, requestUrl: string): string {
  return configured || `${new URL(requestUrl).origin}/mcp`;
}

function resourceCheck(env: SetupEnv, origin: string): Check {
  const expected = `${origin}/mcp`;
  const fix = `Set "url" in dotme.config.json to ${origin}, then run \`npm run deploy\`.`;
  if (!env.MCP_RESOURCE) {
    return { id: "mcp_resource", status: "ok", detail: `Clients connect to ${expected}, the address this server was reached at (MCP_RESOURCE is not set).` };
  }
  if (env.MCP_RESOURCE !== expected) {
    return { id: "mcp_resource", status: "fail", detail: `MCP_RESOURCE is ${env.MCP_RESOURCE}, but this server is reached at ${expected}; clients will be refused tokens.`, fix };
  }
  return { id: "mcp_resource", status: "ok", detail: `Clients connect to ${expected}.` };
}

async function kvCheck(env: SetupEnv): Promise<Check> {
  const fix = 'Set "kvNamespaceId" in dotme.config.json (`npm run wrangler -- kv namespace create OAUTH_KV`), then run `npm run deploy`.';
  if (!env.OAUTH_KV) return { id: "kv", status: "fail", detail: "No OAUTH_KV binding.", fix };
  try {
    await env.OAUTH_KV.get("setup:probe");
    return { id: "kv", status: "ok", detail: "OAUTH_KV is bound and readable." };
  } catch (error) {
    return { id: "kv", status: "fail", detail: `OAUTH_KV could not be read: ${(error as Error).message}`, fix };
  }
}

const gh = (fetcher: typeof fetch, token: string, path: string, init: RequestInit = {}) =>
  fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dotme", "X-GitHub-Api-Version": "2022-11-28" },
  });

// Repo reachable and private, token able to write, and when it expires.
export async function githubChecks(env: SetupEnv, fetcher: typeof fetch = fetch, now = new Date()): Promise<Check[]> {
  const skip = (id: string): Check => ({ id, status: "skip", detail: "Skipped until the checks above pass." });
  const repo = env.GITHUB_REPO ?? "";
  const repoFix = 'Set "githubRepo" in dotme.config.json to owner/name of your private data repo, then run `npm run deploy`. With Deploy to Cloudflare, set the GITHUB_REPO secret instead (Worker settings, Variables and Secrets).';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return [
      { id: "github_repo", status: "fail", detail: env.GITHUB_REPO ? "GITHUB_REPO is not in owner/name form." : "GITHUB_REPO is not set.", fix: repoFix },
      skip("github_token"), skip("github_token_write"), skip("github_token_expiry"),
    ];
  }
  if (!env.GITHUB_TOKEN) {
    return [
      { id: "github_repo", status: "skip", detail: "Checked once GITHUB_TOKEN is set." },
      { id: "github_token", status: "fail", detail: "GITHUB_TOKEN is not set.", fix: NEW_TOKEN },
      skip("github_token_write"), skip("github_token_expiry"),
    ];
  }

  let res: Response;
  try {
    res = await gh(fetcher, env.GITHUB_TOKEN, `/repos/${repo}`);
  } catch (error) {
    return [{ id: "github_repo", status: "fail", detail: `GitHub could not be reached: ${(error as Error).message}` }, skip("github_token"), skip("github_token_write"), skip("github_token_expiry")];
  }
  if (res.status === 401) {
    return [
      { id: "github_repo", status: "skip", detail: "Checked once GitHub accepts the token." },
      { id: "github_token", status: "fail", detail: "GitHub rejected GITHUB_TOKEN: it expired, was revoked or was mistyped.", fix: NEW_TOKEN },
      skip("github_token_write"), skip("github_token_expiry"),
    ];
  }
  const expiry = expiryCheck(parseTokenExpiry(res.headers.get("github-authentication-token-expiration")), now);
  if (res.status === 403 || res.status === 404) {
    return [
      { id: "github_repo", status: "fail", detail: "The data repo does not exist or the token cannot see it.", fix: `${repoFix} The token must be given access to that repo.` },
      { id: "github_token", status: "ok", detail: "GitHub accepts the token." },
      skip("github_token_write"), expiry,
    ];
  }
  if (!res.ok) {
    return [{ id: "github_repo", status: "fail", detail: `GitHub answered ${res.status}.` }, skip("github_token"), skip("github_token_write"), expiry];
  }
  const body = (await res.json()) as { private?: boolean };
  const repoCheck: Check = body.private
    ? { id: "github_repo", status: "ok", detail: "The data repo is reachable and private." }
    : { id: "github_repo", status: "fail", detail: "The data repo is public, so anyone can read your preferences.", fix: "Human: make the data repo private in its GitHub settings." };

  // Write access without writing anything: ask to create a branch at a commit that cannot exist.
  // GitHub checks permission first (403), then rejects the commit (422, or 409 for an empty repo).
  let write: Check;
  try {
    const probe = await gh(fetcher, env.GITHUB_TOKEN, `/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/dotme-setup-probe", sha: "0".repeat(40) }),
    });
    write =
      probe.status === 422 || probe.status === 409
        ? { id: "github_token_write", status: "ok", detail: "The token can write to the data repo." }
        : probe.status === 403 || probe.status === 404
          ? { id: "github_token_write", status: "fail", detail: "The token can read the data repo but not write to it.", fix: `${NEW_TOKEN} Give it Contents: Read and write.` }
          : { id: "github_token_write", status: "warn", detail: `Write access could not be confirmed (GitHub answered ${probe.status}).` };
  } catch (error) {
    write = { id: "github_token_write", status: "warn", detail: `Write access could not be checked: ${(error as Error).message}` };
  }
  return [repoCheck, { id: "github_token", status: "ok", detail: "GitHub accepts the token." }, write, expiry];
}

// GitHub calls are cached briefly so the public page cannot be used to burn the token's rate limit.
let cachedGithub: { at: number; key: string; checks: Check[] } | null = null;
const CACHE_MS = 30_000;

export async function runChecks(env: SetupEnv, origin: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<Check[]> {
  const checks: Check[] = [passphraseCheck(env), resourceCheck(env, origin), await kvCheck(env)];

  if (env.STORAGE === "kv") {
    checks.push(
      isLocal(origin)
        ? { id: "storage", status: "ok", detail: "STORAGE=kv: preferences live in KV, for local development." }
        : { id: "storage", status: "warn", detail: "STORAGE=kv on a public server: preferences are not in your GitHub repo and have no history.", fix: "Remove the STORAGE var and run `npm run deploy`." }
    );
    for (const id of ["github_repo", "github_token", "github_token_write", "github_token_expiry"]) checks.push({ id, status: "skip", detail: "Not used with STORAGE=kv." });
  } else {
    checks.push({ id: "storage", status: "ok", detail: "Preferences live in your GitHub data repo." });
    const key = `${env.GITHUB_REPO}|${env.GITHUB_TOKEN?.length ?? 0}`;
    if (!cachedGithub || cachedGithub.key !== key || now.getTime() - cachedGithub.at > CACHE_MS) {
      cachedGithub = { at: now.getTime(), key, checks: await githubChecks(env, fetcher, now) };
    }
    checks.push(...cachedGithub.checks);
  }

  checks.push(
    env.EXPORT_TOKEN
      ? { id: "export_token", status: "ok", detail: "EXPORT_TOKEN is set, so the Claude Code and Codex hook can load preferences." }
      : { id: "export_token", status: "warn", detail: "EXPORT_TOKEN is not set; the session-start hook cannot load preferences.", fix: "Run step 8 of INSTALL.md: it creates the token, saves it in ~/.config/dotme/auth-header and sets EXPORT_TOKEN without printing it." }
  );

  const passkeys = env.OAUTH_KV ? await countPasskeys(env.OAUTH_KV).catch(() => 0) : 0;
  checks.push(
    passkeys > 0
      ? { id: "passkey", status: "ok", detail: `${passkeys} passkey${passkeys === 1 ? "" : "s"} registered.` }
      : { id: "passkey", status: "warn", detail: "No passkey yet; sign-in falls back to the passphrase.", fix: `Human: open ${origin}/approve on your laptop and on your phone, sign in, and set up a passkey on each.` }
  );
  return checks;
}

const TAG: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export async function setupStatus(request: Request, env: SetupEnv): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const checks = await runChecks(env, url.origin);
  const ok = checks.every((c) => c.status !== "fail");
  const allGreen = checks.every((c) => c.status === "ok" || c.status === "skip");
  const wantsHtml = url.searchParams.get("format") !== "json" && (request.headers.get("Accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    return new Response(JSON.stringify({ ok, allGreen, checks }, null, 2) + "\n", {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const rows = checks.map(
    (c) => `<li><span class="tag ${c.status}">${TAG[c.status]}</span><span><strong>${escape(c.id)}</strong>: ${escape(c.detail)}${c.fix ? `<br><small class="meta">${escape(c.fix)}</small>` : ""}</span></li>`
  );
  const summary = allGreen ? "Everything is set up." : ok ? "Working, with warnings below." : "Not working yet: fix the items marked FAIL.";
  const headers = new Headers({ "Cache-Control": "no-store" });
  return html(`<title>dotme setup status</title><h1>dotme setup status</h1>${say(`<p><strong>${summary}</strong></p>`, allGreen ? "happy" : ok ? "idle" : "oops")}<ul class="checks">${rows.join("")}</ul>
<p><small>Agents: <code>curl ${escape(url.origin)}/setup/status</code> returns JSON.</small></p>`, headers);
}
