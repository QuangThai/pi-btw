/**
 * Builds assets/gallery.html for the package gallery image.
 *
 * The /btw frame is assembled with the same arithmetic the extension uses in
 * extensions/btw.ts (topBorder / L / S / bottomBorder), so the rectangle is
 * exact and the glyph vocabulary matches what users actually see.
 *
 * Box-drawing glyphs only join up when every cell is on an integer grid, so
 * the frame uses an integer font-size and line-height: 1.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 94;                 // frame width in characters
const CW = W - 4;             // inner content width, as contentWidth() does

const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].length));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Every row is emitted as three spans so the frame's verticals stay one
// unbroken amber column. Colouring a whole row at once tints its `║` with the
// content colour, which reads as a broken border.
const rowHtml = (cls, content) =>
  `<span class="fr"><i class="b">║ </i>` +
  `<i class="${cls}">${esc(pad(content, CW))}</i>` +
  `<i class="b"> ║</i></span>`;

const sepHtml = () =>
  `<span class="fr"><i class="b">║ </i>` +
  `<i class="sep">${"─".repeat(CW)}</i>` +
  `<i class="b"> ║</i></span>`;

const topHtml = (label) => {
  const fill = Math.max(0, W - 3 - [...label].length);
  return `<span class="fr"><i class="b">${esc(`╔═${label}${"═".repeat(fill)}╗`)}</i></span>`;
};

const bottomHtml = (hints) => {
  const fill = Math.max(0, W - 2 - [...hints].length);
  return `<span class="fr"><i class="b">${esc(`╚${"═".repeat(fill)}${hints}╝`)}</i></span>`;
};

// Exact hint string from extensions/btw.ts.
const HINTS = " ↑↓ scroll  Esc dismiss  /btw inject  /btw history ";

const frameRows = [
  topHtml(" /btw [2] "),
  rowHtml("q", " ? does clearSlot stop the child process?"),
  sepHtml(),
  rowHtml("a", " Yes. It bumps the slot generation, detaches the child, then awaits"),
  rowHtml("a", " stop() - SIGTERM, then SIGKILL after a 2s grace. A turn already in"),
  rowHtml("a", " flight sees the change and abandons itself."),
  sepHtml(),
  rowHtml("m", " gpt-5.5 · 1.2k in · 412 out · $0.006"),
  bottomHtml(HINTS),
];

// Guard the rectangle: strip tags and check every row is exactly W cells.
for (const row of frameRows) {
  const text = row
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  if ([...text].length !== W) {
    throw new Error(`frame row is ${[...text].length} wide, expected ${W}: ${text}`);
  }
}

const frameHtml = frameRows.join("\n");

// The main agent keeps working while the side question runs. Dimmed on
// purpose: the hierarchy states the claim before any words do.
const transcript = [
  ["prompt", "› wire the slot queue into the extension"],
  ["tool", "  read  src/session-state.ts"],
  ["tool", "  edit  src/session-state.ts        +48 −12"],
  ["tool", "  edit  extensions/btw.ts           +31 −9"],
  ["tool", "  bash  npm test                    49 passed"],
  ["run", "  ● still working…"],
]
  .map(([k, s]) =>
    k === "run"
      ? `<span class="tr tr-run">  <b>●</b> still working…</span>`
      : `<span class="tr tr-${k}">${esc(s)}</span>`)
  .join("\n");

const html = `<!doctype html>
<meta charset="utf-8">
<title>pi-btw</title>
<style>
  :root {
    --ink:        #0E1016;
    --main-dim:   #626D80;
    --main-dimmer:#424B5A;
    --amber:      #E8A33D;
    --amber-soft: #7E5C26;
    --paper:      #E7EAF0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: var(--ink);
    font-family: "Segoe UI", system-ui, sans-serif;
    color: var(--paper);
    /* Explicit rows and no absolute positioning: every band owns its height,
       so nothing can grow into a neighbour or past an edge. */
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    padding: 40px 56px 34px;
    row-gap: 20px;
  }

  /* One atmospheric layer, fixed and non-interactive, behind the text.
     A scanline overlay was cut: invisible at this size and it triples the
     PNG's weight by adding per-pixel noise. */
  body::after {
    content: "";
    position: fixed;
    left: 10px;
    bottom: -180px;
    width: 900px;
    height: 440px;
    background: radial-gradient(ellipse at center, rgba(232,163,61,0.11), transparent 70%);
    pointer-events: none;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 48px;
  }
  .mark {
    font-family: "Cascadia Mono", Consolas, monospace;
    font-size: 58px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    white-space: nowrap;
  }
  .mark .slash { color: var(--amber); }
  .tagline { text-align: right; line-height: 1.3; }
  .tagline b {
    display: block;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .tagline span {
    display: block;
    font-size: 16.5px;
    color: var(--main-dim);
    margin-top: 6px;
  }

  .transcript {
    font-family: "Cascadia Mono", Consolas, monospace;
    font-size: 16px;
    line-height: 26px;
    display: flex;
    flex-direction: column;
  }
  .tr { white-space: pre; }
  .tr-prompt { color: var(--main-dim); }
  .tr-tool   { color: var(--main-dimmer); }
  .tr-run    { color: var(--main-dim); }
  .tr-run b  { color: var(--amber); font-weight: 400; }

  /* The signature: real box-drawing glyphs on the terminal ground, no card.
     Integer size and line-height 1 keep the cells on a whole-pixel grid so
     the borders actually join. */
  .frame {
    align-self: end;
    justify-self: start;
    display: flex;
    flex-direction: column;
    font-family: "Cascadia Mono", Consolas, monospace;
    font-variant-ligatures: none;
    font-size: 18px;
    /* Cascadia's natural cell at 18px is 20.8px. Sitting below it makes the
       box strokes overlap slightly, so the borders join with no hairline
       seams, and keeps every row on a whole pixel. */
    line-height: 19px;
    letter-spacing: 0;
  }
  .fr { white-space: pre; }
  .fr i { font-style: normal; }
  /* The border column is always amber, whatever the row holds. */
  .fr .b   { color: var(--amber); }
  .fr .sep { color: var(--amber-soft); }
  .fr .q   { color: var(--amber); }
  .fr .a   { color: var(--paper); }
  .fr .m   { color: var(--main-dim); }

  footer {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 32px;
    font-size: 16px;
    color: var(--main-dim);
    border-top: 1px solid rgba(255,255,255,0.075);
    padding-top: 16px;
  }
  footer em { font-style: normal; color: var(--paper); }
  footer .where {
    font-family: "Cascadia Mono", Consolas, monospace;
    font-size: 14.5px;
    color: var(--main-dimmer);
    white-space: nowrap;
  }
</style>

<header>
  <div class="mark"><span class="slash">/</span>btw</div>
  <div class="tagline">
    <b>Ask sideways.</b>
    <span>A second agent reads your repo. The main one never stops.</span>
  </div>
</header>

<div class="transcript">
${transcript}
</div>

<div class="frame">
${frameHtml}
</div>

<footer>
  <div><em>read-only tools</em> · 9 parallel slots · nothing added to the main context</div>
  <div class="where">pi install npm:@nguyenquangthai/pi-btw</div>
</footer>
`;

const out = join(process.cwd(), "assets", "gallery.html");
writeFileSync(out, html, "utf8");
console.log("wrote", out);
