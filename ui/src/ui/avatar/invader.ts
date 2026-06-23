/**
 * Procedural pixel-invader avatar generator.
 *
 * Deterministic from a seed string (an agent id by default), so every agent
 * gets a stable, distinct sprite without storing anything. The same model
 * renders two ways:
 *   - box-shadow string for the animated office sprites (cheap, no <img>)
 *   - an SVG data-URI for a persisted/assigned avatar that travels to the
 *     agents list, chat, and badges via identity.avatar -> avatarUrl.
 *
 * Color is supplied by the caller (the agent's palette/CREW neon) so the
 * sprite always matches its initials badge; novelty lives in the SHAPE.
 */

// 7-wide / 8-tall classic-invader grid, sized to the office sprite cell. We
// generate the left half + center column and mirror it, so sprites are
// left/right symmetric like the arcade art.
const WIDTH = 7;
const HEIGHT = 8;
const HALF = 4; // columns 0..3 (col 3 is the mirror center)
const CENTER_X = 3; // mirror center column

export type InvaderSprite = {
  /** cells[y][x] === true means a filled (body-colored) pixel. */
  cells: boolean[][];
  /** Feature pixels (eyes/nose/mouth/hands) painted white on top of the body. */
  whiteCells: Array<[number, number]>;
  /** Filled x positions on the bottom row; toggled per frame for the step/flap. */
  legXs: number[];
};

/** xmur3: string -> well-mixed uint32 seed. */
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: seed -> deterministic [0,1) generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a deterministic, mirror-symmetric invader from a seed string. */
export function generateInvader(seed: string): InvaderSprite {
  const rand = rng(seedFrom(seed));
  const cells: boolean[][] = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => false),
  );
  // Random mirror-symmetric body.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < HALF; x++) {
      const filled = rand() < 0.5;
      cells[y][x] = filled;
      cells[y][WIDTH - 1 - x] = filled; // mirror across the center column
    }
  }
  // Guarantee a connected core so no avatar reads as blank: a central torso.
  for (let y = 1; y <= 6; y++) {
    cells[y][CENTER_X] = true;
  }

  // White feature squares for variety. Each is present independently per seed,
  // so an agent may have all, some, or none. Features sit on the body so the
  // silhouette stays connected, and render white on top.
  const feat = seedFrom(`${seed}:feat`);
  const whiteCells: Array<[number, number]> = [];
  const addWhite = (x: number, y: number): void => {
    cells[y][x] = true;
    whiteCells.push([x, y]);
  };
  if (feat & 1) {
    // eyes
    addWhite(2, 2);
    addWhite(WIDTH - 1 - 2, 2);
  }
  if (feat & 2) {
    // nose
    addWhite(CENTER_X, 3);
  }
  if (feat & 4) {
    // mouth
    addWhite(2, 5);
    addWhite(CENTER_X, 5);
    addWhite(WIDTH - 1 - 2, 5);
  }
  if (feat & 8) {
    // hands / feet
    addWhite(0, 4);
    addWhite(WIDTH - 1, 4);
  }

  const legXs: number[] = [];
  for (let x = 0; x < WIDTH; x++) {
    if (cells[HEIGHT - 1][x]) {
      legXs.push(x);
    }
  }
  // Never legless: fall back to a symmetric stance.
  if (legXs.length === 0) {
    cells[HEIGHT - 1][2] = true;
    cells[HEIGHT - 1][WIDTH - 1 - 2] = true;
    legXs.push(2, WIDTH - 1 - 2);
  }
  return { cells, whiteCells, legXs };
}

/**
 * CSS box-shadow string for the office sprite. The host element is a single
 * PX×PX block at the origin; every filled cell is one more shadow offset by
 * x*px / y*px. `frame` (0|1) alternates leg height for a stepping animation.
 */
export function invaderBoxShadow(
  sprite: InvaderSprite,
  color: string,
  frame: number,
  px: number,
): string {
  const shadows: string[] = [];
  // White feature squares first: in CSS box-shadow the earliest entry paints on top.
  for (const [x, y] of sprite.whiteCells) {
    shadows.push(`${x * px}px ${y * px}px 0 #ffffff`);
  }
  for (let y = 0; y < HEIGHT - 1; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (sprite.cells[y][x]) {
        shadows.push(`${x * px}px ${y * px}px 0 ${color}`);
      }
    }
  }
  // Legs: alternate which legs drop a pixel between frames so the sprite "walks".
  const sorted = sprite.legXs.toSorted((a, b) => a - b);
  sorted.forEach((x, i) => {
    const dropped = frame === 0 ? i % 2 === 0 : i % 2 === 1;
    const y = HEIGHT - 1 + (dropped ? 1 : 0);
    shadows.push(`${x * px}px ${y * px}px 0 ${color}`);
  });
  return shadows.join(",");
}

const SVG_UNIT = 10; // pixel size in the SVG's own coordinate space

/** Standalone SVG markup for a sprite. `animate` adds a SMIL leg flap. */
export function invaderSvg(
  sprite: InvaderSprite,
  color: string,
  opts: { animate?: boolean } = {},
): string {
  const w = WIDTH * SVG_UNIT;
  const h = (HEIGHT + 1) * SVG_UNIT; // +1 row of headroom for the dropped legs
  const rects: string[] = [];
  for (let y = 0; y < HEIGHT - 1; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (sprite.cells[y][x]) {
        rects.push(rect(x * SVG_UNIT, y * SVG_UNIT, color));
      }
    }
  }
  const sorted = sprite.legXs.toSorted((a, b) => a - b);
  sorted.forEach((x, i) => {
    const baseY = (HEIGHT - 1) * SVG_UNIT;
    if (!opts.animate) {
      rects.push(rect(x * SVG_UNIT, baseY, color));
      return;
    }
    // Two-keyframe vertical flap; phase split by leg index so legs alternate.
    const lo = baseY;
    const hi = baseY + SVG_UNIT;
    const values = i % 2 === 0 ? `${hi};${lo};${hi}` : `${lo};${hi};${lo}`;
    rects.push(
      `<rect x="${x * SVG_UNIT}" y="${lo}" width="${SVG_UNIT}" height="${SVG_UNIT}" fill="${color}">` +
        `<animate attributeName="y" values="${values}" dur="0.6s" repeatCount="indefinite"/></rect>`,
    );
  });
  // White feature squares last: in SVG painter order the final rects sit on top.
  for (const [x, y] of sprite.whiteCells) {
    rects.push(rect(x * SVG_UNIT, y * SVG_UNIT, "#ffffff"));
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">` +
    rects.join("") +
    `</svg>`
  );
}

function rect(x: number, y: number, color: string): string {
  return `<rect x="${x}" y="${y}" width="${SVG_UNIT}" height="${SVG_UNIT}" fill="${color}"/>`;
}

/** Base64 SVG data-URI suitable for identity.avatar (resolves to avatarUrl unchanged). */
export function invaderDataUri(
  sprite: InvaderSprite,
  color: string,
  opts: { animate?: boolean } = {},
): string {
  const svg = invaderSvg(sprite, color, opts);
  // SVG is pure ASCII (hex colors + numbers), so btoa is safe.
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Neon palette for generated (non-CREW) agents and modal previews. Kept here so
// the sprite color and the generator share one source of truth.
export const INVADER_PALETTE = [
  "#5a8a6e",
  "#8b6aae",
  "#4a8aaa",
  "#5e9460",
  "#a8834a",
  "#aa5a52",
  "#5a9aaa",
  "#7a6acc",
  "#cc7a4a",
  "#4accaa",
  "#cc4a8a",
  "#8acc4a",
];

// Per-seed lightness shades layered on the base hues widen the range: a
// hue × shade grid yields ~12 × SHADE_STEPS distinct, still-legible colors.
const SHADE_STEPS = 11;

/** Blend a hex color toward white (amount > 0) or black (amount < 0); amount in [-1, 1]. */
function shadeHex(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const channel = (i: number): string => {
    const c = Number.parseInt(value.slice(i, i + 2), 16);
    const mixed = Math.round(c + (target - c) * t);
    return mixed.toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/** Deterministic neon color for a seed: base hue + a per-seed brighter/darker shade. */
export function invaderColor(seed: string): string {
  const base = INVADER_PALETTE[seedFrom(seed) % INVADER_PALETTE.length];
  // Independent shade seed so hue and shade vary independently per agent.
  const shadeIndex = seedFrom(`${seed}:shade`) % SHADE_STEPS;
  // Map step -> [-0.4, +0.45]: darker through brighter, keeping colors visible.
  const amount = -0.4 + (shadeIndex / (SHADE_STEPS - 1)) * 0.85;
  return shadeHex(base, amount);
}
