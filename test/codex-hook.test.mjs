// scripts/codex-hook.mjs against throwaway CODEX_HOME and DOTME_DIR folders.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

let codexHome;
let dotmeDir;
const hooksPath = () => join(codexHome, "hooks.json");
const run = (...args) => {
  const result = spawnSync("node", ["scripts/codex-hook.mjs", ...args], { env: { ...process.env, CODEX_HOME: codexHome, DOTME_DIR: dotmeDir }, encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
};
const commands = () => JSON.parse(readFileSync(hooksPath(), "utf8")).hooks.SessionStart?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
const backups = () => readdirSync(codexHome).filter((f) => f.includes(".bak-dotme-"));

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "dotme-codex-hook-"));
  codexHome = join(root, "codex");
  dotmeDir = join(root, "dotme");
});

describe("codex-hook", () => {
  it("installs into a fresh CODEX_HOME and copies the script", () => {
    expect(run("--check").code).toBe(1);
    expect(run().code).toBe(0);
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain(join(dotmeDir, "session-start.sh"));
    expect(readFileSync(join(dotmeDir, "session-start.sh"), "utf8")).toBe(readFileSync("clients/shared/session-start.sh", "utf8"));
    expect(run("--check").code).toBe(0);
  });

  it("keeps other hooks and settings, replaces an older dotme entry, and backs up", () => {
    const old = { other: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }], SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }, { type: "command", command: "sh ~/.config/dotme/session-start.sh" }] }] } };
    run(); // creates the folders
    writeFileSync(hooksPath(), JSON.stringify(old));
    expect(run().code).toBe(0);
    const now = JSON.parse(readFileSync(hooksPath(), "utf8"));
    expect(now.other).toBe(true);
    expect(now.hooks.Stop).toEqual(old.hooks.Stop);
    expect(commands()).toEqual(["echo hi", expect.stringContaining(join(dotmeDir, "session-start.sh"))]);
    expect(backups()).toHaveLength(1);
  });

  it("does nothing on a second run", () => {
    run();
    const before = readFileSync(hooksPath(), "utf8");
    expect(run().out).toContain("not changed");
    expect(readFileSync(hooksPath(), "utf8")).toBe(before);
    expect(backups()).toHaveLength(0);
  });

  it("refuses a file it cannot parse and leaves it alone", () => {
    run();
    writeFileSync(hooksPath(), "{not json");
    expect(run().code).toBe(2);
    expect(readFileSync(hooksPath(), "utf8")).toBe("{not json");
  });

  it("removes only its own entry", () => {
    run();
    const config = JSON.parse(readFileSync(hooksPath(), "utf8"));
    config.hooks.SessionStart.unshift({ hooks: [{ type: "command", command: "echo keep" }] });
    writeFileSync(hooksPath(), JSON.stringify(config));
    expect(run("--remove").code).toBe(0);
    expect(commands()).toEqual(["echo keep"]);
    expect(run("--remove").out).toContain("no dotme hook");
  });

  it("dry run changes nothing", () => {
    expect(run("--dry-run").code).toBe(0);
    expect(existsSync(hooksPath())).toBe(false);
  });
});
