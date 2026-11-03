// Passphrase rate limit: after 5 wrong passphrases from one address, every
// passphrase from it is refused for 15 minutes, even the right one. Passkeys
// still work during a lock. Counts live in KV and expire on their own.
//
// KV is eventually consistent, so parallel guesses can slip a few past the
// count; the limit still caps a guesser at a handful of tries per 15 minutes.

export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;

interface Attempts {
  failures: number;
  lockedUntil?: number;
}

// One key per address. IPv6 clients usually hold a whole /64, so they count as one.
export function clientKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `ratelimit:passphrase:${ip.includes(":") ? `${ipv6Prefix(ip)}::/64` : ip}`;
}

// The first four groups of an IPv6 address, with "::" expanded, e.g. 2001:db8::1 -> 2001:db8:0:0.
function ipv6Prefix(ip: string): string {
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

// Seconds until the lock ends, or 0 when this address may try a passphrase.
export async function lockedFor(kv: KVNamespace, request: Request, now = Date.now()): Promise<number> {
  const attempts = await kv.get<Attempts>(clientKey(request), "json");
  if (!attempts?.lockedUntil) return 0;
  return Math.max(0, Math.ceil((attempts.lockedUntil - now) / 1000));
}

// Records a wrong passphrase and returns the seconds this address is now locked for (0 if not yet).
export async function recordFailure(kv: KVNamespace, request: Request, now = Date.now()): Promise<number> {
  const key = clientKey(request);
  const previous = await kv.get<Attempts>(key, "json");
  const failures = (previous?.failures ?? 0) + 1;
  const attempts: Attempts = failures >= MAX_FAILURES ? { failures, lockedUntil: now + LOCK_SECONDS * 1000 } : { failures };
  // Failures are forgotten 15 minutes after the last one, and a lock ends with its key.
  await kv.put(key, JSON.stringify(attempts), { expirationTtl: LOCK_SECONDS });
  return attempts.lockedUntil ? LOCK_SECONDS : 0;
}

// A right passphrase clears the count. Only writes when there is something to clear.
export async function recordSuccess(kv: KVNamespace, request: Request): Promise<void> {
  const key = clientKey(request);
  if ((await kv.get(key)) !== null) await kv.delete(key);
}

export const lockMessage = (seconds: number) =>
  `Too many wrong passphrases. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minutes, or sign in with a passkey.`;

// The one passphrase check every sign-in uses: refuses while locked, counts failures.
export async function checkPassphrase(
  kv: KVNamespace,
  request: Request,
  given: string,
  same: (given: string) => Promise<boolean>
): Promise<{ ok: true } | { ok: false; lockedFor: number }> {
  const locked = await lockedFor(kv, request);
  if (locked > 0) return { ok: false, lockedFor: locked };
  if (await same(given)) {
    await recordSuccess(kv, request);
    return { ok: true };
  }
  return { ok: false, lockedFor: await recordFailure(kv, request) };
}
