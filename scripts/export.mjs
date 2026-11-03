// Check /export against a running server, and the SessionStart hook that reads it.
// Usage: node scripts/export.mjs [baseUrl] [exportToken]
// The local server needs EXPORT_TOKEN in .dev.vars (default here: local-export-token).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:8787";
const token = process.argv[3] ?? "local-export-token";
const get = async (path, auth = token) => {
  const res = await fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  return [res.status, await res.text()];
};
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

check("no token: 401", (await get("/export", ""))[0] === 401);
check("wrong token: 401", (await get("/export", "wrong"))[0] === 401);
const [status, body] = await get("/export");
check("default categories are collab and coding", status === 200 && body.startsWith("## collab\n") && body.includes("\n## coding\n") && !body.includes("## life"));
const [, picked] = await get("/export?categories=life,collab,life");
check("picked categories in order, no duplicates", picked.startsWith("## life\n") && picked.split("## life").length === 2 && picked.includes("## collab"));
check("unknown category: 400", (await get("/export?categories=collab,nope"))[0] === 400);
check("empty categories: 400", (await get("/export?categories="))[0] === 400);
check("legacy /export/collab.md: 200", (await get("/export/collab.md"))[0] === 200);

const dir = mkdtempSync(join(tmpdir(), "dotme-hook-"));
writeFileSync(join(dir, "url"), `${base}/mcp\n`);
writeFileSync(join(dir, "auth-header"), `Authorization: Bearer ${token}\n`, { mode: 0o600 });
const hook = (env = {}) => execFileSync("sh", ["clients/shared/session-start.sh"], { env: { ...process.env, DOTME_DIR: dir, ...env }, encoding: "utf8" });
check("hook fetches", hook().includes("(fetched at session start)"));
check("hook takes the Claude Code option", hook({ CLAUDE_PLUGIN_OPTION_CATEGORIES: "life" }).includes("## life"));
check("hook falls back to its cache", hook({ DOTME_URL: "http://127.0.0.1:9" }).includes("server unreachable; last copy from"));
