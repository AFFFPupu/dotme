// Shared HTML for every page the Worker serves: the owner pages, the consent page,
// the setup status page and error pages. One layout, in the Dot brand (docs/brand.md).

import { dot, FAVICON, say, wordmark } from "./brand";
import type { Mood } from "./brand";

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Palette from docs/brand.md: Night #2A2238, Dot #FFB547, Ember #E08A1E, Blush #FF7A8A, Cream #FFF4E2.
const STYLE = `:root{color-scheme:light dark;--bg:#fff4e2;--card:#fffdf8;--fg:#2a2238;--muted:#6b6178;--line:#2a2238;--soft:#e9dcc6;
--outline:#2a2238;--shadow:#2a2238;--accent:#ffb547;--accent-fg:#2a2238;--del:#ffd9dd;--ins:#dcf3d2;--note:#fff0d1;
--ok:#3f8f4f;--warn:#e08a1e;--fail:#d9475a}
@media (prefers-color-scheme:dark){:root{--bg:#1d1727;--card:#2a2238;--fg:#fff4e2;--muted:#b9aec8;--line:#fff4e2;--soft:#43385a;
--outline:#fff4e2;--shadow:#120e19;--del:#5a2630;--ins:#1f4a2b;--note:#3d2f22;--ok:#7fd18c;--warn:#ffb547;--fail:#ff7a8a}}
*{box-sizing:border-box}
body{font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:42rem;margin:0 auto;padding:1.25rem 1rem 2rem;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
a{color:inherit;text-decoration-color:var(--warn);text-underline-offset:.2em}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:.05em .3em}
.dot{image-rendering:pixelated;flex:none}.dot .o{fill:var(--outline)}.wordmark{fill:var(--fg)}
header.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.brand{display:flex;align-items:center;gap:.5rem;text-decoration:none}
main{background:var(--card);border:2px solid var(--line);box-shadow:4px 4px 0 var(--shadow);padding:.5rem 1.25rem 1rem}
footer{margin-top:1.5rem;color:var(--muted);font-size:.85rem;text-align:center}
h1{font-size:1.4rem;line-height:1.25;margin:1rem 0 .75rem}
.box{border:2px solid var(--soft);padding:.75rem 1rem;margin:1rem 0;background:var(--card)}
.notice{border-color:var(--accent);background:var(--note)}
.meta{color:var(--muted);font-size:.9rem;margin:.4rem 0}.diff{margin:.5rem 0}
del{background:var(--del)}ins{background:var(--ins);text-decoration:none}
.pick{display:flex;gap:.6rem;align-items:center;cursor:pointer}.pick input{width:1.4rem;height:1.4rem;flex:none;accent-color:var(--warn)}
input[type=checkbox]{accent-color:var(--warn)}
button,.button{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;font:600 1rem system-ui,sans-serif;min-height:2.75rem;padding:.5rem 1.1rem;margin:0 .5rem .5rem 0;border:2px solid var(--line);background:var(--accent);color:var(--accent-fg);box-shadow:3px 3px 0 var(--shadow);cursor:pointer}
button:active,.button:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--shadow)}
.secondary{background:transparent;color:var(--fg)}
input[type=text],input[type=password],input:not([type]){width:100%;font-size:1rem;padding:.55rem .6rem;border:2px solid var(--line);background:var(--bg);color:var(--fg);margin-top:.25rem}
input:focus-visible,button:focus-visible{outline:3px solid var(--warn);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:.5rem}.actions button,.actions .button{margin:0}
.bar{position:sticky;bottom:0;background:var(--card);padding:.75rem 0;border-top:2px solid var(--soft)}
.say{display:flex;gap:1rem;align-items:center;margin:1.25rem 0}
.bubble{position:relative;flex:1;border:2px solid var(--line);background:var(--bg);padding:.65rem .9rem}
.bubble::before{content:"";position:absolute;left:-10px;top:calc(50% - 6px);width:8px;height:12px;background:var(--line);clip-path:polygon(100% 0,0 50%,100% 100%)}
.bubble p{margin:.2rem 0}
.box>:first-child{margin-top:0}.box>:last-child{margin-bottom:0}
.checks{list-style:none;padding:0}.checks li{border-top:2px solid var(--soft);padding:.6rem 0;display:flex;gap:.75rem;align-items:baseline}
.tag{flex:none;min-width:3.4rem;text-align:center;font:700 .75rem ui-monospace,Menlo,monospace;letter-spacing:.05em;border:2px solid currentColor;padding:.05rem .3rem}
.tag.ok{color:var(--ok)}.tag.warn{color:var(--warn)}.tag.fail{color:var(--fail)}.tag.skip{color:var(--muted)}
@media (max-width:30rem){body{padding:.75rem .75rem 1.5rem}main{padding:.25rem .9rem .75rem}.actions button,.actions .button{flex:1 1 8rem}.say .dot{width:48px;height:48px}}`;

const HEADER = `<header class="top"><a class="brand" href="/" aria-label="dotme home">${dot(32, "idle")}${wordmark(24)}</a></header>`;
const FOOTER = `<footer>Dot follows you to every agent.</footer>`;

// `body` starts with the page's <title>; the rest goes inside the shared card.
export function html(body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Frame-Options", "DENY");
  const title = body.match(/^\s*<title>[\s\S]*?<\/title>/)?.[0] ?? "<title>dotme</title>";
  const content = body.slice(body.indexOf(title) === -1 ? 0 : body.indexOf(title) + title.length);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${title}<link rel="icon" href="${FAVICON}"><style>${STYLE}</style></head>
<body>${HEADER}<main>${content}</main>${FOOTER}</body></html>`,
    { headers, status }
  );
}

// A short page where Dot explains what happened, for errors and dead ends.
export function messagePage(title: string, text: string, mood: Mood, status: number, links = ""): Response {
  return html(`<title>${escape(title)}</title><h1>${escape(title)}</h1>${say(text, mood)}${links ? `<p>${links}</p>` : ""}`, new Headers(), status);
}

export { dot, say };
