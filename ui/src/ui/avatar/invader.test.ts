import { describe, expect, it } from "vitest";
import { generateInvader, invaderBoxShadow, invaderColor, invaderDataUri } from "./invader.ts";

describe("generateInvader", () => {
  it("is deterministic for a given seed", () => {
    expect(generateInvader("varys")).toEqual(generateInvader("varys"));
    expect(invaderColor("varys")).toBe(invaderColor("varys"));
  });

  it("widens color variety via per-seed shades", () => {
    const colors = new Set(Array.from({ length: 60 }, (_, i) => invaderColor(`agent-${i}`)));
    for (const c of colors) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Hue × shade grid should yield far more than the 12 base hues.
    expect(colors.size).toBeGreaterThan(20);
  });

  it("produces distinct shapes for distinct seeds", () => {
    const a = JSON.stringify(generateInvader("varys").cells);
    const b = JSON.stringify(generateInvader("gendry").cells);
    expect(a).not.toBe(b);
  });

  it("is left/right mirror-symmetric", () => {
    const { cells } = generateInvader("samwell");
    for (const row of cells) {
      for (let x = 0; x < row.length; x++) {
        expect(row[x]).toBe(row[row.length - 1 - x]);
      }
    }
  });

  it("always has legs (never empty)", () => {
    expect(generateInvader("podrick").legXs.length).toBeGreaterThan(0);
  });

  it("varies white feature squares (none to several) on the body", () => {
    const counts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const sprite = generateInvader(`feat-${i}`);
      counts.add(sprite.whiteCells.length);
      for (const [x, y] of sprite.whiteCells) {
        expect(sprite.cells[y][x]).toBe(true); // feature sits on the body silhouette
      }
    }
    expect(counts.has(0)).toBe(true); // some agents have no features
    expect(Math.max(...counts)).toBeGreaterThan(1); // some have several
  });
});

describe("renderers", () => {
  it("box-shadow alternates legs between frames", () => {
    const sprite = generateInvader("stannis");
    const f0 = invaderBoxShadow(sprite, "#fff", 0, 6);
    const f1 = invaderBoxShadow(sprite, "#fff", 1, 6);
    expect(f0).not.toBe(f1);
    expect(f0).toContain("#fff");
  });

  it("emits an svg data-uri", () => {
    const uri = invaderDataUri(generateInvader("main"), "#5a8a6e", { animate: true });
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = atob(uri.slice("data:image/svg+xml;base64,".length));
    expect(svg).toContain("<svg");
    expect(svg).toContain("<animate");
  });
});
