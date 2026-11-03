// Owner-facing pages: sign-in with the passphrase, then the approval page.

import { approve, approveFound, conflictsWith, getPreferences, getProposal, listPending, ProposalError, reject, rejectFound } from "./dotme";
import type { Category, Preference, Proposal } from "./prefs";
import { cleanLine } from "./prefs";
import { authenticate, authenticationOptions, hasPasskeys, PASSKEY_SCRIPT, register, registrationOptions } from "./passkeys";
import { checkPassphrase, lockMessage } from "./ratelimit";
import type { Store } from "./store";
import { lastTokenExpiry } from "./store";
import { escape, html } from "./html";
import { expiryWarning, parseTokenExpiry } from "./setup";

export { escape, html };

const COOKIE = "owner_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

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

function signInPage(passkeys: boolean, error?: string, status = 403): Response {
  return html(`<title>Sign in</title><h1>dotme</h1>
${error ? `<p><strong>${escape(error)}</strong></p>` : ""}
${passkeys ? `<p><button onclick="passkey('login')">Sign in with passkey</button></p><p>or use the passphrase:</p>${PASSKEY_SCRIPT}` : ""}
<form method="post"><input type="hidden" name="action" value="signin">
<p><label>Passphrase <input name="passphrase" type="password" required autofocus></label></p>
<p><button>Sign in</button></p></form>`, new Headers(), error ? status : 200);
}

export async function sessionCookie(passphrase: string): Promise<string> {
  return `${COOKIE}=${encodeURIComponent(await signSession(passphrase))}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function handleApprovalPages(request: Request, passphrase: string, store: Store, kv: KVNamespace): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname.startsWith("/approve") && !sameOrigin(request)) return new Response("Bad origin", { status: 403 });

  const passkeyRoute = url.pathname.match(/^\/approve\/passkey\/(login-options|login|register-options|register)$/)?.[1];
  if (passkeyRoute && request.method === "POST") {
    if (passkeyRoute === "login-options") return authenticationOptions(request, passphrase);
    if (passkeyRoute === "login") {
      if (!(await authenticate(kv, request, passphrase))) return new Response("Passkey not recognised", { status: 403 });
      return new Response(null, { status: 204, headers: { "Set-Cookie": await sessionCookie(passphrase) } });
    }
    if (!(await hasSession(request, passphrase))) return new Response("Sign in first", { status: 403 });
    return passkeyRoute === "register-options" ? registrationOptions(kv, request, passphrase) : register(kv, request, passphrase);
  }

  const match = url.pathname.match(/^\/approve(?:\/(q-[0-9a-f]{8}))?$/);
  if (!match) return null;

  const form = request.method === "POST" ? await request.formData() : null;
  if (form?.get("action") === "signin") {
    const check = await checkPassphrase(kv, request, String(form.get("passphrase") ?? ""), (given) => samePassphrase(given, passphrase));
    if (!check.ok) {
      if (check.lockedFor > 0) {
        const page = signInPage(await hasPasskeys(kv), lockMessage(check.lockedFor), 429);
        page.headers.set("Retry-After", String(check.lockedFor));
        return page;
      }
      return signInPage(await hasPasskeys(kv), "Wrong passphrase.");
    }
    // Offer a passkey on the page the owner came for, so setting one up never costs a proposal.
    const headers = new Headers({ Location: `${url.pathname}?passkey=offer` });
    headers.append("Set-Cookie", await sessionCookie(passphrase));
    return new Response(null, { status: 303, headers });
  }
  if (!(await hasSession(request, passphrase))) return signInPage(await hasPasskeys(kv));

  const id = match[1];
  const offer = url.searchParams.get("passkey") === "offer" ? passkeyOffer(url.pathname) : "";
  if (!id) {
    if (form) return batchDecision(store, form);
    return pendingListPage(store, await hasPasskeys(kv), offer, resultNotice(url.searchParams));
  }

  if (form) {
    const decision = form.get("decision");
    try {
      if (decision === "approve") await approve(store, id, cleanLine(String(form.get("when") ?? ""), 120) || undefined);
      else if (decision === "reject") await reject(store, id);
      else return new Response(null, { status: 303, headers: { Location: `/approve/${id}` } });
    } catch (error) {
      return errorPage(error, id);
    }
    return new Response(null, { status: 303, headers: { Location: `/approve?${decision === "approve" ? "approved" : "rejected"}=1` } });
  }

  const found = await getProposal(store, id);
  if (!found) return html(`<title>Already handled</title>${offer}<h1>Already handled</h1><p>This proposal was approved, rejected or never existed.</p><p><a href="/approve">All pending</a></p>`, new Headers(), 404);
  const { proposal } = found;
  const current = (await getPreferences(store, proposal.category)).find((p) => p.id === proposal.replaces);
  const others = conflictsWith(proposal, await listPending(store));

  return html(`<title>Approve ${escape(proposal.id)}</title>${offer}${tokenWarning()}
<h1>${escape(proposal.by)} wants to ${escape(proposal.op)} a <code>${escape(proposal.category)}</code> preference</h1>
<div class="box">${diff(proposal, current)}</div>
<p><strong>Evidence:</strong> ${escape(proposal.evidence)}</p>
${others.length ? `<p><strong>Conflicts:</strong> ${others.map((o) => `<a href="/approve/${escape(o.id)}">${escape(o.by)}: ${escape(o.text ?? o.op)}</a>`).join(", ")}</p>` : ""}
<form method="post">
${proposal.op === "remove" ? "" : `<p><label>Only applies when (optional, e.g. "personal projects")<br><input type="text" name="when" value="${escape(proposal.when ?? "")}"></label></p>`}
<p class="actions"><button name="decision" value="approve">Approve</button><button name="decision" value="reject" class="secondary">Reject</button></p>
</form><p><a href="/approve">All pending</a></p>`);
}

function diff(proposal: Proposal, current: Preference | undefined): string {
  if (proposal.op === "add") return `<ins>+ ${escape(proposal.text!)}</ins>`;
  if (proposal.op === "remove") return `<del>- ${escape(current?.text ?? proposal.replaces!)}</del>`;
  return `<del>- ${escape(current?.text ?? proposal.replaces ?? "")}</del><br><ins>+ ${escape(proposal.text!)}</ins>`;
}

// A decision that could not be made: a page that says why, not a server error.
function errorPage(error: unknown, id?: string): Response {
  const known = error instanceof ProposalError;
  const detail = error instanceof Error ? error.message : String(error);
  // The store's own errors name the GitHub call and status, never the token.
  const hint = /: 40[13]$/.test(detail) ? ` The GitHub token may have expired or lost access; see <a href="/setup/status">setup status</a>.` : "";
  if (!known) console.error(JSON.stringify({ approvalError: detail, proposal: id }));
  return html(`<title>Not saved</title><h1>${known ? "Could not do that" : "Nothing was saved"}</h1>
<div class="box"><p>${escape(detail)}${hint}</p></div>
<p>${id ? `<a href="/approve/${escape(id)}">Back to the proposal</a> · ` : ""}<a href="/approve">All pending</a></p>`, new Headers(), known ? 409 : 502);
}

// Most proposals a single request decides. Each approval is a few GitHub calls and a Worker request
// has a subrequest budget, so a longer selection is decided over several presses.
export const BATCH_LIMIT = 10;

// Approve or reject the proposals ticked on the pending list. Each approval is still its own commit.
// Proposals touching the same preference are skipped: they need a decision one at a time.
async function batchDecision(store: Store, form: FormData): Promise<Response> {
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "reject") return new Response(null, { status: 303, headers: { Location: "/approve" } });
  const ids = [...new Set(form.getAll("id").map(String))];
  const chosen = ids.slice(0, BATCH_LIMIT);
  const counts = { done: 0, gone: 0, skipped: 0, failed: 0, left: ids.length - chosen.length };

  const found = (await Promise.all(chosen.map((id) => getProposal(store, id)))).filter((f) => f !== null);
  counts.gone = chosen.length - found.length;
  const proposals = found.map((f) => f.proposal);
  for (const item of found) {
    if (decision === "approve" && conflictsWith(item.proposal, proposals).length) {
      counts.skipped++;
      continue;
    }
    try {
      if (decision === "approve") await approveFound(store, item, item.proposal.when);
      else await rejectFound(store, item);
      counts.done++;
    } catch (error) {
      if (!(error instanceof ProposalError)) console.error(JSON.stringify({ approvalError: String(error), proposal: item.proposal.id }));
      counts.failed++;
    }
  }
  const query = new URLSearchParams({ [decision === "approve" ? "approved" : "rejected"]: String(counts.done) });
  for (const key of ["gone", "skipped", "failed", "left"] as const) if (counts[key]) query.set(key, String(counts[key]));
  return new Response(null, { status: 303, headers: { Location: `/approve?${query}` } });
}

// What the last decision did, from the redirect's query. Only numbers are read back.
function resultNotice(params: URLSearchParams): string {
  const n = (key: string) => Math.max(0, Math.floor(Number(params.get(key)) || 0));
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (params.has("approved")) parts.push(`Approved ${plural(n("approved"), "proposal")}.`);
  if (params.has("rejected")) parts.push(`Rejected ${plural(n("rejected"), "proposal")}.`);
  if (n("gone")) parts.push(`${plural(n("gone"), "proposal")} had already been handled.`);
  if (n("skipped")) parts.push(`Skipped ${plural(n("skipped"), "proposal")} that conflict with each other; open them to decide one at a time.`);
  if (n("failed")) parts.push(`${plural(n("failed"), "proposal")} could not be saved and ${n("failed") === 1 ? "is" : "are"} still pending; open ${n("failed") === 1 ? "it" : "them"} to see why.`);
  if (n("left")) parts.push(`${plural(n("left"), "more proposal")} ${n("left") === 1 ? "was" : "were"} not decided yet: at most ${BATCH_LIMIT} go at once, so press again.`);
  return parts.length ? `<div class="box notice" role="status"><p>${parts.join(" ")}</p></div>` : "";
}

// Warns on owner pages once the GitHub token has under 30 days left. Read after the page's own
// store calls, which record the expiry GitHub sends; KV storage has no token and shows nothing.
function tokenWarning(): string {
  const header = lastTokenExpiry();
  return header ? expiryWarning(parseTokenExpiry(header)) : "";
}

// Shown once after a passphrase sign-in. Registering reloads this same page without the offer.
function passkeyOffer(path: string): string {
  return `<div class="box"><p>You signed in with the passphrase. Set up a passkey on this device to sign in with Face ID or Touch ID next time.</p>
<p><button onclick="passkey('register')">Set up a passkey</button> <a href="${escape(path)}">Not now</a></p></div>${PASSKEY_SCRIPT}`;
}

async function pendingListPage(store: Store, passkeys: boolean, offer: string, notice: string): Promise<Response> {
  const pending = await listPending(store);
  const categories = [...new Set(pending.filter((p) => p.replaces).map((p) => p.category))];
  const prefs = new Map<Category, Preference[]>(await Promise.all(categories.map(async (c) => [c, await getPreferences(store, c)] as const)));
  const cards = pending.map((p) => {
    const conflict = conflictsWith(p, pending).length > 0;
    const current = prefs.get(p.category)?.find((pref) => pref.id === p.replaces);
    return `<div class="box card"><label class="pick"><input type="checkbox" name="id" value="${escape(p.id)}"${conflict ? "" : " checked"}>
<span><strong>${escape(p.by)}</strong> · <code>${escape(p.category)}</code> · ${escape(p.op)}</span></label>
<div class="diff">${diff(p, current)}</div>
${p.when ? `<p class="meta">Only when: ${escape(p.when)}</p>` : ""}<p class="meta">Evidence: ${escape(p.evidence)}</p>
${conflict ? `<p class="meta"><strong>Conflicts with another proposal.</strong> Not ticked; decide it on its own page.</p>` : ""}
<p class="meta"><a href="/approve/${escape(p.id)}">Open${p.op === "remove" ? "" : " to set when it applies"}</a></p></div>`;
  });
  const list = cards.length
    ? `<form method="post">${cards.join("\n")}
<div class="actions bar"><button name="decision" value="approve">Approve ticked</button><button name="decision" value="reject" class="secondary">Reject ticked</button></div></form>`
    : "<p>Nothing pending.</p>";
  return html(`<title>Pending${pending.length ? ` (${pending.length})` : ""}</title>${offer}${notice}${tokenWarning()}<h1>Pending proposals</h1>
${pending.length > 1 ? `<p>Everything is ticked except proposals that conflict. Each approval is saved as its own commit.</p>` : ""}${list}
<p><button onclick="passkey('register')" class="secondary">${passkeys ? "Add a passkey on this device" : "Set up a passkey (Face ID or Touch ID)"}</button></p>${offer ? "" : PASSKEY_SCRIPT}`);
}
