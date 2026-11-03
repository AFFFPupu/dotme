#!/usr/bin/env node
// Prints what the user typed in recent Claude Code and Codex sessions, for the dotme-review skill.
// Only the user's own messages are printed: no agent replies, no tool output, and none of the
// context a client injects as a user message (hook output, AGENTS.md, environment details).
// It reads local transcript files and sends nothing anywhere.
// Usage: node recent-messages.mjs [--days 7] [--client claude|codex|all] [--max-chars 400] [--limit 300]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Text a client puts in a user message that the user did not type.
const INJECTED = [/^</, /^Caveat: /, /^# AGENTS\.md instructions/, /^\[Request interrupted/, /^This session is being continued/];
const typedByUser = (text) => text.trim() !== "" && !INJECTED.some((pattern) => pattern.test(text.trimStart()));

const parse = (lines) =>
  lines.flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl, one record per line.
export function claudeMessages(lines) {
  const out = [];
  for (const record of parse(lines)) {
    if (record.type !== "user" || record.isMeta || record.isSidechain || record.message?.role !== "user") continue;
    const content = record.message.content;
    // A list holds tool results (not typed by the user) and sometimes text blocks (typed).
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text) : [];
    for (const text of parts) if (typeof text === "string" && typedByUser(text)) out.push({ time: record.timestamp, cwd: record.cwd, text });
  }
  return out;
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Newer versions log each prompt as an
// event_msg user_message; older ones only as a response_item message with role "user".
export function codexMessages(lines) {
  const records = parse(lines);
  const cwd = records.find((r) => r.type === "session_meta")?.payload?.cwd;
  const events = records.filter((r) => r.type === "event_msg" && r.payload?.type === "user_message");
  const out = [];
  if (events.length) {
    for (const r of events) if (typeof r.payload.message === "string" && typedByUser(r.payload.message)) out.push({ time: r.timestamp, cwd, text: r.payload.message });
    return out;
  }
  for (const r of records) {
    const p = r.payload;
    if (r.type !== "response_item" || p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) continue;
    for (const c of p.content) if (c?.type === "input_text" && typeof c.text === "string" && typedByUser(c.text)) out.push({ time: r.timestamp, cwd, text: c.text });
  }
  return out;
}

function jsonlFiles(dir, depth) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...jsonlFiles(path, depth - 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

const oneLine = (text, max) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

export function collect({ days = 7, client = "all", maxChars = 400, limit = 300, claudeDir, codexDir, now = Date.now() } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const sources = [];
  // Claude Code keeps subagent transcripts in a folder per session; depth 1 skips them.
  if (client !== "codex") sources.push({ name: "Claude Code", files: jsonlFiles(join(claudeDir, "projects"), 1), read: claudeMessages });
  if (client !== "claude") sources.push({ name: "Codex", files: jsonlFiles(join(codexDir, "sessions"), 3), read: codexMessages });

  const sessions = [];
  for (const source of sources) {
    for (const file of source.files) {
      if (statSync(file).mtimeMs < since) continue;
      const messages = source.read(readFileSync(file, "utf8").split("\n")).filter((m) => !m.time || Date.parse(m.time) >= since);
      if (messages.length) sessions.push({ client: source.name, file, messages });
    }
  }
  sessions.sort((a, b) => (a.messages[0].time ?? "").localeCompare(b.messages[0].time ?? ""));

  // Keep the newest messages when there are more than the limit.
  let budget = limit;
  const kept = [];
  for (const session of sessions.reverse()) {
    if (budget <= 0) break;
    const messages = session.messages.slice(-budget);
    budget -= messages.length;
    kept.unshift({ ...session, messages });
  }

  const lines = [];
  for (const s of kept) {
    const first = s.messages[0];
    lines.push(`## ${s.client} · ${(first.time ?? "").slice(0, 10) || "unknown date"} · ${first.cwd ?? "unknown folder"} · ${basename(s.file, ".jsonl")}`);
    for (const m of s.messages) lines.push(`- ${(m.time ?? "").slice(11, 16) || "--:--"} ${oneLine(m.text, maxChars)}`);
    lines.push("");
  }
  const total = sessions.reduce((n, s) => n + s.messages.length, 0);
  const shown = kept.reduce((n, s) => n + s.messages.length, 0);
  const header = `# Your messages from the last ${days} day(s): ${shown} of ${total} in ${kept.length} session(s)`;
  return [header, "", ...(lines.length ? lines : ["No messages found.", ""])].join("\n");
}

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const number = (name, fallback) => {
    const value = Number(flag(name, fallback));
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`--${name} must be a positive number`);
      process.exit(2);
    }
    return value;
  };
  const client = flag("client", "all");
  if (!["claude", "codex", "all"].includes(client)) {
    console.error("--client must be claude, codex or all");
    process.exit(2);
  }
  process.stdout.write(
    collect({
      days: number("days", 7),
      client,
      maxChars: number("max-chars", 400),
      limit: number("limit", 300),
      claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      codexDir: process.env.CODEX_HOME || join(homedir(), ".codex"),
    })
  );
}
