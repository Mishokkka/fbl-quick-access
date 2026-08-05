import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleJson = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));

test("CSS keeps the optimized important budget", () => {
  let total = 0;
  const perFile = new Map();

  for (const path of moduleJson.styles) {
    const source = readFileSync(join(root, path), "utf8");
    const count = (source.match(/!important/g) ?? []).length;
    total += count;
    perFile.set(path, count);
  }

  assert.ok(total <= 420, `expected <=420 !important markers after integrating Expanded Conditions, got ${total}`);
  assert.ok((perFile.get("styles/04-gear-cards.css") ?? 0) <= 70, "gear cards should not become another override pile");
  assert.ok((perFile.get("styles/05-wallet.css") ?? 0) <= 20, "wallet CSS should stay mostly normal cascade");
  assert.ok((perFile.get("styles/11-expanded-conditions.css") ?? 0) <= 170, "integrated Expanded Conditions CSS should remain scoped to its feature file");
});

test("CSS files have clear feature ownership", () => {
  for (const path of moduleJson.styles) {
    const source = readFileSync(join(root, path), "utf8");
    assert.ok(source.trim().length > 0, `${path} should not be empty`);
  }

  assert.equal(moduleJson.styles.some((path) => /adjustments|final/i.test(path)), false);
});


test("Gear context menu replaces visible card edit/delete controls", () => {
  const gearCards = readFileSync(join(root, "scripts/gear-cards.js"), "utf8");
  const gearMenu = readFileSync(join(root, "scripts/gear-context-menu.js"), "utf8");
  const css = readFileSync(join(root, "styles/04-gear-cards.css"), "utf8");

  assert.equal(gearCards.includes("fblqa-gear-card-edit"), false, "cards should not build visible edit buttons");
  assert.equal(gearCards.includes("fblqa-gear-card-delete"), false, "cards should not build visible delete buttons");
  assert.match(gearMenu, /giveItem/, "context menu should prefer Item Piles giveItem(item)");
  assert.match(css, /fblqa-gear-context-menu/, "context menu CSS should be present");
  assert.match(css, /item-delete/, "native delete controls should be hidden by context-menu CSS");
});

test("compact Gear keeps a scrollable middle track and pinned consumables", () => {
  const core = readFileSync(join(root, "styles/01-core.css"), "utf8");
  const borders = readFileSync(join(root, "styles/06-sheet-borders.css"), "utf8");

  assert.match(
    core,
    /\.gear-tab\.fblqa-compacted[^{}]*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*!important/,
    "compact Gear must preserve the flexible system middle track"
  );
  assert.doesNotMatch(core, /grid-template-rows:\s*repeat\(3,\s*max-content\)/, "content-sized rows push consumables below short windows");
  assert.match(core, />\s*\.gears\s*>\s*\.item-list[^{}]*\{[^}]*flex:\s*1\s+1\s+auto\s*!important/, "Gear item-list should fill and shrink inside the middle track");
  assert.match(core, />\s*\.gears\s*>\s*\.item-list[^{}]*\{[^}]*padding-bottom:\s*0\s*!important/, "Gear item-list should not leave a residual bottom strip");
  assert.match(core, />\s*\.item-list\s*>\s*\.items[^{}]*\{[^}]*overflow-y:\s*auto\s*!important/, "Gear items should scroll when the sheet is short");
  assert.match(core, />\s*\.consumables[^{}]*\{[^}]*align-self:\s*end\s*!important/, "consumables should remain anchored to the final grid track");
  assert.match(borders, /fblqa-compacted\s*>\s*\.consumables\.border[^{}]*\{[^}]*padding-bottom:\s*0\s*!important/, "borderless compact consumables should sit flush with the bottom edge");
});
