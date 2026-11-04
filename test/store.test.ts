import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStore } from "../src/store";

// Just enough of KVNamespace for the KV store.
function fakeKV() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  } as unknown as KVNamespace & { data: Map<string, string> };
}

describe("KV store", () => {
  it("writes conditionally on the current sha", async () => {
    const store = makeStore({ STORAGE: "kv", OAUTH_KV: fakeKV() });
    expect(await store.write("coding.md", "one", null, "")).toBe(true);
    expect(await store.write("coding.md", "again", null, "")).toBe(false);
    const first = (await store.read("coding.md"))!;
    expect(first.content).toBe("one");
    expect(await store.write("coding.md", "two", first.sha, "")).toBe(true);
    expect(await store.write("coding.md", "three", first.sha, "")).toBe(false);
    expect((await store.read("coding.md"))!.content).toBe("two");
  });

  it("lists only files directly in the directory", async () => {
    const kv = fakeKV();
    const store = makeStore({ STORAGE: "kv", OAUTH_KV: kv });
    kv.data.set("grant:x", "oauth data");
    await store.write("coding.md", "c", null, "");
    await store.write("pending/q-1.json", "{}", null, "");
    await store.write("pending/q-2.json", "{}", null, "");
    await store.write("pending/old/q-0.json", "{}", null, "");
    expect((await store.list("pending")).sort()).toEqual(["pending/q-1.json", "pending/q-2.json"]);
    expect(await store.list("")).toEqual(["coding.md"]);
    await store.remove("pending/q-1.json", "", "");
    expect(await store.list("pending")).toEqual(["pending/q-2.json"]);
    expect(await store.read("missing.md")).toBeNull();
  });
});

describe("makeStore", () => {
  it("needs a GitHub token and repo outside local development", () => {
    expect(() => makeStore({ OAUTH_KV: fakeKV() })).toThrow("GITHUB_TOKEN and GITHUB_REPO must be set");
    expect(() => makeStore({ OAUTH_KV: fakeKV(), GITHUB_TOKEN: "t" })).toThrow();
  });
});

describe("KV snapshot", () => {
  it("commits many changes, and refuses if a file read changed since", async () => {
    const store = makeStore({ STORAGE: "kv", OAUTH_KV: fakeKV() });
    await store.write("coding.md", "one", null, "");
    await store.write("pending/q-1.json", "{}", null, "");
    const snap = store.snapshot();
    expect(await snap.read(["coding.md", "pending/q-1.json", "missing.md"])).toEqual(new Map([["coding.md", "one"], ["pending/q-1.json", "{}"], ["missing.md", null]]));
    expect(await snap.commit([{ path: "coding.md", content: "two" }, { path: "pending/q-1.json", content: null }], "")).toBe(true);
    expect((await store.read("coding.md"))!.content).toBe("two");
    expect(await store.read("pending/q-1.json")).toBeNull();

    const stale = store.snapshot();
    await stale.read(["coding.md"]);
    await store.write("coding.md", "three", (await store.read("coding.md"))!.sha, "");
    expect(await stale.commit([{ path: "coding.md", content: "four" }], "")).toBe(false);
    expect((await store.read("coding.md"))!.content).toBe("three");
  });
});

describe("GitHub snapshot", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Answers the calls a batch makes and records them.
  function fakeGitHub(refStatus = 200) {
    const calls: { method: string; url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? "GET", url, body });
      const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (url.endsWith("/graphql") && body.query.includes("defaultBranchRef")) {
        return reply({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "c0", tree: { oid: "t0" } } } } } });
      }
      if (url.endsWith("/graphql")) return reply({ data: { repository: { f0: { text: "# coding\n", isBinary: false, isTruncated: false }, f1: null } } });
      if (url.endsWith("/git/trees")) return reply({ sha: "t1" }, 201);
      if (url.endsWith("/git/commits")) return reply({ sha: "c1" }, 201);
      if (url.endsWith("/git/refs/heads/main")) return reply({}, refStatus);
      return reply({}, 404);
    });
    return calls;
  }
  const github = () => makeStore({ OAUTH_KV: fakeKV(), GITHUB_TOKEN: "t", GITHUB_REPO: "octo/data" });

  it("reads at the head commit and lands every change as one fast-forward commit", async () => {
    const calls = fakeGitHub();
    const snap = github().snapshot();
    expect(await snap.read(["coding.md", "pending/q-1.json"])).toEqual(new Map([["coding.md", "# coding\n"], ["pending/q-1.json", null]]));
    expect(calls[1].body.variables).toMatchObject({ owner: "octo", name: "data", p0: "c0:coding.md", p1: "c0:pending/q-1.json" });
    expect(await snap.commit([{ path: "coding.md", content: "# coding\n\n- x\n" }, { path: "pending/q-1.json", content: null }], "Approve 1")).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/", "")}`)).toEqual([
      "POST graphql",
      "POST graphql",
      "POST repos/octo/data/git/trees",
      "POST repos/octo/data/git/commits",
      "PATCH repos/octo/data/git/refs/heads/main",
    ]);
    expect(calls[2].body).toEqual({
      base_tree: "t0",
      tree: [
        { path: "coding.md", mode: "100644", type: "blob", content: "# coding\n\n- x\n" },
        { path: "pending/q-1.json", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(calls[3].body).toEqual({ message: "Approve 1", tree: "t1", parents: ["c0"] });
    expect(calls[4].body).toEqual({ sha: "c1", force: false });
  });

  it("reports a conflict when the branch moved on", async () => {
    fakeGitHub(422);
    const snap = github().snapshot();
    await snap.read(["coding.md"]);
    expect(await snap.commit([{ path: "coding.md", content: "x" }], "m")).toBe(false);
  });
});
