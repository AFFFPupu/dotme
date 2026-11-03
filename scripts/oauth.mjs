// Get an access token from a dotme server by running the OAuth flow as a test client.
import { createHash, randomBytes } from "node:crypto";

// With `session` (an owner_session cookie), the consent form is sent without the passphrase;
// `onPage` receives the consent page's HTML. `redirectUri` sets the callback the test client registers.
export async function getToken(base, passphrase, agent, { inline = false, session, onPage, redirectUri = "http://localhost:9999/callback" } = {}) {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const client = await (await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resource = `${base}/mcp`;
  const authUrl = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:read", state: "s", resource,
  })) authUrl.searchParams.set(k, v);
  const page = await fetch(authUrl, { headers: session ? { Cookie: session } : {} });
  const cookie = [session, ...page.headers.getSetCookie().map((c) => c.split(";")[0])].filter(Boolean).join("; ");
  const body = await page.text();
  onPage?.(body);
  const handle = body.match(/name="handle" value="([^"]+)"/)[1];
  const fields = [["handle", handle], ["agent", agent], ...(session ? [] : [["passphrase", passphrase]]), ["decision", "approve"], ["category", "collab"], ["category", "coding"], ["category", "life"]];
  if (inline) fields.push(["inline", "on"]);
  const post = await fetch(authUrl, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: base },
    body: new URLSearchParams(fields),
  });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const token = await (await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource }),
  })).json();
  if (!token.access_token) throw new Error(`token exchange failed: ${JSON.stringify(token)}`);
  return token.access_token;
}
