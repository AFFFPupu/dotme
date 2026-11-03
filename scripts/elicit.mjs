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
const propose = (client, text, when) =>
  client.callTool({ name: "propose_change", arguments: { category: "coding", op: "add", text, ...(when && { when }), evidence: "elicit test, 2026-10-29" } });

const inline = await getToken(base, passphrase, "inline-test", { inline: true });
let { client, asked } = await connect(inline, { action: "accept", content: {} });
const approved = result(await propose(client, "Inline approved preference", "tests"));
console.log("inline approve:", approved, "| dialog:", asked[0]);
assert.equal(approved.status, "approved and saved");
assert.match(asked[0], /inline-test wants to add: "Inline approved preference" in coding, only when: tests\./);
assert.match(asked[0], /Accept saves it now\. Decline or close this/);
// A client that accepts an empty form may send no content at all; that still saves.
({ client, asked } = await connect(inline, { action: "accept" }));
const bare = result(await propose(client, "Accepted without content"));
console.log("inline accept, no content:", bare.status, "|", asked[0].split(".")[0]);
assert.equal(bare.status, "approved and saved");
assert.match(asked[0], /in coding, always\./);
({ client, asked } = await connect(inline, { action: "decline" }));
const declined = result(await propose(client, "Declined, should be pending"));
console.log("inline decline:", declined.status);
assert.equal(declined.status, "pending approval");
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
assert.ok(coding.some((p) => p.text === "Accepted without content" && p.when === undefined));
for (const text of ["Declined, should be pending", "Dismissed, should be pending", "Should need the page"]) assert.ok(!coding.some((p) => p.text === text), `${text} was saved`);
console.log("elicit: all checks passed");
await client.close();
