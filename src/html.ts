// Shared HTML helpers for the owner pages and the setup status page.

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
