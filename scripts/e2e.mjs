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
  body: new URLSearchParams({ handle, agent, passphrase, decision: "approve" }),
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
console.log("initialize:", ...(await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }, 1)).map(String).map((s) => s.slice(0, 160)));
console.log("whoami:", (await rpc("tools/call", { name: "whoami", arguments: {} }, 2))[1].slice(0, 400));
console.log("get_preferences:", (await rpc("tools/call", { name: "get_preferences", arguments: { category: "collab" } }, 3))[1].slice(0, 400));
