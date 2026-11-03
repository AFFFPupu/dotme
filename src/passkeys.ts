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

export async function countPasskeys(kv: KVNamespace): Promise<number> {
  return (await kv.list({ prefix: "passkey:" })).keys.length;
}

export async function hasPasskeys(kv: KVNamespace): Promise<boolean> {
  return (await kv.list({ prefix: "passkey:", limit: 1 })).keys.length > 0;
}

// The challenge is not stored: it travels in a signed, five-minute cookie bound to this browser, so
// asking for one (which anyone can do) writes nothing to KV. A challenge is marked used in KV only
// after a passkey answered it, which takes a registered passkey, so it cannot be replayed.
const CHALLENGE_SECONDS = 300;

async function challengeKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`webauthn:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function challengeCookie(secret: string, challenge: string): Promise<string> {
  const payload = `${challenge}.${Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS}`;
  const sig = toB64url(new Uint8Array(await crypto.subtle.sign("HMAC", await challengeKey(secret), new TextEncoder().encode(payload))));
  return `${NONCE_COOKIE}=${payload}.${sig}; Path=/approve; Max-Age=${CHALLENGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

// The challenge this browser was given, if its cookie is genuine, unexpired and not used yet.
async function readChallenge(kv: KVNamespace, secret: string, request: Request): Promise<string | null> {
  const value = request.headers.get("Cookie")?.match(new RegExp(`${NONCE_COOKIE}=([^;]+)`))?.[1];
  const [challenge, expires, sig] = value?.split(".") ?? [];
  if (!challenge || !expires || !sig || Number(expires) < Date.now() / 1000) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await challengeKey(secret), fromB64url(sig), new TextEncoder().encode(`${challenge}.${expires}`));
    if (!ok || (await kv.get(`webauthn-used:${challenge}`)) !== null) return null;
  } catch {
    return null;
  }
  return challenge;
}

const markUsed = (kv: KVNamespace, challenge: string) => kv.put(`webauthn-used:${challenge}`, "1", { expirationTtl: CHALLENGE_SECONDS });

const json = (body: unknown, cookie?: string) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { headers });
};

export async function registrationOptions(kv: KVNamespace, request: Request, secret: string): Promise<Response> {
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
  return json(options, await challengeCookie(secret, options.challenge));
}

export async function register(kv: KVNamespace, request: Request, secret: string): Promise<Response> {
  const url = new URL(request.url);
  const expectedChallenge = await readChallenge(kv, secret, request);
  if (!expectedChallenge) return new Response("Expired, try again", { status: 400 });
  const result = await verifyRegistrationResponse({
    response: (await request.json()) as RegistrationResponseJSON,
    expectedChallenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: true,
  });
  if (!result.verified) return new Response("Passkey not verified", { status: 400 });
  await markUsed(kv, expectedChallenge);
  const { credential } = result.registrationInfo;
  const stored: StoredPasskey = { publicKey: toB64url(credential.publicKey), counter: credential.counter, transports: credential.transports };
  await kv.put(`passkey:${credential.id}`, JSON.stringify(stored));
  return json({ ok: true });
}

export async function authenticationOptions(request: Request, secret: string): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: new URL(request.url).hostname, userVerification: "required" });
  return json(options, await challengeCookie(secret, options.challenge));
}

// Returns true when the response proves possession of a registered passkey.
export async function authenticate(kv: KVNamespace, request: Request, secret: string): Promise<boolean> {
  const url = new URL(request.url);
  const expectedChallenge = await readChallenge(kv, secret, request);
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
  await markUsed(kv, expectedChallenge);
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
