import { describe, expect, it } from "vitest";
import { checkPassphrase, clientKey, LOCK_SECONDS, lockedFor, MAX_FAILURES } from "../src/ratelimit";

// Just enough of KVNamespace for the rate limit, counting writes.
function fakeKV() {
  const data = new Map<string, string>();
  const kv = {
    data,
    writes: 0,
    async get(key: string, type?: "json") {
      const value = data.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      kv.writes++;
      data.set(key, value);
    },
    async delete(key: string) {
      kv.writes++;
      data.delete(key);
    },
  };
  return kv;
}

const from = (ip: string) => new Request("https://dotme.example/approve", { headers: { "CF-Connecting-IP": ip } });
const same = async (given: string) => given === "right";

describe("passphrase rate limit", () => {
  it("locks an address after five wrong passphrases, even for the right one", async () => {
    const kv = fakeKV() as unknown as KVNamespace;
    for (let i = 1; i < MAX_FAILURES; i++) expect(await checkPassphrase(kv, from("203.0.113.9"), "wrong", same)).toEqual({ ok: false, lockedFor: 0 });
    expect(await checkPassphrase(kv, from("203.0.113.9"), "wrong", same)).toEqual({ ok: false, lockedFor: LOCK_SECONDS });
    expect(await checkPassphrase(kv, from("203.0.113.9"), "right", same)).toMatchObject({ ok: false });
    expect(await lockedFor(kv, from("203.0.113.9"))).toBeGreaterThan(LOCK_SECONDS - 5);
    // Another address is not affected.
    expect(await checkPassphrase(kv, from("198.51.100.1"), "right", same)).toEqual({ ok: true });
  });

  it("writes nothing while locked, and lifts the lock after 15 minutes", async () => {
    const kv = fakeKV();
    const k = kv as unknown as KVNamespace;
    for (let i = 0; i < MAX_FAILURES; i++) await checkPassphrase(k, from("203.0.113.9"), "wrong", same);
    const writes = kv.writes;
    await checkPassphrase(k, from("203.0.113.9"), "wrong", same);
    expect(kv.writes).toBe(writes);
    expect(await lockedFor(k, from("203.0.113.9"), Date.now() + LOCK_SECONDS * 1000 + 1)).toBe(0);
  });

  it("clears the count on a right passphrase, and only writes when there is a count", async () => {
    const kv = fakeKV();
    const k = kv as unknown as KVNamespace;
    expect(await checkPassphrase(k, from("203.0.113.9"), "right", same)).toEqual({ ok: true });
    expect(kv.writes).toBe(0);
    await checkPassphrase(k, from("203.0.113.9"), "wrong", same);
    await checkPassphrase(k, from("203.0.113.9"), "right", same);
    expect(kv.data.size).toBe(0);
  });

  it("counts an IPv6 /64 as one address", () => {
    expect(clientKey(from("2001:db8:1:2:aaaa::1"))).toBe(clientKey(from("2001:db8:1:2:bbbb::2")));
    expect(clientKey(from("2001:db8:1:3::1"))).not.toBe(clientKey(from("2001:db8:1:2::1")));
    expect(clientKey(from("2001:db8::1"))).toBe("ratelimit:passphrase:2001:db8:0:0::/64");
    expect(clientKey(from("2001:0db8:0000:0000:1::9"))).toBe(clientKey(from("2001:db8::2")));
  });
});
