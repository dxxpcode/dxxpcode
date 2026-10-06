import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_OPTIONS, SETTINGS_TABS, settingsApprovalValue, settingsMenuPlacement } from "../apps/desktop/src/lib/settings-layout.ts";

test("settings retains the existing five categories with readable headings", () => {
  assert.deepEqual(SETTINGS_TABS.map((tab) => tab.id), ["general", "providers", "appearance", "session", "about"]);
  assert.equal(new Set(SETTINGS_TABS.map((tab) => tab.id)).size, SETTINGS_TABS.length);
  assert.ok(SETTINGS_TABS.every((tab) => tab.label && tab.desc));
});

test("approval labels preserve the existing backend command values", () => {
  assert.deepEqual(APPROVAL_OPTIONS.map((option) => option.value), ["ask", "always-approve", "smart (Jev)"]);
  assert.equal(settingsApprovalValue("smart"), "smart (Jev)");
  for (const option of APPROVAL_OPTIONS) {
    assert.equal(settingsApprovalValue(option.value), option.value);
    assert.ok(option.label && option.desc);
  }
});

test("settings menus align to the trigger and open below when space permits", () => {
  assert.deepEqual(settingsMenuPlacement(
    { left: 400, right: 624, top: 100, bottom: 136 },
    { width: 1000, height: 700 },
  ), { left: 400, top: 140, bottom: undefined, width: 224, maxHeight: 240 });
});

test("settings menus open above lower rows rather than overflowing the window", () => {
  assert.deepEqual(settingsMenuPlacement(
    { left: 400, right: 624, top: 600, bottom: 636 },
    { width: 1000, height: 700 },
  ), { left: 400, top: undefined, bottom: 104, width: 224, maxHeight: 240 });
});

test("settings menus fit narrow windows and wide stacked controls", () => {
  const viewport = { width: 320, height: 600 };
  const wide = settingsMenuPlacement({ left: 12, right: 308, top: 100, bottom: 136 }, viewport);
  assert.equal(wide.width, 296);
  const edge = settingsMenuPlacement({ left: 10, right: 190, top: 100, bottom: 136 }, { width: 220, height: 600 });
  assert.equal(edge.left, 12);
  assert.equal(edge.width, 196);
  assert.equal(edge.left + edge.width, 208);
});

test("settings menus limit scrolling height in short windows", () => {
  const menu = settingsMenuPlacement(
    { left: 200, right: 424, top: 130, bottom: 166 },
    { width: 640, height: 300 },
  );
  assert.equal(menu.top, 170);
  assert.equal(menu.maxHeight, 118);
  assert.equal(menu.top! + menu.maxHeight, 288);
});
