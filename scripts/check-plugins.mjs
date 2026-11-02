// Checks the client plugins: every manifest is valid JSON, and each plugin's
// copy of the SessionStart hook matches clients/shared/session-start.sh.
// Plugins are copied into each client's cache on install, so each one needs
// its own copy. After editing the shared script, run: npm run sync:plugins
// Usage: node scripts/check-plugins.mjs [--fix]
import { copyFileSync, chmodSync, readFileSync } from "node:fs";

const shared = "clients/shared/session-start.sh";
const copies = ["clients/claude-code/scripts/session-start.sh", "clients/codex/scripts/session-start.sh"];
const json = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "clients/claude-code/.claude-plugin/plugin.json",
  "clients/claude-code/.mcp.json",
  "clients/claude-code/hooks/hooks.json",
  "clients/codex/plugin.json",
  "clients/codex/hooks/hooks.json",
];

let failed = false;
for (const path of json) {
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    failed = true;
  }
}
const source = readFileSync(shared, "utf8");
for (const path of copies) {
  if (readFileSync(path, "utf8") === source) continue;
  if (process.argv.includes("--fix")) {
    copyFileSync(shared, path);
    chmodSync(path, 0o755);
    console.log(`updated ${path}`);
  } else {
    console.error(`${path} differs from ${shared}; run npm run sync:plugins`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("plugins ok");
