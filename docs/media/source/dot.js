// Dot, from docs/brand.md / src/brand.ts.
const GRID = ["................",".....OOOOOO.....","...OOAAAAAAOO...","..OAAWWAAAAAAO..","..OAWWAAAAAAAO..",".OAAAAAAAAAAAAO.",".OAAAEAAAAEAAAO.",".OAAAEAAAAEAAAO.",".OAPPAAAAAAPPAO.",".OAAAAAEEAAAAAO.",".OAAAAAAAAAAAAO.","..OAAAAAAAAAAO..","..OBAAAAAAAABO..","...OOBBBBBBOO...","....OO....OO....","................"];
const FACES = {
  idle: {},
  happy: {6:".OAAAEAAAAEAAAO.",7:".OAAEAEAAEAEAAO.",9:".OAAAAEAAEAAAAO.",10:".OAAAAAEEAAAAAO."},
  oops: {9:".OAAAAAAAAAAAAO.",10:".OAAAAAEEAAAAAO.",11:"..OAAAEAAEAAAO.."},
  blink: {6:".OAAAAAAAAAAAAO.",7:".OAAAEAAAAEAAAO."},
};
const FILL = {A:"#FFB547",B:"#E08A1E",P:"#FF7A8A",W:"#FFFFFF",E:"#2A2238"};
function dotSVG(size, mood = "idle", outline = "#2A2238") {
  let r = "";
  GRID.forEach((row0, y) => {
    const row = FACES[mood][y] ?? row0;
    for (let x = 0; x < 16;) { const c = row[x]; let e = x + 1; while (row[e] === c) e++;
      if (c !== ".") r += `<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="${c === "O" ? outline : FILL[c]}"/>`; x = e; }
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${r}</svg>`;
}
