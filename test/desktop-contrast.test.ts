import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../apps/desktop/src/styles.css", import.meta.url), "utf8");

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

for (const [theme, selector] of [
  ["light", /^:root \{([\s\S]*?)^\}/m],
  ["dark", /^html\[data-theme="dark"\] \{([\s\S]*?)^\}/m],
] as const) {
  test(`desktop ${theme} text and focus tokens remain readable on neutral surfaces`, () => {
    const block = css.match(selector)?.[1];
    assert.ok(block, `Missing ${theme} tokens`);
    const tokens = Object.fromEntries(Array.from(
      block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6});/gi), (match) => [match[1], match[2]],
    ));
    for (const foreground of ["text", "dim", "faint", "focus"]) {
      assert.ok(tokens[foreground], `Missing ${foreground}`);
      for (const background of ["bg", "surface", "surface2"]) {
        assert.ok(tokens[background], `Missing ${background}`);
        const minimum = foreground === "focus" ? 3 : 4.5;
        const ratio = contrast(tokens[foreground], tokens[background]);
        assert.ok(ratio >= minimum, `${foreground} on ${background}: ${ratio.toFixed(2)}:1, expected ${minimum}:1`);
      }
    }
  });
}
