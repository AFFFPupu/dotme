// Check in-app approval: a 2026-07-28 client that declares elicitation.
// Usage: node scripts/elicit.mjs [baseUrl] [passphrase]
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
let { client, asked } = await connect(inline, { action: "accept", content: { decision: "approve", when: "tests" } });
console.log("inline approve:", result(await propose(client, "Inline approved preference")), "| dialog:", asked[0]);
({ client, asked } = await connect(inline, { action: "accept", content: { decision: "reject" } }));
console.log("inline reject:", result(await propose(client, "Inline rejected preference")));
({ client, asked } = await connect(inline, { action: "decline" }));
console.log("inline decline:", result(await propose(client, "Declined, should be pending")).status);

const plain = await getToken(base, passphrase, "plain-test");
({ client, asked } = await connect(plain, { action: "accept", content: { decision: "approve" } }));
console.log("no inline permission:", result(await propose(client, "Should need the page")).status, "| dialogs shown:", asked.length);

console.log("coding now:", result(await client.callTool({ name: "get_preferences", arguments: { category: "coding" } })).map((p) => `${p.text} [${p.when ?? ""}] by ${p.by}`));
