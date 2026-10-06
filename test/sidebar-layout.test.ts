import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampRailWidth,
  DEFAULT_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  sessionAge,
} from "../apps/desktop/src/lib/sidebar-layout.ts";

test("sidebar width preserves valid values and bounds saved or dragged widths", () => {
  assert.equal(clampRailWidth(280), 280);
  assert.equal(clampRailWidth(0), MIN_RAIL_WIDTH);
  assert.equal(clampRailWidth(-20), MIN_RAIL_WIDTH);
  assert.equal(clampRailWidth(1000), MAX_RAIL_WIDTH);
  assert.equal(clampRailWidth(360, 280), 280);
  assert.equal(clampRailWidth(210, 280), MIN_RAIL_WIDTH);
  for (const width of [NaN, Infinity, -Infinity]) {
    assert.equal(clampRailWidth(width), DEFAULT_RAIL_WIDTH);
  }
});

test("session timestamps stay compact across minute, hour, and day boundaries", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(sessionAge("2026-10-06T11:59:30Z", now), "now");
  assert.equal(sessionAge("2026-10-06T11:59:00Z", now), "1m");
  assert.equal(sessionAge("2026-10-06T11:00:01Z", now), "59m");
  assert.equal(sessionAge("2026-10-06T11:00:00Z", now), "1h");
  assert.equal(sessionAge("2026-10-05T12:00:01Z", now), "23h");
  assert.equal(sessionAge("2026-10-05T12:00:00Z", now), "1d");
  assert.equal(sessionAge("2026-10-03 12:00:00Z", now), "3d");
});

test("session timestamps tolerate missing, invalid, and future dates", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(sessionAge(undefined, now), "");
  assert.equal(sessionAge("", now), "");
  assert.equal(sessionAge("not-a-date", now), "");
  assert.equal(sessionAge("2026-10-07T12:00:00Z", now), "now");
});
