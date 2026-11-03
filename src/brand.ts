// Dot, dotme's pixel mascot, drawn inline so the Worker serves no image files.
// The grid matches docs/brand.md. Outline pixels use the page's --outline color,
// so Dot keeps a visible outline in dark mode (Cream instead of Night).

export type Mood = "idle" | "happy" | "oops";

// One character per pixel; see docs/brand.md for the legend.
const GRID = [
  "................",
  ".....OOOOOO.....",
  "...OOAAAAAAOO...",
  "..OAAWWAAAAAAO..",
  "..OAWWAAAAAAAO..",
  ".OAAAAAAAAAAAAO.",
  ".OAAAEAAAAEAAAO.",
  ".OAAAEAAAAEAAAO.",
  ".OAPPAAAAAAPPAO.",
  ".OAAAAAEEAAAAAO.",
  ".OAAAAAAAAAAAAO.",
  "..OAAAAAAAAAAO..",
  "..OBAAAAAAAABO..",
  "...OOBBBBBBOO...",
  "....OO....OO....",
  "................",
];

// Reactions redraw only the face: rows 6, 7, 9 and 10.
const FACES: Record<Mood, Record<number, string>> = {
  idle: {},
  // Eyes closed in a smile (^ ^) and a wide grin.
  happy: {
    6: ".OAAAEAAAAEAAAO.",
    7: ".OAAEAEAAEAEAAO.",
    9: ".OAAAAEAAEAAAAO.",
    10: ".OAAAAAEEAAAAAO.",
  },
  // Wide eyes and a small frown.
  oops: {
    9: ".OAAAAAAAAAAAAO.",
    10: ".OAAAAAEEAAAAAO.",
    11: "..OAAAEAAEAAAO..",
  },
};

const FILL: Record<string, string> = { A: "#FFB547", B: "#E08A1E", P: "#FF7A8A", W: "#FFFFFF", E: "#2A2238" };

function rects(rows: string[]): string {
  const out: string[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x];
      let end = x + 1;
      while (row[end] === c) end++;
      if (c !== ".") {
        const paint = c === "O" ? `class="o"` : `fill="${FILL[c]}"`;
        out.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" ${paint}/>`);
      }
      x = end;
    }
  });
  return out.join("");
}

const BODIES = Object.fromEntries(
  (Object.keys(FACES) as Mood[]).map((mood) => [mood, rects(GRID.map((row, y) => FACES[mood][y] ?? row))])
) as Record<Mood, string>;

// Dot at a whole-number scale of its 16 px grid, so pixels stay square.
export function dot(size = 32, mood: Mood = "idle", label = ""): string {
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="dot" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" ${a11y}>${BODIES[mood]}</svg>`;
}

// The Silkscreen wordmark, outlined (copied from assets/brand/logo.svg and moved to x = 0).
const WORDMARK_PATH =
  "M0 12.6V5.725H4.125V7.1H5.5V11.225H4.125V12.6ZM1.375 11.225H4.07V7.1H1.375Z M9.625 12.6V11.225H8.25V7.1H9.625V5.725H12.375V7.1H13.75V11.225H12.375V12.6ZM9.625 11.17H12.375V7.155H9.625Z M17.875 12.6V7.1H16.5V5.725H20.625V7.1H19.25V12.6Z M23.375 12.6V5.725H24.75V7.1H26.125V8.475H27.5V9.85H26.125V8.475H24.75V12.6ZM28.875 12.6V8.475H27.5V7.1H28.875V5.725H30.25V12.6Z M33 12.6V5.725H37.125V7.1H34.375V8.475H37.125V9.85H34.375V11.225H37.125V12.6Z";

export function wordmark(height = 32): string {
  // The glyphs span y 5.725 to 12.6; crop to them with one Dot-pixel of room.
  const width = Math.round((height * 39.125) / 8.875);
  return `<svg class="wordmark" width="${width}" height="${height}" viewBox="-1 4.725 39.125 8.875" role="img" aria-label="dotme"><path d="${WORDMARK_PATH}"/></svg>`;
}

// The favicon is Dot with the light-mode outline, as an inline SVG data URL.
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><style>.o{fill:#2A2238}</style>${BODIES.idle}</svg>`
)}`;

// Dot saying something, in a game-style dialog box. `text` is trusted HTML.
export function say(text: string, mood: Mood = "idle"): string {
  return `<div class="say ${mood}">${dot(64, mood)}<div class="bubble">${text}</div></div>`;
}
