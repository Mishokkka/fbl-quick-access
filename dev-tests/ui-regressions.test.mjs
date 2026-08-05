import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Gear context menu uses a light palette and a red Delete icon", () => {
  const tokens = readFileSync(join(root, "styles", "00-tokens.css"), "utf8");
  const gearCss = readFileSync(join(root, "styles", "04-gear-cards.css"), "utf8");

  assert.match(tokens, /--fblqa-context-bg:\s*rgba\(255,\s*255,\s*255/);
  assert.match(tokens, /--fblqa-context-text:\s*#111111/);
  assert.match(gearCss, /fblqa-gear-menu-button-danger\s+\.fblqa-gear-menu-icon[\s\S]*?color:\s*#b00020/);
});

test("character-sheet render removes the Chargen header control", () => {
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");
  const controls = readFileSync(join(root, "scripts", "header-controls.js"), "utf8");

  assert.match(main, /removeChargenButton\(root\)/);
  assert.match(controls, /data-action='chargen'/);
  assert.match(controls, /CHARGEN_LABELS/);
});

test("Long Rest can open the separate new-day workflow", () => {
  const rest = readFileSync(join(root, "scripts", "rest.js"), "utf8");
  const newDay = readFileSync(join(root, "scripts", "new-day.js"), "utf8");

  assert.match(rest, /name="startsNewDay"/);
  assert.match(rest, /openNewDayDialog\(app, actor\)/);
  assert.match(newDay, /buildNewDayPlan/);
  assert.match(newDay, /applyNewDayPlan/);
  assert.match(newDay, /addiction-day/);
  assert.match(newDay, /wash-transition/);
});


test("Short Rest dynamically returns the Dialog to auto height after switching panes", () => {
  const rest = readFileSync(join(root, "scripts", "rest.js"), "utf8");

  assert.match(rest, /height:\s*"auto"/);
  assert.match(rest, /scheduleRestDialogAutoSize/);
  assert.match(rest, /setPosition\?\.\(\{ height: "auto" \}\)/);
  assert.match(rest, /if \(event\.target\?\.name === "restType"\) updatePanes\(\)/);
});

test("STAT edits suppress full sheet renders and persist stable row order", () => {
  const main = readFileSync(join(root, "scripts", "conditions", "main.js"), "utf8");
  const migrations = readFileSync(join(root, "scripts", "conditions", "migrations.js"), "utf8");

  assert.match(main, /item\.update\(update, \{ render: false \}\)/);
  assert.match(main, /renderConditionItemRow/);
  assert.match(main, /refreshItemRow/);
  assert.match(migrations, /ensureConditionItemOrders/);
  assert.match(migrations, /updateEmbeddedDocuments\("Item", itemUpdates, \{ render: false \}\)/);
});

test("Rest switch has no inherited label margins and new-day bulk controls live in the intro", () => {
  const css = readFileSync(join(root, "styles", "10-rest.css"), "utf8");
  const newDay = readFileSync(join(root, "scripts", "new-day.js"), "utf8");

  assert.match(css, /\.fblqa-rest-type-switch\s*\{[\s\S]*?margin:\s*0\s*!important/);
  assert.match(css, /\.fblqa-rest-type-switch > label\s*\{[\s\S]*?margin:\s*0\s*!important/);
  assert.match(newDay, /fblqa-new-day-intro[\s\S]*?fblqa-new-day-toolbar[\s\S]*?<\/div>\s*<\/div>\s*<div class="fblqa-new-day-groups"/);
});

test("Gear post-to-chat action is moved into the context menu and row controls collapse", () => {
  const context = readFileSync(join(root, "scripts", "gear-context-menu.js"), "utf8");
  const css = readFileSync(join(root, "styles", "04-gear-cards.css"), "utf8");

  assert.match(context, /GearMenu\.PostToChat/);
  assert.match(context, /postGearItemToChat/);
  assert.match(context, /fblqa-gear-row-controls-collapsed/);
  assert.match(css, /\.fblqa-gear-menu-row \.item-controls\.fblqa-gear-row-controls-collapsed[\s\S]*?width:\s*0\s*!important/);
});

test("Empty wallet messages collapse and both wallet modes expose money transfer", () => {
  const wallet = readFileSync(join(root, "scripts", "wallet.js"), "utf8");
  const css = readFileSync(join(root, "styles", "05-wallet.css"), "utf8");
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");

  assert.match(css, /\.fblqa-wallet-message:empty\s*\{[\s\S]*?display:\s*none\s*!important/);
  assert.match(wallet, /buildMoneyTransferButton\(app, actor, "compact"\)/);
  assert.match(wallet, /buildMoneyTransferButton\(app, actor, "expanded"\)/);
  assert.match(main, /registerMoneyTransferSocket\(\)/);
});

test("Reputation replaces the native header roll with a ledger dialog", () => {
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");
  const reputation = readFileSync(join(root, "scripts", "reputation.js"), "utf8");
  const css = readFileSync(join(root, "styles", "12-reputation.css"), "utf8");

  assert.match(main, /setupReputationManager\(app, actor, root\)/);
  assert.match(reputation, /const REPUTATION_PATH = "system\.bio\.reputation\.value"/);
  assert.match(reputation, /\.roll-reputation/);
  assert.match(reputation, /selectRandomReputation\(entries, 2\)/);
  assert.match(reputation, /selectRandomReputation\(entries, 3\)/);
  assert.match(reputation, /new Roll\(`\$\{diceCount\}d6cs=6`\)/);
  assert.match(reputation, /buttons:\s*\{\}/);
  assert.match(reputation, /scheduleReputationDialogAutoSize/);
  assert.match(reputation, /setupReputationNoteSummary/);
  assert.match(reputation, /ChatMessage\?\.create/);
  assert.doesNotMatch(reputation, /roll\.toMessage/);
  assert.match(css, /\.fblqa-reputation-row/);
  assert.match(css, /\.fblqa-reputation-chat-card/);
  assert.match(css, /\.fblqa-reputation-note-summary/);
  assert.doesNotMatch(css, /\.fblqa-reputation-value\s*\{[^}]*background:/);
});
