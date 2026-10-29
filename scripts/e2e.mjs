// End-to-end check of the OAuth + MCP flow against a running server.
// Usage: node scripts/e2e.mjs [baseUrl] [passphrase] [agentName]
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8787";
const passphrase = process.argv[3] ?? "local-test-passphrase";
const agent = process.argv[4] ?? "e2e-test";
const redirectUri = "http://localhost:9999/callback";
const b64url = (buf) => buf.toString("base64url");

const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
const unauth = await fetch(`${base}/mcp`, { method: "POST" });
console.log("unauthenticated /mcp:", unauth.status, unauth.headers.get("www-authenticate"));

const client = await (await fetch(meta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "e2e", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
})).json();

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const resource = `${base}/mcp`;
const authUrl = new URL(meta.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
  code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:read", state: "xyz", resource,
})) authUrl.searchParams.set(k, v);

const page = await fetch(authUrl);
const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];

const post = await fetch(authUrl, {
  method: "POST", redirect: "manual",
  headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: base },
  body: new URLSearchParams([["handle", handle], ["agent", agent], ["passphrase", passphrase], ["decision", "approve"], ["category", "collab"], ["category", "coding"], ["category", "life"]]),
});
const location = post.headers.get("location");
console.log("consent POST:", post.status);
const code = new URL(location).searchParams.get("code");

const token = await (await fetch(meta.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource }),
})).json();
if (!token.access_token) throw new Error(`token exchange failed: ${JSON.stringify(token)}`);

async function rpc(method, params, id) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return [res.status, await res.text()];
}
const call = async (name, args, id) => {
  const [, body] = await rpc("tools/call", { name, arguments: args }, id);
  const data = JSON.parse(body.split("\n").find((l) => l.startsWith("data: ")).slice(6));
  return data.result?.content?.[0]?.text ?? JSON.stringify(data);
};

// Owner signs in to the approval page.
async function ownerPost(path, fields, cookie) {
  return fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
  });
}

await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }, 1);
console.log("whoami:", await call("whoami", {}, 2));

const proposed = JSON.parse(await call("propose_change", { category: "coding", op: "add", text: "Prefer Cloudflare over Supabase", evidence: "e2e test: user said so on 2026-10-29" }, 3));
console.log("propose:", proposed.status, proposed.approveAt);
const id = proposed.proposal;

const anon = await fetch(`${base}/approve/${id}`);
console.log("approval page without session:", anon.status, (await anon.text()).includes("Sign in"));
const badOrigin = await fetch(`${base}/approve/${id}`, { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams({ decision: "approve" }) });
console.log("cross-origin approve:", badOrigin.status);

const signin = await ownerPost(`/approve/${id}`, { action: "signin", passphrase });
const session = signin.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const approvalPage = await (await fetch(`${base}/approve/${id}`, { headers: { Cookie: session } })).text();
console.log("approval page shows diff:", approvalPage.includes("Prefer Cloudflare over Supabase"), approvalPage.includes("e2e test"));
const approved = await ownerPost(`/approve/${id}`, { decision: "approve", when: "personal projects" }, session);
console.log("approve:", approved.status, approved.headers.get("location"));

const prefs = JSON.parse(await call("get_preferences", { category: "coding" }, 4));
console.log("coding after approve:", JSON.stringify(prefs));
const prefId = prefs.at(-1).id;

// Two agents' conflicting changes to the same preference, then reject one.
const a = JSON.parse(await call("propose_change", { category: "coding", op: "change", replaces: prefId, text: "Use Supabase everywhere", evidence: "e2e conflict A, 2026-10-29" }, 5));
const b = JSON.parse(await call("propose_change", { category: "coding", op: "remove", replaces: prefId, evidence: "e2e conflict B, 2026-10-29" }, 6));
const conflictPage = await (await fetch(`${base}/approve/${a.proposal}`, { headers: { Cookie: session } })).text();
console.log("conflict shown:", conflictPage.includes("Conflicts:"));
await ownerPost(`/approve/${a.proposal}`, { decision: "reject" }, session);
await ownerPost(`/approve/${b.proposal}`, { decision: "approve" }, session);
console.log("coding after reject A, approve remove B:", await call("get_preferences", { category: "coding" }, 7));
console.log("pending left:", await call("list_pending", {}, 8));
console.log("bad replaces:", (await call("propose_change", { category: "coding", op: "remove", replaces: "p-00000000", evidence: "should fail, 2026-10-29" }, 9)).slice(0, 120));
