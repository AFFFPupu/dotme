// Passkey (WebAuthn) sign-in for the owner pages, so approving is a Face ID or
// Touch ID prompt instead of typing the passphrase. Passkeys are added from a
// signed-in session; the passphrase stays as the fallback.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";

interface StoredPasskey {
  publicKey: string;
  counter: number;
  transports?: string[];
}

const NONCE_COOKIE = "webauthn_nonce";
const toB64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function listPasskeys(kv: KVNamespace): Promise<{ id: string; stored: StoredPasskey }[]> {
  const { keys } = await kv.list({ prefix: "passkey:" });
  return Promise.all(keys.map(async (k) => ({ id: k.name.slice("passkey:".length), stored: (await kv.get<StoredPasskey>(k.name, "json"))! })));
}

export async function hasPasskeys(kv: KVNamespace): Promise<boolean> {
  return (await kv.list({ prefix: "passkey:", limit: 1 })).keys.length > 0;
}

// The challenge lives in KV for five minutes, keyed by a nonce in a cookie bound to this browser.
async function saveChallenge(kv: KVNamespace, challenge: string): Promise<string> {
  const nonce = toB64url(crypto.getRandomValues(new Uint8Array(16)));
  await kv.put(`webauthn:${nonce}`, challenge, { expirationTtl: 300 });
  return `${NONCE_COOKIE}=${nonce}; Path=/approve; Max-Age=300; HttpOnly; Secure; SameSite=Strict`;
}

async function takeChallenge(kv: KVNamespace, request: Request): Promise<string | null> {
  const nonce = request.headers.get("Cookie")?.match(new RegExp(`${NONCE_COOKIE}=([^;]+)`))?.[1];
  if (!nonce) return null;
  const challenge = await kv.get(`webauthn:${nonce}`);
  await kv.delete(`webauthn:${nonce}`);
  return challenge;
}

const json = (body: unknown, cookie?: string) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { headers });
};

export async function registrationOptions(kv: KVNamespace, request: Request): Promise<Response> {
  const rpID = new URL(request.url).hostname;
  const existing = await listPasskeys(kv);
  const options = await generateRegistrationOptions({
    rpName: "dotme",
    rpID,
    userName: "owner",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.stored.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return json(options, await saveChallenge(kv, options.challenge));
}

export async function register(kv: KVNamespace, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const expectedChallenge = await takeChallenge(kv, request);
  if (!expectedChallenge) return new Response("Expired, try again", { status: 400 });
  const result = await verifyRegistrationResponse({
    response: (await request.json()) as RegistrationResponseJSON,
    expectedChallenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: true,
  });
  if (!result.verified) return new Response("Passkey not verified", { status: 400 });
  const { credential } = result.registrationInfo;
  const stored: StoredPasskey = { publicKey: toB64url(credential.publicKey), counter: credential.counter, transports: credential.transports };
  await kv.put(`passkey:${credential.id}`, JSON.stringify(stored));
  return json({ ok: true });
}

export async function authenticationOptions(kv: KVNamespace, request: Request): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: new URL(request.url).hostname, userVerification: "required" });
  return json(options, await saveChallenge(kv, options.challenge));
}

// Returns true when the response proves possession of a registered passkey.
export async function authenticate(kv: KVNamespace, request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const expectedChallenge = await takeChallenge(kv, request);
  if (!expectedChallenge) return false;
  const response = (await request.json()) as AuthenticationResponseJSON;
  const stored = await kv.get<StoredPasskey>(`passkey:${response.id}`, "json");
  if (!stored) return false;
  const credential: WebAuthnCredential = { id: response.id, publicKey: fromB64url(stored.publicKey), counter: stored.counter, transports: stored.transports };
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    credential,
    requireUserVerification: true,
  });
  if (!result.verified) return false;
  await kv.put(`passkey:${response.id}`, JSON.stringify({ ...stored, counter: result.authenticationInfo.newCounter }));
  return true;
}

// Browser side: the JSON helpers on PublicKeyCredential do the base64url conversions.
export const PASSKEY_SCRIPT = `<script>
async function passkey(kind) {
  try {
    const options = await (await fetch('/approve/passkey/' + kind + '-options', { method: 'POST' })).json();
    const credential = kind === 'register'
      ? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })
      : await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    const res = await fetch('/approve/passkey/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credential.toJSON()) });
    if (!res.ok) throw new Error(await res.text());
    if (kind === 'register') alert('Passkey added. Next time, sign in with it.');
    const next = new URL(location.href);
    next.searchParams.delete('passkey');
    location.replace(next);
  } catch (e) {
    if (kind === 'register' && e.name === 'InvalidStateError') alert('This device already has a dotme passkey. Sign in with it next time.');
    else if (e.name === 'NotAllowedError') alert('No passkey was used. The prompt was cancelled or timed out.');
    else alert('Passkey failed: ' + e.message);
  }
}
</script>`;
