// Start a throwaway `wrangler dev` with KV storage and fresh state, run the
// end-to-end scripts against it (OAuth, approvals, elicitation, export, the
// SessionStart hook and categories), then stop it. This is what CI runs.
// Usage: node scripts/e2e-local.mjs [port]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8788);
const base = `http://localhost:${port}`;
// A test-only value for a local server that is never exposed; not a real secret.
const passphrase = "e2e-test-passphrase";
const exportToken = "e2e-export-token";
const state = mkdtempSync(join(tmpdir(), "dotme-e2e-"));

// A category beyond the defaults, added the way a user adds one: a Markdown file in the data repo.
execFileSync("npx", [
  "wrangler", "kv", "key", "put", "--binding", "OAUTH_KV", "--local", "--persist-to", state, "file:work.md",
  "# work\n\n- Standups are async.\n  id: p-0000a001 · since: 2026-11-01 · by: owner\n",
], { stdio: "ignore" });

const server = spawn(
  "npx",
  [
    "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--show-interactive-dev-session=false",
    "--var", `OWNER_PASSPHRASE:${passphrase}`, "--var", `MCP_RESOURCE:${base}/mcp`, "--var", "STORAGE:kv",
    "--var", `EXPORT_TOKEN:${exportToken}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: true }
);
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

function stop() {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
  rmSync(state, { recursive: true, force: true });
}

function run(script, ...args) {
  return new Promise((resolve) => {
    spawn(process.execPath, [script, base, ...(args.length ? args : [passphrase])], { stdio: "inherit" }).on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/.well-known/oauth-authorization-server`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let code = 1;
try {
  if (!(await waitForServer())) {
    console.error(`wrangler dev did not start on ${base}:\n${log}`);
  } else {
    code = (await run("scripts/e2e.mjs")) || (await run("scripts/elicit.mjs")) || (await run("scripts/export.mjs", exportToken)) || (await run("scripts/categories.mjs", passphrase, exportToken));
    if (code) console.error(`\nwrangler dev log:\n${log}`);
  }
} finally {
  stop();
}
process.exit(code);
