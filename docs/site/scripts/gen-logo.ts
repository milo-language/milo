// Milo pixel-logo generator. Edit PIXELS below (one char = one square), then run:
//   bun docs/site/scripts/gen-logo.ts
// Output: docs/site/public/logo.svg (nav logo, hero image, favicon).
//
// Legend / palette — each char maps to a color; space or '.' = transparent.
// Add a new color by putting a char in PALETTE; use it in PIXELS.
const PALETTE: Record<string, string> = {
  d: "#603c26", // dark brown (ear / outline)
  b: "#91603a", // brown shadow
  t: "#c89868", // tan
  l: "#e2c096", // light tan
  w: "#f0e2ce", // cream muzzle
  W: "#fffaf5", // white highlight
  k: "#221c18", // eye / nose
  g: "#ffffff", // eye glint
  p: "#e296a2", // pink inner ear
};

// The sprite. Every row must be the same length. Edit freely.
const PIXELS = [
  "  dd          dd  ",
  " dddd        dddd ",
  " dpdd        ddpd ",
  " ddpdb      bdpdd ",
  "  ddbtttttttttbdd ",
  "   btttttttttttb  ",
  "  bttlllllllllttb ",
  " bttllllllllllllb ",
  " btllkkllllkkllltb",
  " btllkgllllkglltb ",
  " bttllllllllllttb ",
  " bbttttwwwwttttbb ",
  "  bttwwwwwwwwttb  ",
  "  bttwwwkkwwwttb  ",
  "   bttwwkkwwttb   ",
  "   bbttwppwttbb   ",
  "    bttwwwwttb    ",
  "     bbtttbb      ",
];

const w = Math.max(...PIXELS.map((r) => r.length));
const h = PIXELS.length;
let rects = "";
for (let y = 0; y < h; y++) {
  const row = PIXELS[y];
  let x = 0;
  while (x < row.length) {
    const c = row[x];
    if (PALETTE[c]) {
      let x2 = x; // merge horizontal runs of one color into a single rect
      while (x2 + 1 < row.length && row[x2 + 1] === c) x2++;
      rects += `<rect x="${x}" y="${y}" width="${x2 - x + 1}" height="1" fill="${PALETTE[c]}"/>`;
      x = x2 + 1;
    } else x++;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
const out = new URL("../public/logo.svg", import.meta.url);
await Bun.write(out, svg);
console.log(`wrote logo.svg — ${w}×${h}, ${svg.length} bytes`);
