import { describe, expect, it } from "vitest";
import { expiryCheck, expiryWarning, githubChecks, parseTokenExpiry, resourceFor, runChecks } from "../src/setup";

const now = new Date("2026-11-03T12:00:00Z");
const inDays = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

function fakeKV(keys: string[] = []) {
  return {
    async get() {
      return null;
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: keys.filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  } as unknown as KVNamespace;
}

// A GitHub API stand-in: answers by path, records each call.
function fakeGitHub(answers: { repo: [number, unknown?, Record<string, string>?]; refs?: number }) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/git/refs")) return new Response("{}", { status: answers.refs ?? 422 });
    const [status, body, headers] = answers.repo;
    return new Response(JSON.stringify(body ?? {}), { status, headers });
  }) as typeof fetch;
  return { fetcher, calls };
}

const byId = (checks: { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
const github = { GITHUB_REPO: "someone/dotme-data", GITHUB_TOKEN: "test-token" };

describe("parseTokenExpiry", () => {
  it("reads GitHub's formats", () => {
    expect(parseTokenExpiry("2027-11-04 08:00:00 UTC")?.toISOString()).toBe("2027-11-04T08:00:00.000Z");
    expect(parseTokenExpiry("2027-11-04 09:00:00 +0100")?.toISOString()).toBe("2027-11-04T08:00:00.000Z");
    expect(parseTokenExpiry("2027-11-04 09:00:00 +01:00")?.toISOString()).toBe("2027-11-04T08:00:00.000Z");
  });

  it("returns null for no or unknown values", () => {
    expect(parseTokenExpiry(null)).toBeNull();
    expect(parseTokenExpiry("")).toBeNull();
    expect(parseTokenExpiry("next tuesday")).toBeNull();
  });
});

describe("expiryCheck", () => {
  it("warns inside 30 days and fails once expired", () => {
    expect(expiryCheck(inDays(200), now).status).toBe("ok");
    expect(expiryCheck(inDays(30.5), now).status).toBe("ok");
    expect(expiryCheck(inDays(29), now).status).toBe("warn");
    expect(expiryCheck(inDays(1), now).detail).toContain("in 1 day.");
    expect(expiryCheck(inDays(-1), now).status).toBe("fail");
    expect(expiryCheck(null, now).status).toBe("ok");
  });

  it("only puts a warning on owner pages when one is due", () => {
    expect(expiryWarning(inDays(200), now)).toBe("");
    expect(expiryWarning(inDays(10), now)).toContain("secret put GITHUB_TOKEN");
  });
});

describe("githubChecks", () => {
  it("passes a private repo with a writable, long-lived token", async () => {
    const { fetcher, calls } = fakeGitHub({ repo: [200, { private: true }, { "github-authentication-token-expiration": "2027-11-04 08:00:00 UTC" }] });
    const checks = await githubChecks(github, fetcher, now);
    expect(byId(checks)).toEqual({ github_repo: "ok", github_token: "ok", github_token_write: "ok", github_token_expiry: "ok" });
    expect(calls).toEqual(["GET /repos/someone/dotme-data", "POST /repos/someone/dotme-data/git/refs"]);
  });

  it("fails a public repo and a read-only token", async () => {
    const { fetcher } = fakeGitHub({ repo: [200, { private: false }], refs: 403 });
    expect(byId(await githubChecks(github, fetcher, now))).toMatchObject({ github_repo: "fail", github_token_write: "fail" });
  });

  it("explains a rejected token and an unreachable repo", async () => {
    expect(byId(await githubChecks(github, fakeGitHub({ repo: [401] }).fetcher, now))).toMatchObject({ github_token: "fail" });
    expect(byId(await githubChecks(github, fakeGitHub({ repo: [404] }).fetcher, now))).toMatchObject({ github_repo: "fail", github_token: "ok" });
  });

  it("asks for a repo and a token before calling GitHub", async () => {
    const { fetcher, calls } = fakeGitHub({ repo: [200] });
    expect(byId(await githubChecks({}, fetcher, now))).toMatchObject({ github_repo: "fail" });
    expect(byId(await githubChecks({ GITHUB_REPO: "someone/data" }, fetcher, now))).toMatchObject({ github_token: "fail" });
    expect(calls).toEqual([]);
  });
});

describe("resourceFor", () => {
  it("prefers MCP_RESOURCE and otherwise uses the request's origin", () => {
    expect(resourceFor("https://dotme.example.dev/mcp", "https://other.example.dev/approve")).toBe("https://dotme.example.dev/mcp");
    expect(resourceFor(undefined, "https://dotme.someone.workers.dev/mcp?x=1")).toBe("https://dotme.someone.workers.dev/mcp");
    expect(resourceFor("", "http://localhost:8788/authorize")).toBe("http://localhost:8788/mcp");
  });
});

describe("runChecks", () => {
  const origin = "https://dotme.example.dev";

  it("is all green for a complete install and never echoes secrets", async () => {
    const { fetcher } = fakeGitHub({ repo: [200, { private: true }] });
    const env = {
      ...github,
      OWNER_PASSPHRASE: "a long enough passphrase",
      MCP_RESOURCE: `${origin}/mcp`,
      EXPORT_TOKEN: "export-secret-value",
      OAUTH_KV: fakeKV(["passkey:abc"]),
    };
    const checks = await runChecks(env, origin, fetcher, now);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    const text = JSON.stringify(checks);
    for (const secret of [env.OWNER_PASSPHRASE, env.EXPORT_TOKEN, env.GITHUB_TOKEN, env.GITHUB_REPO]) expect(text).not.toContain(secret);
  });

  it("names what a fresh install is missing", async () => {
    const checks = await runChecks({ MCP_RESOURCE: "http://localhost:8787/mcp", OAUTH_KV: fakeKV() }, origin, fakeGitHub({ repo: [200] }).fetcher, now);
    expect(byId(checks)).toMatchObject({ owner_passphrase: "fail", mcp_resource: "fail", kv: "ok", github_repo: "fail", export_token: "warn", passkey: "warn" });
    expect(checks.find((c) => c.id === "owner_passphrase")?.fix).toMatch(/^Human:/);
  });

  it("uses the address it was reached at when MCP_RESOURCE is not set", async () => {
    const checks = await runChecks({ OAUTH_KV: fakeKV() }, origin, fakeGitHub({ repo: [200] }).fetcher, now);
    expect(byId(checks).mcp_resource).toBe("ok");
    expect(checks.find((c) => c.id === "mcp_resource")?.detail).toContain(`${origin}/mcp`);
  });

  it("accepts KV storage only on a local server", async () => {
    const env = { STORAGE: "kv", OAUTH_KV: fakeKV() };
    expect(byId(await runChecks(env, "http://localhost:8787", fetch, now)).storage).toBe("ok");
    expect(byId(await runChecks(env, origin, fetch, now)).storage).toBe("warn");
  });
});
