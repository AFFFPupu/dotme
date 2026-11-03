import { describe, expect, it } from "vitest";
import { applyProposal, cleanLine, newId, parsePreferences, serializePreferences } from "../src/prefs";
import type { Preference, Proposal } from "../src/prefs";

const sample = `# coding

- Prefer Cloudflare over Supabase for personal projects.
  id: p-3f9a0001 · when: personal projects · since: 2026-10-29 · by: grok-bot
- Use TypeScript strict mode.
  id: p-3f9a0002 · since: 2026-10-30 · by: claude-code
`;

const pref = (id: string, text: string, extra: Partial<Preference> = {}): Preference => ({ id, text, since: "2026-10-29", by: "test", ...extra });

const proposal = (extra: Partial<Proposal>): Proposal => ({
  id: "q-00000001",
  category: "coding",
  op: "add",
  evidence: "said so on 2026-10-29",
  by: "agent",
  createdAt: "2026-10-29T00:00:00.000Z",
  ...extra,
});

describe("parsePreferences", () => {
  it("reads items and their metadata", () => {
    expect(parsePreferences(sample)).toEqual([
      { id: "p-3f9a0001", text: "Prefer Cloudflare over Supabase for personal projects.", when: "personal projects", since: "2026-10-29", by: "grok-bot" },
      { id: "p-3f9a0002", text: "Use TypeScript strict mode.", when: undefined, since: "2026-10-30", by: "claude-code" },
    ]);
  });

  it("returns nothing for an empty or heading-only file", () => {
    expect(parsePreferences("")).toEqual([]);
    expect(parsePreferences("# coding\n\nSome notes that are not list items.\n")).toEqual([]);
  });

  it("keeps an item without a metadata line", () => {
    expect(parsePreferences("- Hand-written preference\n- Another one\n")).toEqual([
      { id: "", text: "Hand-written preference", when: undefined, since: "", by: "" },
      { id: "", text: "Another one", when: undefined, since: "", by: "" },
    ]);
  });

  it("keeps colons inside a field value", () => {
    const [p] = parsePreferences("- Text\n  id: p-1 · when: repo: dotme · since: 2026-10-29 · by: a\n");
    expect(p.when).toBe("repo: dotme");
  });

  it("reads files with Windows line endings", () => {
    // A file edited on Windows and pushed to the data repo must not read as empty,
    // or the next approval would rewrite it with only the new preference.
    expect(parsePreferences(sample.replace(/\n/g, "\r\n"))).toEqual(parsePreferences(sample));
  });
});

describe("serializePreferences", () => {
  it("writes the documented format", () => {
    const out = serializePreferences("coding", [pref("p-1", "First", { when: "work" }), pref("p-2", "Second")]);
    expect(out).toBe(`# coding

- First
  id: p-1 · when: work · since: 2026-10-29 · by: test
- Second
  id: p-2 · since: 2026-10-29 · by: test
`);
  });

  it("round-trips through parsePreferences", () => {
    const prefs = parsePreferences(sample);
    expect(parsePreferences(serializePreferences("coding", prefs))).toEqual(prefs);
    expect(serializePreferences("coding", prefs)).toBe(sample);
  });

  it("writes an empty category as just the heading", () => {
    expect(serializePreferences("life", [])).toBe("# life\n\n\n");
    expect(parsePreferences(serializePreferences("life", []))).toEqual([]);
  });
});

describe("applyProposal", () => {
  const prefs = [pref("p-1", "One"), pref("p-2", "Two"), pref("p-3", "Three")];

  it("adds a new preference at the end with a fresh id", () => {
    const next = applyProposal(prefs, proposal({ op: "add", text: "Four", by: "codex" }), "tests", "2026-11-02");
    expect(next).toHaveLength(4);
    expect(next.slice(0, 3)).toEqual(prefs);
    expect(next[3]).toMatchObject({ text: "Four", when: "tests", since: "2026-11-02", by: "codex" });
    expect(next[3].id).toMatch(/^p-[0-9a-f]{8}$/);
  });

  it("changes a preference in place and keeps its id", () => {
    const next = applyProposal(prefs, proposal({ op: "change", replaces: "p-2", text: "Two, revised" }), undefined, "2026-11-02");
    expect(next.map((p) => p.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect(next[1]).toEqual({ id: "p-2", text: "Two, revised", when: undefined, since: "2026-11-02", by: "agent" });
  });

  it("removes only the targeted preference", () => {
    expect(applyProposal(prefs, proposal({ op: "remove", replaces: "p-2" }), undefined, "2026-11-02")).toEqual([prefs[0], prefs[2]]);
  });

  it("leaves the list alone when the target is gone", () => {
    expect(applyProposal(prefs, proposal({ op: "remove", replaces: "p-9" }), undefined, "2026-11-02")).toEqual(prefs);
    expect(applyProposal(prefs, proposal({ op: "change", replaces: "p-9", text: "x" }), undefined, "2026-11-02")).toEqual(prefs);
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(prefs);
    applyProposal(prefs, proposal({ op: "change", replaces: "p-1", text: "x" }), undefined, "2026-11-02");
    expect(prefs).toEqual(copy);
  });
});

describe("cleanLine", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanLine("  a\n\tb   c  ", 100)).toBe("a b c");
  });

  it("truncates to the limit", () => {
    expect(cleanLine("abcdef", 3)).toBe("abc");
  });

  it("removes the field separator", () => {
    expect(cleanLine("a · b", 100)).toBe("a - b");
  });

  it("stops a proposal from injecting extra items or fields", () => {
    const text = cleanLine("Harmless\n  id: p-evil · since: x · by: owner\n- Injected preference", 300);
    const when = cleanLine("work · by: owner", 120);
    const parsed = parsePreferences(serializePreferences("coding", [pref("p-1", text, { when })]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "p-1", by: "test", text, when });
  });
});

describe("newId", () => {
  it("makes prefixed random ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId("q")));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^q-[0-9a-f]{8}$/);
  });
});
