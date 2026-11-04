// Check the approval page against a running server: approving and rejecting ticked proposals in one
// press, skipping proposals that conflict, a large batch in one press, and friendly pages instead of errors.
// Usage: node scripts/approvals.mjs [baseUrl] [passphrase]
import { getToken } from "./oauth.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const passphrase = process.argv[3] ?? "local-test-passphrase";
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

const token = await getToken(base, passphrase, "approvals-test", { categories: ["life"] });
let rpcId = 0;
async function call(name, args = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = JSON.parse((await res.text()).split("\n").find((l) => l.startsWith("data: ")).slice(6));
  return JSON.parse(data.result.content[0].text);
}
const propose = async (fields) => (await call("propose_change", { category: "life", evidence: "approvals e2e, 2026-11-03", ...fields })).proposal;

const post = (path, fields, cookie) =>
  fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
  });
const signin = await post("/approve", { action: "signin", passphrase });
const session = signin.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const page = async (path) => (await fetch(`${base}${path}`, { headers: { Cookie: session } })).text();
const decide = (decision, ids) => post("/approve", [["decision", decision], ...ids.map((id) => ["id", id])], session);
const ticked = (html, id) => new RegExp(`value="${id}" checked`).test(html);

// Approve two at once.
const a = await propose({ op: "add", text: "Batch A" });
const b = await propose({ op: "add", text: "Batch B" });
const list = await page("/approve");
check("pending list ticks both, fits a phone and offers one button", ticked(list, a) && ticked(list, b) && list.includes("initial-scale=1") && list.includes("Approve ticked"));
const both = await decide("approve", [a, b]);
check(`approving two lands on the list with a count (${both.headers.get("location")})`, both.status === 303 && both.headers.get("location") === "/approve?approved=2");
check("the list says what happened", (await page(both.headers.get("location"))).includes("Approved 2 proposals."));
const saved = await call("get_preferences", { category: "life" });
const prefA = saved.find((p) => p.text === "Batch A");
check("both are saved", prefA && saved.some((p) => p.text === "Batch B"));

// Conflicting proposals are left unticked and skipped.
const change = await propose({ op: "change", replaces: prefA.id, text: "Batch A, revised" });
const remove = await propose({ op: "remove", replaces: prefA.id });
const c = await propose({ op: "add", text: "Batch C" });
const conflictList = await page("/approve");
check("conflicting proposals are not ticked", !ticked(conflictList, change) && !ticked(conflictList, remove) && ticked(conflictList, c));
const mixed = await decide("approve", [change, remove, c]);
check(`conflicts are skipped, the rest approved (${mixed.headers.get("location")})`, mixed.headers.get("location") === "/approve?approved=1&skipped=2");

// Friendly pages instead of server errors.
const again = await post(`/approve/${c}`, { decision: "approve" }, session);
const againPage = await again.text();
check(`approving twice explains instead of failing (${again.status})`, again.status === 409 && againPage.includes("already approved or rejected"));
check("a single approval lands on the list with a count", (await post(`/approve/${remove}`, { decision: "approve" }, session)).headers.get("location") === "/approve?approved=1");
const stale = await post(`/approve/${change}`, { decision: "approve" }, session);
check(`approving a change whose preference is gone explains why (${stale.status})`, stale.status === 409 && (await stale.text()).includes("is no longer in life"));
const rejected = await decide("reject", [change, "q-00000000"]);
check(`reject ticked, counting one already gone (${rejected.headers.get("location")})`, rejected.headers.get("location") === "/approve?rejected=1&gone=1");

// Everything ticked goes in one press.
const many = [];
for (let i = 0; i < 16; i++) many.push(await propose({ op: "add", text: `Batch many ${i}` }));
const all = await decide("approve", many);
check(`sixteen ticked are approved in one press (${all.headers.get("location")})`, all.headers.get("location") === "/approve?approved=16");
const after = await page("/approve");
check("none of these proposals is left pending", ![a, b, change, remove, c, ...many].some((id) => after.includes(id)));

const cleanup = (await call("get_preferences", { category: "life" })).filter((p) => p.text.startsWith("Batch"));
for (const p of cleanup) await post(`/approve/${await propose({ op: "remove", replaces: p.id })}`, { decision: "approve" }, session);
console.log(process.exitCode ? "approvals: FAILED" : "approvals: all checks passed");
