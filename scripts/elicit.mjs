// Check in-app approval: a 2026-07-28 client that declares elicitation.
// Exits non-zero on the first failed check.
// Usage: node scripts/elicit.mjs [baseUrl] [passphrase]
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getToken } from "./oauth.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const passphrase = process.argv[3] ?? "local-test-passphrase";

async function connect(token, answer) {
  const client = new Client({ name: "elicit-test", version: "0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const asked = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    asked.push(request.params.message);
    return answer;
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return { client, asked };
}
const result = (r) => JSON.parse(r.content[0].text);
const propose = (client, text) =>
  client.callTool({ name: "propose_change", arguments: { category: "coding", op: "add", text, evidence: "elicit test, 2026-10-29" } });

const inline = await getToken(base, passphrase, "inline-test", { inline: true });
let { client, asked } = await connect(inline, { action: "accept", content: { when: "tests" } });
const approved = result(await propose(client, "Inline approved preference"));
console.log("inline approve:", approved, "| dialog:", asked[0]);
assert.equal(approved.status, "approved and saved");
assert.match(asked[0], /inline-test wants to add: "Inline approved preference" in coding/);
assert.match(asked[0], /Accept saves it now\. Decline drops it\./);
({ client, asked } = await connect(inline, { action: "decline" }));
const rejected = result(await propose(client, "Inline rejected preference"));
console.log("inline decline:", rejected);
assert.equal(rejected.status, "rejected");
({ client, asked } = await connect(inline, { action: "cancel" }));
const dismissed = result(await propose(client, "Dismissed, should be pending"));
console.log("inline dismiss:", dismissed.status);
assert.equal(dismissed.status, "pending approval");

const plain = await getToken(base, passphrase, "plain-test");
({ client, asked } = await connect(plain, { action: "accept", content: {} }));
const linkOnly = result(await propose(client, "Should need the page"));
console.log("no inline permission:", linkOnly.status, "| dialogs shown:", asked.length);
assert.equal(linkOnly.status, "pending approval");
assert.equal(asked.length, 0);

const coding = result(await client.callTool({ name: "get_preferences", arguments: { category: "coding" } }));
console.log("coding now:", coding.map((p) => `${p.text} [${p.when ?? ""}] by ${p.by}`));
assert.ok(coding.some((p) => p.text === "Inline approved preference" && p.when === "tests" && p.by === "inline-test"));
for (const text of ["Inline rejected preference", "Dismissed, should be pending", "Should need the page"]) assert.ok(!coding.some((p) => p.text === text), `${text} was saved`);
console.log("elicit: all checks passed");
await client.close();
