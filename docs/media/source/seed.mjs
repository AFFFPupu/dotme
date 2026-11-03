import { getToken } from "../../../scripts/oauth.mjs";
const base = "http://localhost:8787";
async function propose(agent, args) {
  const token = await getToken(base, "local-test-passphrase", agent);
  const at = token.access_token ?? token;
  const h = { Authorization: `Bearer ${at}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
  const rpc = (id, method, params) => fetch(`${base}/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.text());
  await rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: agent, version: "0" } });
  console.log(agent, (await rpc(2, "tools/call", { name: "propose_change", arguments: args })).slice(0, 200));
}
await propose("claude-code", { category: "coding", op: "add", text: "Use pnpm instead of npm", evidence: "Said \"use pnpm, not npm. always.\" while setting up a project" });
await propose("codex", { category: "collab", op: "add", text: "Keep replies short; lead with the answer", evidence: "Asked twice this week to skip the preamble" });
await propose("grok-bot", { category: "life", op: "add", text: "Timezone is Asia/Shanghai", evidence: "Mentioned it when scheduling a reminder" });
