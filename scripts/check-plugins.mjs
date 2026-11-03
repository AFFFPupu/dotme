// Checks the client plugins: every manifest is valid JSON, each plugin's copy
// of the SessionStart hook matches clients/shared/session-start.sh, and each
// plugin's skills/ folder matches clients/shared/skills/.
// Plugins are copied into each client's cache on install, so each one needs
// its own copy. After editing a shared file, run: npm run sync:plugins
// Usage: node scripts/check-plugins.mjs [--fix]
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const shared = "clients/shared/session-start.sh";
const plugins = ["clients/claude-code", "clients/codex"];
const sharedSkills = "clients/shared/skills";
const fix = process.argv.includes("--fix");
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
// Every [source, copy] pair: the hook script, then each file under shared/skills.
const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()) : [];
const skillFiles = filesUnder(sharedSkills);
const pairs = plugins.flatMap((plugin) => [
  [shared, `${plugin}/scripts/session-start.sh`],
  ...skillFiles.map((f) => [join(sharedSkills, f), join(plugin, "skills", f)]),
]);

for (const [source, path] of pairs) {
  if (existsSync(path) && readFileSync(path, "utf8") === readFileSync(source, "utf8")) continue;
  if (fix) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
    if (path.endsWith(".sh") || path.endsWith(".mjs")) chmodSync(path, 0o755);
    console.log(`updated ${path}`);
  } else {
    console.error(`${path} differs from ${source}; run npm run sync:plugins`);
    failed = true;
  }
}

// A file in a plugin's skills/ that is no longer in shared/skills.
for (const plugin of plugins) {
  const dir = join(plugin, "skills");
  for (const f of filesUnder(dir)) {
    if (skillFiles.includes(f)) continue;
    const path = join(dir, f);
    if (fix) {
      rmSync(path);
      console.log(`removed ${path}`);
    } else {
      console.error(`${path} is not in ${sharedSkills}; run npm run sync:plugins`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("plugins ok");
