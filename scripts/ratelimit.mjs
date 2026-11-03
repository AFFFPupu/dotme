// End-to-end check of passphrase rate limiting and passkey challenges against a running server.
// It locks this address out of passphrase sign-in for 15 minutes, so run it last.
// Usage: node scripts/ratelimit.mjs [baseUrl] [passphrase]
import assert from "node:assert/strict";
import { getToken } from "./oauth.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const passphrase = process.argv[3] ?? "local-test-passphrase";

const signIn = (given) =>
  fetch(`${base}/approve`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
    body: new URLSearchParams({ action: "signin", passphrase: given }),
  });

// Asking for a passkey challenge is open to anyone, so it must not be stored server side:
// it comes back in a signed cookie, and a tampered one is refused.
const options = await fetch(`${base}/approve/passkey/login-options`, { method: "POST", headers: { Origin: base } });
const challengeCookie = options.headers.getSetCookie().find((c) => c.startsWith("webauthn_nonce="))?.split(";")[0] ?? "";
const { challenge } = await options.json();
console.log("passkey challenge in a signed cookie:", challengeCookie.startsWith(`webauthn_nonce=${challenge}.`), challengeCookie.split(".").length === 3);
assert.ok(challengeCookie.startsWith(`webauthn_nonce=${challenge}.`) && challengeCookie.split(".").length === 3);
const tampered = challengeCookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
const forged = await fetch(`${base}/approve/passkey/login`, {
  method: "POST",
  headers: { Origin: base, Cookie: tampered, "Content-Type": "application/json" },
  body: JSON.stringify({ id: "x", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} }),
});
console.log("tampered challenge cookie:", forged.status);
assert.equal(forged.status, 403);

const statuses = [];
for (let i = 0; i < 5; i++) statuses.push((await signIn(`${passphrase}-wrong-${i}`)).status);
console.log("five wrong passphrases:", statuses.join(" "));
assert.deepEqual(statuses, [403, 403, 403, 403, 429]);

const locked = await signIn(passphrase);
const lockedPage = await locked.text();
console.log("right passphrase while locked:", locked.status, locked.headers.get("retry-after"), locked.headers.getSetCookie().length ? "session set" : "no session");
assert.equal(locked.status, 429);
assert.ok(Number(locked.headers.get("retry-after")) > 800);
assert.equal(locked.headers.getSetCookie().length, 0);
assert.match(lockedPage, /Too many wrong passphrases/);

let consentError = "";
try {
  await getToken(base, passphrase, "locked-out");
} catch (error) {
  consentError = String(error);
}
console.log("consent page while locked refuses the passphrase:", consentError !== "");
assert.ok(consentError !== "", "consent page accepted a passphrase while locked");
console.log("ratelimit: all checks passed");
