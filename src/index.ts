// dotme, dotfiles for AI agents: an OAuth-protected MCP endpoint over the
// owner's preference files. Each connected agent is one OAuth grant, named by
// the owner on the consent page, with the categories it may see. Agents read
// and propose; only the owner approves, in the app's own dialog or on /approve.
// The consent page and /approve share one owner session.

import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { CLIENT_CAPABILITIES_META_KEY, McpServer, PROTOCOL_VERSION_META_KEY, acceptedContent, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";
import { escape, handleApprovalPages, hasSession, html, samePassphrase, sessionCookie } from "./pages";
import { checkPassphrase, lockMessage } from "./ratelimit";
import { hasPasskeys, PASSKEY_SCRIPT } from "./passkeys";
import { approve, getPreferences, listCategories, listPending, propose } from "./dotme";
import { CATEGORY_NAME, DEFAULT_CATEGORIES, cleanLine, isCategoryName } from "./prefs";
import type { Category, Preference } from "./prefs";
import { setupStatus } from "./setup";
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
Read them with get_preferences and follow them. Never claim a preference was saved unless
propose_change says so: it returns "approved and saved" only when the user accepted it in this
app's own approval dialog. Otherwise it returns "pending approval" with a link; send the user
that link, where they approve or reject it, and say it is not saved yet.
Propose a change only after asking the user in conversation, with specific evidence
(what they said or did, and when). When a new preference seems to contradict an old one,
ask whether it applies only in some situations and propose it with "when" instead of
replacing the old one.`;

// What the default categories are for, shown on the consent page.
const CATEGORY_HINTS: Record<string, string> = {
  collab: "how to work and talk with you",
  coding: "stack, tools and code style",
  life: "personal facts such as timezone",
};

// A starting agent name from the app's own name ("Claude Code" -> "claude-code"); the owner can change it.
function suggestedAgentName(clientName: string): string {
  const slug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return /^[a-z0-9-]{2,32}$/.test(slug) ? slug : "";
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function caller(): { agent: string; categories: readonly Category[]; inlineApproval: boolean } {
  const props = getMcpAuthContext()?.props ?? {};
  // Grants record the categories ticked on the consent page, so categories added later stay hidden
  // until the owner re-authorizes. Grants made before categories were recorded see the defaults.
  const categories = Array.isArray(props.categories) ? (props.categories as unknown[]).filter(isCategoryName) : DEFAULT_CATEGORIES;
  return { agent: String(props.agent ?? "unknown"), categories, inlineApproval: props.inlineApproval === true };
}

// True when the request declares, in its protocol 2026-07-28 envelope, that the client can show an
// elicitation form. 2025-era requests carry no capabilities, and this stateless server cannot push
// a dialog to them, so they get the approval link instead.
function clientCanElicit(envelope: Record<string, unknown> | undefined): boolean {
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  return capabilities?.elicitation !== undefined;
}

// One log line per proposal, so `wrangler tail` shows why a client got a link instead of a dialog.
// It names the protocol version and capability keys the client sent, never the proposal itself.
function logApprovalPath(agent: string, inlineApproval: boolean, envelope: Record<string, unknown> | undefined) {
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  console.log(
    JSON.stringify({
      proposal: {
        agent,
        inlineApproval,
        protocolVersion: envelope?.[PROTOCOL_VERSION_META_KEY] ?? null,
        clientCapabilities: capabilities && typeof capabilities === "object" ? Object.keys(capabilities) : null,
        dialog: inlineApproval && clientCanElicit(envelope),
      },
    })
  );
}

// Accept saves. Decline or dismissing keeps it pending with a link, where the owner can reject it:
// clients with no window to show the dialog in decline on their own, and that must not drop a proposal. The form only asks for an optional scope.
const approvalSchema = z.object({
  when: z.string().max(120).optional().describe("Only applies when (optional), e.g. personal projects"),
});

// Read-only tools say so, so clients can run them without asking each time. propose_change changes
// nothing by itself either (the owner approves), but it is not marked read-only because it can open
// a proposal or, with in-client approval, save after the owner accepts.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function allowed(category: Category) {
  if (!caller().categories.includes(category)) throw new Error(`This connection cannot access ${category}`);
}

function createServer() {
  const server = new McpServer({ name: "dotme", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const store = makeStore(env);
  // Categories are files in the store, so the schema checks the name; allowed() checks access.
  const category = z.string().regex(CATEGORY_NAME).describe("A category this connection can access, from list_categories.");

  server.registerTool(
    "whoami",
    { description: "Which agent this connection was authorized as, and the categories it can access.", annotations: READ_ONLY },
    async () => text({ ...caller(), authorizedAt: getMcpAuthContext()?.props.authorizedAt })
  );

  server.registerTool(
    "list_categories",
    { description: "Categories this connection can read, with how many preferences each holds.", annotations: READ_ONLY },
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
      annotations: READ_ONLY,
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
        "Propose adding, changing or removing a preference. Ask the user first. The user may approve it in this app's dialog (status \"approved and saved\"). Otherwise it returns a link (status \"pending approval\"): send it to the user, who approves or rejects there. Nothing changes until they do.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        category,
        op: z.enum(["add", "change", "remove"]),
        text: z.string().max(300).optional().describe("The preference in one plain sentence. Required for add and change."),
        when: z.string().max(120).optional().describe("Situations it applies to, e.g. 'personal projects'. Omit for always."),
        replaces: z.string().optional().describe("Id of the preference to change or remove."),
        evidence: z.string().min(10).max(500).describe("What the user said or did that supports this, and when, in at least 10 characters. A summary, not chat text."),
      },
    },
    async (input, context) => {
      allowed(input.category);
      const { agent, inlineApproval } = caller();

      // Approve in the client's own dialog when this connection allows it and the client can show one.
      // The client, not the model, returns the answer; the arguments are re-sent unchanged on retry.
      const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
      const responses = context.mcpReq.inputResponses as Record<string, unknown> | undefined;
      const response = inputResponse(responses, "approval");
      if (response.kind === "missing") logApprovalPath(agent, inlineApproval, envelope);
      if (inlineApproval && clientCanElicit(envelope)) {
        if (response.kind === "missing") {
          const current = input.replaces ? (await getPreferences(store, input.category)).find((p) => p.id === input.replaces) : undefined;
          const change =
            input.op === "add" ? `add: "${input.text}"` : input.op === "remove" ? `remove: "${current?.text ?? input.replaces}"` : `change "${current?.text ?? input.replaces}" to "${input.text}"`;
          return inputRequired({
            inputRequests: {
              approval: inputRequired.elicit({
                message:
                  `dotme: ${agent} wants to ${change} in ${input.category}.${input.when ? ` Suggested scope: ${input.when}.` : ""} Evidence: ${input.evidence}\n\n` +
                  "Accept saves it now. Decline or close this to decide on the approval page instead, where you can also reject it.",
                requestedSchema: approvalSchema,
              }),
            },
          });
        }
        const answer = acceptedContent(responses, "approval", approvalSchema);
        if (answer) {
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
        // Declined, dismissed, or an answer that did not fit the form: keep it as a pending proposal with a link, below.
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
    { description: "Open proposals in the categories this connection can access, oldest first.", annotations: READ_ONLY },
    async () => text(await listPending(store, caller().categories))
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

// Preferences as plain Markdown for scripts that copy them into a client at session start, such as
// the Claude Code and Codex SessionStart hook. The export token is read-only and may read every
// category; the hook picks which ones with ?categories=collab,coding (the default).
// /export/collab.md is the original single-category form, kept for hooks installed before plugins.
const DEFAULT_EXPORT: readonly Category[] = ["collab", "coding"];
const formatPrefs = (prefs: Preference[]) => prefs.map((p) => `- ${p.text}${p.when ? ` (when: ${p.when})` : ""}`).join("\n");
const markdown = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });

async function exportPreferences(request: Request, env: Env): Promise<Response> {
  const given = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.EXPORT_TOKEN || !(await samePassphrase(given, env.EXPORT_TOKEN))) return new Response("Unauthorized", { status: 401 });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const store = makeStore(env);
  if (url.pathname === "/export/collab.md") return markdown(`${formatPrefs(await getPreferences(store, "collab"))}\n`);

  const asked = url.searchParams.get("categories");
  const names = asked === null ? [...DEFAULT_EXPORT] : [...new Set(asked.split(",").map((c) => c.trim()).filter(Boolean))];
  const known = await listCategories(store);
  const unknown = names.filter((c) => !known.includes(c));
  if (names.length === 0 || unknown.length > 0) {
    return markdown(`Unknown category: ${unknown.join(", ") || "(none given)"}. Known: ${known.join(", ")}.\n`, 400);
  }
  const sections = await Promise.all(
    names.map(async (c) => `## ${c}\n\n${formatPrefs(await getPreferences(store, c)) || "(none yet)"}`)
  );
  return markdown(`${sections.join("\n\n")}\n`);
}

const AuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before the passphrase check: the status page is how a new install finds out what is missing.
    if (new URL(request.url).pathname === "/setup/status") return setupStatus(request, env);
    if (!env.OWNER_PASSPHRASE) return new Response("Server has no OWNER_PASSPHRASE set.", { status: 503 });
    const path = new URL(request.url).pathname;
    if (path === "/export" || path === "/export/collab.md") return exportPreferences(request, env);
    const approval = await handleApprovalPages(request, env.OWNER_PASSPHRASE, makeStore(env), env.OAUTH_KV);
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
        const signedIn = await hasSession(request, env.OWNER_PASSPHRASE);
        const boxes = (await listCategories(makeStore(env))).map(
          (c) => `<label><input type="checkbox" name="category" value="${escape(c)}" checked> <strong>${escape(c)}</strong>${CATEGORY_HINTS[c] ? `: ${CATEGORY_HINTS[c]}` : ""}</label><br>`
        ).join("\n");
        // Apps on this computer (Claude Code, Codex) can show their own approval dialog; web apps use the link.
        const inline = details.redirectIsLoopback ? " checked" : "";
        const owner = signedIn
          ? "<p>Signed in as the owner.</p>"
          : `${(await hasPasskeys(env.OAUTH_KV)) ? `<p><button type="button" onclick="passkey('login')">Sign in with passkey</button> or type the passphrase:</p>${PASSKEY_SCRIPT}` : ""}
  <p><label>Passphrase <input name="passphrase" type="password" required></label></p>`;
        return html(
          `<title>Connect ${escape(details.clientName)}</title>
<h1>Connect ${escape(details.clientName)} to dotme?</h1>
<p>${source} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <p><label>Agent name, shown on its proposals<br><input name="agent" required pattern="[a-z0-9-]{2,32}" value="${escape(suggestedAgentName(details.clientName))}" placeholder="claude-code"></label></p>
  <p>It may read and propose changes to:<br>${boxes}</p>
  <p><label><input type="checkbox" name="inline"${inline}> Approve changes in this app's own dialog. Leave it off for apps you do not fully trust; you then approve on a link. Apps that cannot show a dialog use the link anyway.</label></p>
  ${owner}
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
        // A signed-in owner (passkey or passphrase, here or on /approve) does not type the passphrase again.
        // Signing in here with the passphrase starts the same owner session, so /approve needs no second sign-in.
        let signIn: string | undefined;
        if (!(await hasSession(request, env.OWNER_PASSPHRASE))) {
          const check = await checkPassphrase(env.OAUTH_KV, request, String(form.get("passphrase") ?? ""), (given) => samePassphrase(given, env.OWNER_PASSPHRASE));
          if (!check.ok) {
            const plain = { "Content-Type": "text/plain; charset=utf-8" };
            if (check.lockedFor > 0) {
              return new Response(lockMessage(check.lockedFor), { status: 429, headers: { ...plain, "Retry-After": String(check.lockedFor) } });
            }
            return new Response("Wrong passphrase. Go back and start the connection again.", { status: 403, headers: plain });
          }
          signIn = await sessionCookie(env.OWNER_PASSPHRASE);
        }
        const agent = String(form.get("agent") ?? "");
        if (!/^[a-z0-9-]{2,32}$/.test(agent)) return new Response("Invalid agent name.", { status: 400 });
        const known = await listCategories(makeStore(env));
        const categories = form.getAll("category").map(String).filter((c) => known.includes(c));

        const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:read"] });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: "owner",
          metadata: { agent },
          scope: approved.request.scope,
          props: { agent, categories, inlineApproval: form.get("inline") === "on", authorizedAt: new Date().toISOString() },
        });
        approved.headers.set("Location", redirectTo);
        if (signIn) approved.headers.append("Set-Cookie", signIn);
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
  // Grok Bot signs in through Cursor's OAuth client, which uses cursor://anysphere.cursor-mcp/oauth/callback.
  // The owner still sees the destination on the consent page and must sign in; PKCE protects the code.
  allowPrivateUseRedirectUris: true,
  resourceMetadata: { resource: env.MCP_RESOURCE },
  // OAuth errors carry the failed check only in `internal`; log it so connection problems can be diagnosed.
  onError({ code, status, internal }) {
    console.warn(JSON.stringify({ oauthError: code, status, ...internal }));
  },
});
