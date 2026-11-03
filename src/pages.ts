// Owner-facing pages: sign-in with the passphrase, then the approval page.

import { approve, conflictsWith, getPreferences, getProposal, listPending, reject } from "./dotme";
import { CATEGORIES, cleanLine } from "./prefs";
import { authenticate, authenticationOptions, hasPasskeys, PASSKEY_SCRIPT, register, registrationOptions } from "./passkeys";
import type { Store } from "./store";

const COOKIE = "owner_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function html(body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
del{background:#fdd}ins{background:#dfd;text-decoration:none}.box{border:1px solid #ccc;border-radius:6px;padding:.75rem 1rem;margin:1rem 0}
button{font-size:1rem;padding:.4rem .9rem;margin-right:.5rem}input[type=text]{width:100%;font-size:1rem}</style>${body}`,
    { headers, status }
  );
}

// Constant-time comparison so the passphrase check does not leak through timing.
export async function samePassphrase(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  // timingSafeEqual is a Workers extension to SubtleCrypto.
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(a, b);
}

async function sessionKey(passphrase: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session:${passphrase}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(passphrase: string): Promise<string> {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(passphrase), new TextEncoder().encode(expires));
  return `${expires}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

export async function hasSession(request: Request, passphrase: string): Promise<boolean> {
  const value = request.headers.get("Cookie")?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
  if (!value) return false;
  const [expires, sig] = decodeURIComponent(value).split(".");
  if (!expires || !sig || Number(expires) < Date.now() / 1000) return false;
  try {
    const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return crypto.subtle.verify("HMAC", await sessionKey(passphrase), bytes, new TextEncoder().encode(expires));
  } catch {
    return false;
  }
}

// A form POST must come from this origin; SameSite=Lax on the cookie covers the rest.
function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

function signInPage(passkeys: boolean, error?: string): Response {
  return html(`<title>Sign in</title><h1>dotme</h1>
${error ? `<p><strong>${escape(error)}</strong></p>` : ""}
${passkeys ? `<p><button onclick="passkey('login')">Sign in with passkey</button></p><p>or use the passphrase:</p>${PASSKEY_SCRIPT}` : ""}
<form method="post"><input type="hidden" name="action" value="signin">
<p><label>Passphrase <input name="passphrase" type="password" required autofocus></label></p>
<p><button>Sign in</button></p></form>`, new Headers(), error ? 403 : 200);
}

async function sessionCookie(passphrase: string): Promise<string> {
  return `${COOKIE}=${encodeURIComponent(await signSession(passphrase))}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function handleApprovalPages(request: Request, passphrase: string, store: Store, kv: KVNamespace): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname.startsWith("/approve") && !sameOrigin(request)) return new Response("Bad origin", { status: 403 });

  const passkeyRoute = url.pathname.match(/^\/approve\/passkey\/(login-options|login|register-options|register)$/)?.[1];
  if (passkeyRoute && request.method === "POST") {
    if (passkeyRoute === "login-options") return authenticationOptions(kv, request);
    if (passkeyRoute === "login") {
      if (!(await authenticate(kv, request))) return new Response("Passkey not recognised", { status: 403 });
      return new Response(null, { status: 204, headers: { "Set-Cookie": await sessionCookie(passphrase) } });
    }
    if (!(await hasSession(request, passphrase))) return new Response("Sign in first", { status: 403 });
    return passkeyRoute === "register-options" ? registrationOptions(kv, request) : register(kv, request);
  }

  const match = url.pathname.match(/^\/approve(?:\/(q-[0-9a-f]{8}))?$/);
  if (!match) return null;

  const form = request.method === "POST" ? await request.formData() : null;
  if (form?.get("action") === "signin") {
    if (!(await samePassphrase(String(form.get("passphrase") ?? ""), passphrase))) return signInPage(await hasPasskeys(kv), "Wrong passphrase.");
    // Offer a passkey on the page the owner came for, so setting one up never costs a proposal.
    const headers = new Headers({ Location: `${url.pathname}?passkey=offer` });
    headers.append("Set-Cookie", await sessionCookie(passphrase));
    return new Response(null, { status: 303, headers });
  }
  if (!(await hasSession(request, passphrase))) return signInPage(await hasPasskeys(kv));

  const id = match[1];
  const offer = url.searchParams.get("passkey") === "offer" ? passkeyOffer(url.pathname) : "";
  if (!id) return pendingListPage(store, await hasPasskeys(kv), offer);

  if (form) {
    const decision = form.get("decision");
    if (decision === "approve") await approve(store, id, cleanLine(String(form.get("when") ?? ""), 120) || undefined);
    else if (decision === "reject") await reject(store, id);
    return new Response(null, { status: 303, headers: { Location: "/approve" } });
  }

  const found = await getProposal(store, id);
  if (!found) return html(`${offer}<h1>Already handled</h1><p>This proposal was approved, rejected or never existed.</p><p><a href="/approve">All pending</a></p>`, new Headers(), 404);
  const { proposal } = found;
  const current = (await getPreferences(store, proposal.category)).find((p) => p.id === proposal.replaces);
  const others = conflictsWith(proposal, await listPending(store, CATEGORIES));

  const diff =
    proposal.op === "add"
      ? `<ins>+ ${escape(proposal.text!)}</ins>`
      : proposal.op === "remove"
        ? `<del>- ${escape(current?.text ?? proposal.replaces!)}</del>`
        : `<del>- ${escape(current?.text ?? "")}</del><br><ins>+ ${escape(proposal.text!)}</ins>`;

  return html(`<title>Approve ${escape(proposal.id)}</title>${offer}
<h1>${escape(proposal.by)} wants to ${escape(proposal.op)} a <code>${escape(proposal.category)}</code> preference</h1>
<div class="box">${diff}</div>
<p><strong>Evidence:</strong> ${escape(proposal.evidence)}</p>
${others.length ? `<p><strong>Conflicts:</strong> ${others.map((o) => `<a href="/approve/${escape(o.id)}">${escape(o.by)}: ${escape(o.text ?? o.op)}</a>`).join(", ")}</p>` : ""}
<form method="post">
${proposal.op === "remove" ? "" : `<p><label>Only applies when (optional, e.g. "personal projects")<br><input type="text" name="when" value="${escape(proposal.when ?? "")}"></label></p>`}
<p><button name="decision" value="approve">Approve</button><button name="decision" value="reject">Reject</button></p>
</form><p><a href="/approve">All pending</a></p>`);
}

// Shown once after a passphrase sign-in. Registering reloads this same page without the offer.
function passkeyOffer(path: string): string {
  return `<div class="box"><p>You signed in with the passphrase. Set up a passkey on this device to sign in with Face ID or Touch ID next time.</p>
<p><button onclick="passkey('register')">Set up a passkey</button> <a href="${escape(path)}">Not now</a></p></div>${PASSKEY_SCRIPT}`;
}

async function pendingListPage(store: Store, passkeys: boolean, offer: string): Promise<Response> {
  const pending = await listPending(store, CATEGORIES);
  const rows = pending.map((p) => `<li><a href="/approve/${escape(p.id)}">${escape(p.by)} · ${escape(p.category)} · ${escape(p.op)}: ${escape(p.text ?? p.replaces ?? "")}</a></li>`);
  return html(`<title>Pending</title>${offer}<h1>Pending proposals</h1>${rows.length ? `<ul>${rows.join("")}</ul>` : "<p>Nothing pending.</p>"}
<p><button onclick="passkey('register')">${passkeys ? "Add a passkey on this device" : "Set up a passkey (Face ID or Touch ID)"}</button></p>${offer ? "" : PASSKEY_SCRIPT}`);
}
