import { describe, expect, it } from "vitest";
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
