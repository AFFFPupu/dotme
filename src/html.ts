// Shared HTML helpers for the owner pages and the setup status page.

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function html(body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#ccc;--del:#fdd;--ins:#dfd;--accent:#2a2238;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#17141f;--fg:#eee;--muted:#aaa;--line:#444;--del:#5a2630;--ins:#1f4a2b;--accent:#ffb547;--accent-fg:#2a2238}}
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
h1{font-size:1.5rem;line-height:1.25}a{color:inherit}
del{background:var(--del)}ins{background:var(--ins);text-decoration:none}.box{border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem;margin:1rem 0}
.meta{color:var(--muted);font-size:.9rem;margin:.4rem 0}.diff{margin:.5rem 0}.pick{display:flex;gap:.6rem;align-items:center;cursor:pointer}
.pick input{width:1.4rem;height:1.4rem;flex:none}.notice{border-color:var(--accent)}
button{font-size:1rem;min-height:2.75rem;padding:.5rem 1rem;margin:0 .5rem .5rem 0;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;font-size:1rem;padding:.5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.actions{display:flex;flex-wrap:wrap;gap:.5rem}.actions button{margin:0}.bar{position:sticky;bottom:0;background:var(--bg);padding:.75rem 0;border-top:1px solid var(--line)}
@media (max-width:30rem){body{margin:1rem auto}.actions button{flex:1 1 8rem}}</style>${body}`,
    { headers, status }
  );
}
