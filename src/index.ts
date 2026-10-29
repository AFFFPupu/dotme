// Memory passport test server: OAuth-protected MCP endpoint with sample data.
// Goal: prove which auth flow each client (Grok Bot, Claude) runs, and that the
// server can tell connected agents apart. Preferences are hard-coded for now.

import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OWNER_PASSPHRASE: string;
  MCP_RESOURCE: string;
}

const SAMPLE: Record<string, string[]> = {
  collab: [
    "Reply in natural Chinese; keep code, paths and English tech terms in English.",
    "Recommend one option instead of offering a menu.",
    "Ask before any outward-facing action.",
  ],
  coding: ["Prefer Cloudflare over Supabase for personal projects. (when: personal projects)"],
  life: ["Timezone: Europe/London."],
};

function createServer() {
  const server = new McpServer({ name: "memory-passport-test", version: "0.0.1" });

  server.registerTool(
    "whoami",
    { description: "Which agent this connection was authorized as, and how." },
    async (context) => {
      const auth = getMcpAuthContext();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agent: auth?.props.agent,
              authorizedAt: auth?.props.authorizedAt,
              clientId: context.http?.authInfo?.clientId,
              scopes: context.http?.authInfo?.scopes,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_categories",
    { description: "List preference categories and how many items each holds." },
    async () => ({
      content: [
        { type: "text", text: JSON.stringify(Object.fromEntries(Object.entries(SAMPLE).map(([k, v]) => [k, v.length]))) },
      ],
    })
  );

  server.registerTool(
    "get_preferences",
    {
      description: "Get the user's preferences in one category. Test data only.",
      inputSchema: { category: z.enum(["collab", "coding", "life"]) },
    },
    async ({ category }) => ({
      content: [{ type: "text", text: SAMPLE[category].map((p) => `- ${p}`).join("\n") }],
    })
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, headers = new Headers()) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${body}`, { headers });
};

// Constant-time comparison so the passphrase check does not leak through timing.
async function samePassphrase(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s)))
  );
  // timingSafeEqual is a Workers extension to SubtleCrypto.
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(a, b);
}

const AuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("memory-passport test server", { status: 200 });

    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        const origin = details.clientDomain
          ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
          : "This app registered itself; its name is not verified.";
        return html(
          `<title>Connect ${escape(details.clientName)}</title>
<h1>Connect ${escape(details.clientName)} to your memory passport?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Scopes: ${details.scope.map(escape).join(", ") || "(none)"}</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <p><label>Name this agent <input name="agent" required pattern="[a-z0-9-]{2,32}" placeholder="grok-bot"></label></p>
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
        if (!env.OWNER_PASSPHRASE) return new Response("Server has no OWNER_PASSPHRASE set.", { status: 503 });
        if (!(await samePassphrase(String(form.get("passphrase") ?? ""), env.OWNER_PASSPHRASE))) {
          return new Response("Wrong passphrase. Go back and start the connection again.", { status: 403 });
        }
        const agent = String(form.get("agent") ?? "");
        if (!/^[a-z0-9-]{2,32}$/.test(agent)) return new Response("Invalid agent name.", { status: 400 });

        const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:read"] });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: "owner",
          metadata: { agent },
          scope: approved.request.scope,
          props: { agent, authorizedAt: new Date().toISOString() },
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
  resourceMetadata: { resource: (workerEnv as unknown as Env).MCP_RESOURCE },
});
