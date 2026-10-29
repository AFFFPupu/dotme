// dotme, dotfiles for AI agents: an OAuth-protected MCP endpoint over the
// owner's preference files. Each connected agent is one OAuth grant, named by
// the owner on the consent page, with the categories it may see. Agents read
// and propose; only the owner approves, on /approve.

import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer, acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";
import { escape, handleApprovalPages, html, samePassphrase } from "./pages";
import { approve, getPreferences, isCategory, listPending, propose } from "./dotme";
import { CATEGORIES, cleanLine } from "./prefs";
import type { Category } from "./prefs";
import { makeStore } from "./store";
import type { StoreEnv } from "./store";

interface Env extends StoreEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  OWNER_PASSPHRASE: string;
  MCP_RESOURCE: string;
  // Read-only token for scripts that copy the core into a client, such as the Claude Code SessionStart hook.
  EXPORT_TOKEN?: string;
}

const env = workerEnv as unknown as Env;
const origin = () => new URL(env.MCP_RESOURCE).origin;

const INSTRUCTIONS = `This server holds the user's personal preferences for AI agents, in categories.
Read them with get_preferences and follow them. Never claim a preference was saved:
propose_change only creates a proposal, and the user approves it on a page you link to.
Propose a change only after asking the user in conversation, with specific evidence
(what they said or did, and when). When a new preference seems to contradict an old one,
ask whether it applies only in some situations and propose it with "when" instead of
replacing the old one.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function caller(): { agent: string; categories: readonly Category[]; inlineApproval: boolean } {
  const props = getMcpAuthContext()?.props ?? {};
  // Grants made before category access existed see every category.
  const categories = Array.isArray(props.categories) ? (props.categories as unknown[]).filter(isCategory) : CATEGORIES;
  return { agent: String(props.agent ?? "unknown"), categories, inlineApproval: props.inlineApproval === true };
}

// True when the request declares, in its protocol 2026-07-28 envelope, that the client can show an
// elicitation form. 2025-era requests carry no capabilities, and this stateless server cannot push
// a dialog to them, so they get the approval link instead.
function clientCanElicit(envelope: Record<string, unknown> | undefined): boolean {
  const capabilities = envelope?.["io.modelcontextprotocol/clientCapabilities"] as { elicitation?: unknown } | undefined;
  return capabilities?.elicitation !== undefined;
}

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]).describe("Approve saves it now; reject drops it."),
  when: z.string().max(120).optional().describe("Only applies when (optional), e.g. personal projects"),
});

function allowed(category: Category) {
  if (!caller().categories.includes(category)) throw new Error(`This connection cannot access ${category}`);
}

function createServer() {
  const server = new McpServer({ name: "dotme", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const store = makeStore(env);
  const category = z.enum(CATEGORIES);

  server.registerTool(
    "whoami",
    { description: "Which agent this connection was authorized as, and the categories it can access." },
    async () => text({ ...caller(), authorizedAt: getMcpAuthContext()?.props.authorizedAt })
  );

  server.registerTool(
    "list_categories",
    { description: "Categories this connection can read, with how many preferences each holds." },
    async () => {
      const counts = await Promise.all(caller().categories.map(async (c) => [c, (await getPreferences(store, c)).length]));
      return text(Object.fromEntries(counts));
    }
  );

  server.registerTool(
    "get_preferences",
    {
      description: "The user's preferences in one category. Each has an id (use it as `replaces`) and an optional `when` scope.",
      inputSchema: { category },
    },
    async ({ category }) => {
      allowed(category);
      return text(await getPreferences(store, category));
    }
  );

  server.registerTool(
    "propose_change",
    {
      description:
        "Propose adding, changing or removing a preference. Ask the user first. Returns a link: send it to the user, who approves or rejects there. Nothing changes until they do.",
      inputSchema: {
        category,
        op: z.enum(["add", "change", "remove"]),
        text: z.string().max(300).optional().describe("The preference in one plain sentence. Required for add and change."),
        when: z.string().max(120).optional().describe("Situations it applies to, e.g. 'personal projects'. Omit for always."),
        replaces: z.string().optional().describe("Id of the preference to change or remove."),
        evidence: z.string().min(10).max(500).describe("What the user said or did that supports this, and when. A summary, not chat text."),
      },
    },
    async (input, context) => {
      allowed(input.category);
      const { agent, inlineApproval } = caller();

      // Approve in the client's own dialog when this connection allows it and the client can show one.
      // The client, not the model, returns the answer; the arguments are re-sent unchanged on retry.
      if (inlineApproval && clientCanElicit(context.mcpReq.envelope as Record<string, unknown> | undefined)) {
        const responses = context.mcpReq.inputResponses as Record<string, unknown> | undefined;
        const answer = acceptedContent(responses, "decision", decisionSchema);
        if (!answer && responses?.decision === undefined) {
          const current = input.replaces ? (await getPreferences(store, input.category)).find((p) => p.id === input.replaces) : undefined;
          const change =
            input.op === "add" ? `add: "${input.text}"` : input.op === "remove" ? `remove: "${current?.text ?? input.replaces}"` : `change "${current?.text ?? input.replaces}" to "${input.text}"`;
          return inputRequired({
            inputRequests: {
              decision: inputRequired.elicit({
                message: `dotme: ${agent} wants to ${change} in ${input.category}.${input.when ? ` Suggested scope: ${input.when}.` : ""} Evidence: ${input.evidence}`,
                requestedSchema: decisionSchema,
              }),
            },
          });
        }
        if (answer?.decision === "reject") return text({ status: "rejected", tellUser: "Nothing was saved." });
        if (answer?.decision === "approve") {
          const proposal = await propose(store, {
            category: input.category,
            op: input.op,
            text: input.text ? cleanLine(input.text, 300) : undefined,
            when: input.when ? cleanLine(input.when, 120) : undefined,
            replaces: input.replaces,
            evidence: cleanLine(input.evidence, 500),
            by: agent,
          });
          await approve(store, proposal.id, cleanLine(answer.when ?? input.when ?? "", 120) || undefined);
          return text({ status: "approved and saved", proposal: proposal.id });
        }
        // Declined or cancelled: keep it as a pending proposal with a link, below.
      }

      const proposal = await propose(store, {
        category: input.category,
        op: input.op,
        text: input.text ? cleanLine(input.text, 300) : undefined,
        when: input.when ? cleanLine(input.when, 120) : undefined,
        replaces: input.replaces,
        evidence: cleanLine(input.evidence, 500),
        by: agent,
      });
      return text({
        status: "pending approval",
        proposal: proposal.id,
        approveAt: `${origin()}/approve/${proposal.id}`,
        tellUser: "Send the user this link. The change is not saved until they approve it there.",
      });
    }
  );

  server.registerTool(
    "list_pending",
    { description: "Open proposals in the categories this connection can access, oldest first." },
    async () => text(await listPending(store, caller().categories))
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

// The core (collab) as plain Markdown for clients that copy it in at session start.
async function exportCore(request: Request, env: Env): Promise<Response> {
  const given = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.EXPORT_TOKEN || !(await samePassphrase(given, env.EXPORT_TOKEN))) return new Response("Unauthorized", { status: 401 });
  const prefs = await getPreferences(makeStore(env), "collab");
  const lines = prefs.map((p) => `- ${p.text}${p.when ? ` (when: ${p.when})` : ""}`);
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
}

const AuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.OWNER_PASSPHRASE) return new Response("Server has no OWNER_PASSPHRASE set.", { status: 503 });
    if (new URL(request.url).pathname === "/export/collab.md") return exportCore(request, env);
    const approval = await handleApprovalPages(request, env.OWNER_PASSPHRASE, makeStore(env));
    if (approval) return approval;

    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("dotme", { status: 200 });

    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        const source = details.clientDomain
          ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
          : "This app registered itself; its name is not verified.";
        const boxes = CATEGORIES.map((c) => `<label><input type="checkbox" name="category" value="${c}" checked> ${c}</label>`).join(" ");
        return html(
          `<title>Connect ${escape(details.clientName)}</title>
<h1>Connect ${escape(details.clientName)} to dotme?</h1>
<p>${source} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <p><label>Name this agent <input name="agent" required pattern="[a-z0-9-]{2,32}" placeholder="grok-bot"></label></p>
  <p>Categories it may read and propose to: ${boxes}</p>
  <p><label><input type="checkbox" name="inline"> Let this app ask me to approve changes in its own dialog (only for apps you trust, such as Claude Code)</label></p>
  <p><label>Passphrase <input name="passphrase" type="password" required></label></p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`,
          consent.headers
        );
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle"));
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        if (!(await samePassphrase(String(form.get("passphrase") ?? ""), env.OWNER_PASSPHRASE))) {
          return new Response("Wrong passphrase. Go back and start the connection again.", { status: 403 });
        }
        const agent = String(form.get("agent") ?? "");
        if (!/^[a-z0-9-]{2,32}$/.test(agent)) return new Response("Invalid agent name.", { status: 400 });
        const categories = form.getAll("category").map(String).filter(isCategory);

        const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:read"] });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: "owner",
          metadata: { agent },
          scope: approved.request.scope,
          props: { agent, categories, inlineApproval: form.get("inline") === "on", authorizedAt: new Date().toISOString() },
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }

      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      throw error;
    }
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler: AuthHandler,
  scopesSupported: ["mcp:read"],
  requiredScopes: ["mcp:read"],
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: env.MCP_RESOURCE },
  // OAuth errors carry the failed check only in `internal`; log it so connection problems can be diagnosed.
  onError({ code, status, internal }) {
    console.warn(JSON.stringify({ oauthError: code, status, ...internal }));
  },
});
