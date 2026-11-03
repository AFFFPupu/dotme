// Installs the dotme SessionStart hook for Codex by hand. Codex 0.164 and later
// no longer run hooks inside plugins, so the hook has to live in
// ~/.codex/hooks.json. This copies clients/shared/session-start.sh to
// ~/.config/dotme/session-start.sh and merges one entry into hooks.json:
// it keeps every other hook, never adds a second dotme entry, refuses to touch
// a file it cannot parse, and backs the file up before changing it.
// It reads no token and prints none; the hook reads ~/.config/dotme/auth-header itself.
//
// Usage: node scripts/codex-hook.mjs [--check | --remove] [--dry-run]
//   (no flag)   install or update the hook
//   --check     report whether it is installed; exit 1 if not
//   --remove    take the dotme entry out of hooks.json
//   --dry-run   print the hooks.json that would be written, change nothing
// CODEX_HOME and DOTME_DIR move ~/.codex and ~/.config/dotme, as in Codex and the hook.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const known = new Set(["--check", "--remove", "--dry-run"]);
for (const arg of args) if (!known.has(arg)) fail(`Unknown option ${arg}. Use --check, --remove or --dry-run.`);
if (args.has("--check") && args.has("--remove")) fail("Use --check or --remove, not both.");

const home = homedir();
const codexHome = process.env.CODEX_HOME || join(home, ".codex");
const dotmeDir = process.env.DOTME_DIR || join(home, ".config", "dotme");
const hooksPath = join(codexHome, "hooks.json");
const scriptPath = join(dotmeDir, "session-start.sh");
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../clients/shared/session-start.sh");
// Written with ~ when the script sits in the default place, so the entry reads the same on every Mac.
const command = `sh ${scriptPath.startsWith(`${home}/`) ? `~/${scriptPath.slice(home.length + 1)}` : JSON.stringify(scriptPath)}`;
const entry = { hooks: [{ type: "command", command, statusMessage: "Loading dotme preferences" }] };

function fail(message) {
  console.error(`codex-hook: ${message}`);
  process.exit(2);
}

// A hook is ours when its command runs a dotme session-start.sh, wherever it was copied to.
const isDotme = (hook) => typeof hook?.command === "string" && /dotme/.test(hook.command) && /session-start\.sh/.test(hook.command);

function readHooks() {
  if (!existsSync(hooksPath)) return { hooks: {} };
  const raw = readFileSync(hooksPath, "utf8");
  let parsed;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (error) {
    fail(`${hooksPath} is not valid JSON (${error.message}). Fix it by hand; nothing was changed.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${hooksPath} is not a JSON object; nothing was changed.`);
  if (parsed.hooks === undefined) parsed.hooks = {};
  if (parsed.hooks === null || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) fail(`"hooks" in ${hooksPath} is not an object; nothing was changed.`);
  const start = parsed.hooks.SessionStart;
  if (start !== undefined && !Array.isArray(start)) fail(`"hooks.SessionStart" in ${hooksPath} is not a list; nothing was changed.`);
  return parsed;
}

// Every SessionStart group with the dotme hooks taken out; groups left empty are dropped.
function withoutDotme(groups) {
  const kept = [];
  let removed = 0;
  for (const group of groups) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : null;
    if (!hooks) {
      kept.push(group);
      continue;
    }
    const rest = hooks.filter((hook) => !isDotme(hook));
    removed += hooks.length - rest.length;
    if (rest.length > 0) kept.push(rest.length === hooks.length ? group : { ...group, hooks: rest });
  }
  return { kept, removed };
}

const config = readHooks();
const groups = config.hooks.SessionStart ?? [];
const found = groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).filter(isDotme);

if (args.has("--check")) {
  const scriptOk = existsSync(scriptPath) && readFileSync(scriptPath, "utf8") === readFileSync(source, "utf8");
  if (found.length === 1 && scriptOk) {
    console.log(`ok: ${hooksPath} runs ${found[0].command}`);
    process.exit(0);
  }
  if (found.length === 0) console.log(`missing: no dotme SessionStart hook in ${hooksPath}`);
  if (found.length > 1) console.log(`duplicate: ${found.length} dotme hooks in ${hooksPath}; preferences load more than once. Run this script again to keep one.`);
  if (!existsSync(scriptPath)) console.log(`missing: ${scriptPath}`);
  else if (!scriptOk) console.log(`outdated: ${scriptPath} differs from clients/shared/session-start.sh`);
  process.exit(1);
}

const { kept, removed } = withoutDotme(groups);
const next = { ...config, hooks: { ...config.hooks } };
if (args.has("--remove")) {
  if (kept.length > 0) next.hooks.SessionStart = kept;
  else delete next.hooks.SessionStart;
} else if (!(found.length === 1 && found[0].command === command)) {
  // Already installed with this command: leave the file as it is, even where the entry sits.
  next.hooks.SessionStart = [...kept, entry];
}
const text = `${JSON.stringify(next, null, 2)}\n`;
const before = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;

if (args.has("--dry-run")) {
  process.stdout.write(text);
  process.exit(0);
}

if (!args.has("--remove")) {
  mkdirSync(dotmeDir, { recursive: true, mode: 0o700 });
  copyFileSync(source, scriptPath);
  chmodSync(scriptPath, 0o755);
  console.log(`copied the hook to ${scriptPath}`);
}

if (args.has("--remove") && removed === 0) {
  console.log(`${hooksPath} has no dotme hook; not changed.`);
} else if (before === text) {
  console.log(`${hooksPath} already has the dotme hook; not changed.`);
} else {
  mkdirSync(codexHome, { recursive: true });
  if (before !== null) {
    const stamp = `${hooksPath}.bak-dotme-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
    let backup = stamp;
    for (let n = 2; existsSync(backup); n++) backup = `${stamp}-${n}`;
    writeFileSync(backup, before);
    console.log(`backed up the old file to ${backup}`);
  }
  const temp = `${hooksPath}.tmp-dotme`;
  writeFileSync(temp, text);
  renameSync(temp, hooksPath);
  if (args.has("--remove")) console.log(`removed the dotme hook from ${hooksPath}`);
  else console.log(`${removed > 0 ? "updated" : "added"} the dotme hook in ${hooksPath}`);
  if (!args.has("--remove")) console.log("Start a new Codex session and trust the hook when Codex asks.");
}
