import { beforeEach, describe, expect, it } from "vitest";
import { approve, conflictsWith, decide, ProposalError, getPreferences, getProposal, listCategories, listPending, propose, reject } from "../src/dotme";
import { isCategoryName } from "../src/prefs";
import type { Proposal } from "../src/prefs";
import type { Store } from "../src/store";
import { memoryStore } from "./memory-store";

const input = (extra: Partial<Proposal> = {}) => ({
  category: "coding",
  op: "add" as const,
  text: "Prefer Cloudflare over Supabase",
  evidence: "user said so on 2026-10-29",
  by: "claude-code",
  ...extra,
});

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
});

describe("propose", () => {
  it("stores a pending proposal without touching the preferences", async () => {
    const p = await propose(store, input());
    expect(p.id).toMatch(/^q-[0-9a-f]{8}$/);
    expect(JSON.parse(store.files.get(`pending/${p.id}.json`)!)).toEqual(p);
    expect(store.files.has("coding.md")).toBe(false);
  });

  it("refuses to change or remove a preference that does not exist", async () => {
    await expect(propose(store, input({ op: "change", replaces: "p-00000000" }))).rejects.toThrow("No preference p-00000000 in coding");
    await expect(propose(store, input({ op: "remove", replaces: "p-00000000", text: undefined }))).rejects.toThrow();
    expect(await store.list("pending")).toEqual([]);
  });

  it("requires text to add or change", async () => {
    await expect(propose(store, input({ text: undefined }))).rejects.toThrow("text is required");
  });

  it("allows removing without text", async () => {
    await approve(store, (await propose(store, input())).id, undefined);
    const [existing] = await getPreferences(store, "coding");
    await expect(propose(store, input({ op: "remove", replaces: existing.id, text: undefined }))).resolves.toMatchObject({ op: "remove" });
  });
});

describe("approve", () => {
  it("writes the preference, closes the proposal and records who and why", async () => {
    const p = await propose(store, input());
    await approve(store, p.id, "personal projects");
    const [saved] = await getPreferences(store, "coding");
    expect(saved).toMatchObject({ text: "Prefer Cloudflare over Supabase", when: "personal projects", by: "claude-code" });
    expect(await getProposal(store, p.id)).toBeNull();
    const commit = store.messages.find((m) => m.startsWith("add coding:"))!;
    expect(commit).toContain(`Proposed by claude-code (${p.id})`);
    expect(commit).toContain("Scope: personal projects");
    expect(commit).toContain("Evidence: user said so on 2026-10-29");
  });

  it("applies change and remove to the existing file", async () => {
    await approve(store, (await propose(store, input({ text: "One" }))).id, undefined);
    await approve(store, (await propose(store, input({ text: "Two" }))).id, undefined);
    const [one, two] = await getPreferences(store, "coding");
    await approve(store, (await propose(store, input({ op: "change", replaces: one.id, text: "One, revised" }))).id, undefined);
    await approve(store, (await propose(store, input({ op: "remove", replaces: two.id, text: undefined }))).id, undefined);
    expect((await getPreferences(store, "coding")).map((p) => [p.id, p.text])).toEqual([[one.id, "One, revised"]]);
  });

  it("keeps hand-written preferences in the file", async () => {
    store.files.set("coding.md", "# coding\r\n\r\n- Written by hand on Windows\r\n  id: p-0000aaaa · since: 2026-10-01 · by: owner\r\n");
    await approve(store, (await propose(store, input())).id, undefined);
    expect((await getPreferences(store, "coding")).map((p) => p.text)).toEqual(["Written by hand on Windows", "Prefer Cloudflare over Supabase"]);
  });

  it("re-reads and re-applies when the file changed in between", async () => {
    const p = await propose(store, input({ text: "Mine" }));
    // Another approval lands between our read and our write.
    store.beforeWrite = (path) => {
      if (path !== "coding.md") return;
      store.beforeWrite = undefined;
      store.files.set("coding.md", "# coding\n\n- Theirs\n  id: p-0000bbbb · since: 2026-10-01 · by: other\n");
    };
    await approve(store, p.id, undefined);
    expect((await getPreferences(store, "coding")).map((p) => p.text)).toEqual(["Theirs", "Mine"]);
    expect(await getProposal(store, p.id)).toBeNull();
  });

  it("gives up after repeated conflicts and keeps the proposal open", async () => {
    const p = await propose(store, input());
    let n = 0;
    store.beforeWrite = (path) => {
      if (path === "coding.md") store.files.set("coding.md", `# coding\n\n- Change ${n++}\n  id: p-0000000${n} · since: 2026-10-01 · by: other\n`);
    };
    await expect(approve(store, p.id, undefined)).rejects.toThrow("kept changing");
    expect(n).toBe(3);
    expect(await getProposal(store, p.id)).not.toBeNull();
  });

  it("fails for an unknown proposal", async () => {
    await expect(approve(store, "q-00000000", undefined)).rejects.toThrow(ProposalError);
    await expect(approve(store, "q-00000000", undefined)).rejects.toThrow("Proposal not found");
  });

  it("refuses a change whose preference another approval removed, and keeps it open", async () => {
    await approve(store, (await propose(store, input())).id, undefined);
    const [existing] = await getPreferences(store, "coding");
    const change = await propose(store, input({ op: "change", replaces: existing.id, text: "Revised" }));
    await approve(store, (await propose(store, input({ op: "remove", replaces: existing.id, text: undefined }))).id, undefined);
    await expect(approve(store, change.id, undefined)).rejects.toThrow(`(${existing.id}) is no longer in coding`);
    expect(await getPreferences(store, "coding")).toEqual([]);
    expect(await getProposal(store, change.id)).not.toBeNull();
  });
});

describe("reject", () => {
  it("closes the proposal without saving anything", async () => {
    const p = await propose(store, input());
    await reject(store, p.id);
    expect(await getProposal(store, p.id)).toBeNull();
    expect(await getPreferences(store, "coding")).toEqual([]);
  });

  it("ignores an unknown proposal", async () => {
    await expect(reject(store, "q-00000000")).resolves.toBeUndefined();
  });
});

describe("getProposal", () => {
  it("only accepts well-formed ids", async () => {
    const reads: string[] = [];
    const spy: Store = { ...store, read: async (path) => (reads.push(path), store.read(path)) };
    for (const id of ["../coding", "q-1234", "q-0000000g", "q-00000000/../../x", ""]) expect(await getProposal(spy, id)).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("listPending", () => {
  it("returns proposals for the given categories, oldest first", async () => {
    const write = (p: Partial<Proposal> & { id: string }) => store.write(`pending/${p.id}.json`, JSON.stringify({ ...input(), ...p }), null, "");
    await write({ id: "q-00000003", createdAt: "2026-10-03T00:00:00Z" });
    await write({ id: "q-00000001", createdAt: "2026-10-01T00:00:00Z" });
    await write({ id: "q-00000002", createdAt: "2026-10-02T00:00:00Z", category: "life" });
    expect((await listPending(store, ["coding"])).map((p) => p.id)).toEqual(["q-00000001", "q-00000003"]);
    expect((await listPending(store, ["coding", "life"])).map((p) => p.id)).toEqual(["q-00000001", "q-00000002", "q-00000003"]);
    expect(await listPending(store, ["collab"])).toEqual([]);
  });
});

describe("conflictsWith", () => {
  const p = (id: string, extra: Partial<Proposal>): Proposal => ({ ...input(), id, createdAt: "", ...extra });

  it("finds other open proposals for the same preference", () => {
    const mine = p("q-1", { op: "change", replaces: "p-1" });
    const pending = [
      mine,
      p("q-2", { op: "remove", replaces: "p-1" }),
      p("q-3", { op: "change", replaces: "p-2" }),
      p("q-4", { op: "change", replaces: "p-1", category: "life" }),
      p("q-5", { op: "add" }),
    ];
    expect(conflictsWith(mine, pending).map((c) => c.id)).toEqual(["q-2"]);
  });

  it("never treats two additions as a conflict", () => {
    const pending = [p("q-1", { op: "add" }), p("q-2", { op: "add" })];
    expect(conflictsWith(pending[0], pending)).toEqual([]);
  });
});

describe("listCategories", () => {
  it("starts with the defaults before any file exists", async () => {
    expect(await listCategories(store)).toEqual(["collab", "coding", "life"]);
  });

  it("adds each lowercase Markdown file at the root, after the defaults", async () => {
    for (const path of ["work.md", "coding.md", "health.md", "README.md", "notes.txt", "pending/q-00000001.json", "archive/old.md", "Bad Name.md"]) {
      store.files.set(path, "# x\n");
    }
    expect(await listCategories(store)).toEqual(["collab", "coding", "life", "health", "work"]);
  });
});

describe("listPending without categories", () => {
  it("returns every open proposal, for the owner", async () => {
    await propose(store, input());
    await propose(store, input({ category: "work" }));
    expect((await listPending(store)).map((p) => p.category).sort()).toEqual(["coding", "work"]);
  });
});

describe("propose to a new category", () => {
  it("creates the category file on approval", async () => {
    await approve(store, (await propose(store, input({ category: "work" }))).id, undefined);
    expect(store.files.get("work.md")).toMatch(/^# work\n/);
    expect(await listCategories(store)).toContain("work");
  });

  it("refuses names that are not plain lowercase file names", async () => {
    for (const category of ["../coding", "pending/x", "Coding", ""]) {
      await expect(propose(store, input({ category }))).rejects.toThrow("Invalid category name");
    }
  });
});

describe("isCategoryName", () => {
  it("accepts only plain lowercase names", () => {
    expect(isCategoryName("coding")).toBe(true);
    expect(isCategoryName("side-projects")).toBe(true);
    expect(isCategoryName("Coding")).toBe(false);
    expect(isCategoryName("README")).toBe(false);
    expect(isCategoryName("../coding")).toBe(false);
    expect(isCategoryName("-x")).toBe(false);
    expect(isCategoryName(undefined)).toBe(false);
  });
});

describe("decide", () => {
  it("approves a whole batch as one commit that lists every proposal", async () => {
    const ids = [];
    for (let i = 0; i < 16; i++) ids.push((await propose(store, input({ category: i % 2 ? "coding" : "life", text: `Pref ${i}`, by: `agent-${i}` }))).id);
    const before = store.commits.length;
    const result = await decide(store, "approve", ids);
    expect(result.done).toHaveLength(16);
    expect(store.commits.length - before).toBe(1);
    const [commit] = store.commits.slice(before);
    expect(commit.paths.sort()).toEqual(["coding.md", "life.md", ...ids.map((id) => `pending/${id}.json`)].sort());
    expect(commit.message.split("\n")[0]).toBe("Approve 16 proposals");
    expect(commit.message).toContain(`- add life: Pref 0\n  Proposed by agent-0 (${ids[0]}), approved by the owner.\n  Evidence: user said so on 2026-10-29`);
    expect((await getPreferences(store, "coding")).map((p) => p.text)).toEqual(["Pref 1", "Pref 3", "Pref 5", "Pref 7", "Pref 9", "Pref 11", "Pref 13", "Pref 15"]);
    expect(await listPending(store)).toEqual([]);
  });

  it("keeps the single-approval commit message and closes the proposal in the same commit", async () => {
    const p = await propose(store, input());
    await approve(store, p.id, "work");
    const last = store.commits.at(-1)!;
    expect(last.paths).toEqual(["coding.md", `pending/${p.id}.json`]);
    expect(last.message).toBe(`add coding: Prefer Cloudflare over Supabase\n\nProposed by claude-code (${p.id}), approved by the owner.\nScope: work\nEvidence: user said so on 2026-10-29`);
  });

  it("saves each approval with the scope it was proposed with", async () => {
    const p = await propose(store, input({ when: "personal projects" }));
    await decide(store, "approve", [p.id]);
    expect((await getPreferences(store, "coding"))[0].when).toBe("personal projects");
  });

  it("skips conflicts, counts gone ones and keeps failed ones open", async () => {
    await approve(store, (await propose(store, input({ text: "Old" }))).id, undefined);
    await approve(store, (await propose(store, input({ text: "Gone soon" }))).id, undefined);
    const [old, gone] = await getPreferences(store, "coding");
    const change = await propose(store, input({ op: "change", replaces: old.id, text: "New" }));
    const remove = await propose(store, input({ op: "remove", replaces: old.id, text: undefined }));
    const stale = await propose(store, input({ op: "change", replaces: gone.id, text: "Too late" }));
    await approve(store, (await propose(store, input({ op: "remove", replaces: gone.id, text: undefined }))).id, undefined);
    const add = await propose(store, input({ text: "Fresh" }));
    const result = await decide(store, "approve", [change.id, remove.id, stale.id, add.id, "q-00000000", "../x"]);
    expect(result.done).toEqual([add.id]);
    expect(result.skipped.sort()).toEqual([change.id, remove.id].sort());
    expect(result.failed.map((f) => f.id)).toEqual([stale.id]);
    expect(result.gone).toEqual(["q-00000000", "../x"]);
    expect((await listPending(store)).map((p) => p.id).sort()).toEqual([change.id, remove.id, stale.id].sort());
  });

  it("rejects a batch as one commit", async () => {
    const ids = [(await propose(store, input())).id, (await propose(store, input())).id];
    const before = store.commits.length;
    expect((await decide(store, "reject", ids)).done).toHaveLength(2);
    expect(store.commits.length - before).toBe(1);
    expect(store.commits.at(-1)!.message).toBe(`Reject 2 proposals\n\n- Close proposal ${ids[0]}: rejected\n\n- Close proposal ${ids[1]}: rejected`);
    expect(await listPending(store)).toEqual([]);
  });

  it("commits nothing when nothing could be decided", async () => {
    const before = store.messages.length;
    expect(await decide(store, "approve", ["q-00000000"])).toMatchObject({ done: [], gone: ["q-00000000"] });
    expect(store.messages.length).toBe(before);
  });
});
