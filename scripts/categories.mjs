// Check dynamic categories against a running server: a category is a Markdown file in the store,
// the consent page offers it, and only connections that ticked it can see it.
// Usage: node scripts/categories.mjs [baseUrl] [passphrase] [exportToken]
// Expects a `work` category with one preference; scripts/e2e-local.mjs adds it before starting the server.
import { getToken } from "./oauth.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const passphrase = process.argv[3] ?? "local-test-passphrase";
const exportToken = process.argv[4] ?? "local-export-token";
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

async function connect(agent, categories, onPage) {
  const token = await getToken(base, passphrase, agent, { categories, onPage });
  let id = 0;
  return async (name, args = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const data = JSON.parse((await res.text()).split("\n").find((l) => l.startsWith("data: ")).slice(6));
    return data.result?.content?.[0]?.text ?? JSON.stringify(data);
  };
}

let page = "";
const without = await connect("no-work", ["collab", "coding", "life"], (html) => (page = html));
check("consent page offers the new category", page.includes('name="category" value="work" checked'));
check("consent page keeps the defaults first", page.indexOf('value="collab"') < page.indexOf('value="work"'));
check("a connection that did not tick it cannot list it", !Object.keys(JSON.parse(await without("list_categories"))).includes("work"));
check("a connection that did not tick it cannot read it", (await without("get_preferences", { category: "work" })).includes("cannot access work"));
check("a connection that did not tick it cannot propose to it", (await without("propose_change", { category: "work", op: "add", text: "x", evidence: "categories e2e, 2026-11-03" })).includes("cannot access work"));

const withWork = await connect("with-work", ["work", "nope"]);
const who = JSON.parse(await withWork("whoami"));
check("a ticked category is granted, a made-up one is dropped", JSON.stringify(who.categories) === '["work"]');
check("a connection that ticked it can read it", JSON.parse(await withWork("get_preferences", { category: "work" }))[0]?.text === "Standups are async.");
check("a path is not a category name", (await withWork("get_preferences", { category: "../coding" })).includes("error"));

const exported = await fetch(`${base}/export?categories=work`, { headers: { Authorization: `Bearer ${exportToken}` } });
check("export reads the new category", exported.status === 200 && (await exported.text()).includes("- Standups are async."));
const unknown = await fetch(`${base}/export?categories=nope`, { headers: { Authorization: `Bearer ${exportToken}` } });
check("export lists real categories for an unknown one", unknown.status === 400 && (await unknown.text()).includes("Known: collab, coding, life, work."));

if (!process.exitCode) console.log("categories: all checks passed");
