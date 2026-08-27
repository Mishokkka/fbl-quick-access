import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test("tooltip pointer hot path is RAF-coalesced and does not force layout", () => {
  const source = read("scripts", "tooltips.js");
  const position = functionBody(source, "positionItemTooltip");
  const measure = functionBody(source, "measureItemTooltip");

  assert.match(source, /document\.addEventListener\("mousemove"[\s\S]*?scheduleItemTooltipPosition\(\)/);
  assert.match(source, /function scheduleItemTooltipPosition\([\s\S]*?requestAnimationFrame/);
  assert.doesNotMatch(position, /getBoundingClientRect|getComputedStyle|offsetWidth|offsetHeight|clientWidth|clientHeight/);
  assert.match(measure, /getBoundingClientRect\(\)/);
});

test("gear render applies saved order once and uses constant-time rank lookup", () => {
  const gearOrder = read("scripts", "gear-order.js");
  const main = read("scripts", "main.js");
  const setup = functionBody(gearOrder, "setupGearOrdering");
  const apply = functionBody(gearOrder, "applySavedGearOrder");

  assert.doesNotMatch(setup, /applySavedGearOrder\(/);
  assert.match(main, /if \(gears\) applySavedGearOrder\(actor, gears\)/);
  assert.match(apply, /const rank = new Map\(order\.map/);
  assert.doesNotMatch(apply, /order\.indexOf\(/);
});

test("gear dragover uses a drag-session snapshot and one RAF marker update", () => {
  const source = read("scripts", "gear-order.js");
  assert.match(source, /function buildGearDragSession\(/);
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /activeMarker/);
  assert.match(source, /const group = findGroupContainingItem\(actor, gears, targetItemId\)/);
});

test("startup reference pruning reads flags before enumerating embedded Items and suppresses maintenance renders", () => {
  const source = read("scripts", "data-hygiene.js");
  const prune = functionBody(source, "pruneActorReferences");

  const flagRead = prune.indexOf("actor.getFlag");
  const itemScan = prune.indexOf("Array.from(actor.items");
  assert.ok(flagRead >= 0 && itemScan > flagRead, "flags must be checked before Item enumeration");
  assert.match(prune, /if \(!hasSlotReferences && !hasOrderReferences\)[\s\S]*?persistPrunedActorReferences/);
  assert.match(source, /actor\.update\(updateData, \{ render: false \}\)/);
});

test("New Day batches simple embedded Item writes and Calendaria suppresses only redundant marker renders", () => {
  const newDay = read("scripts", "new-day.js");
  const stateProgression = read("scripts", "state-progression.js");

  assert.match(newDay, /actor\.updateEmbeddedDocuments\("Item", \[\.\.\.updatesById\.values\(\)\], documentOptions\)/);
  assert.match(newDay, /actor\.deleteEmbeddedDocuments\("Item", valid\.map/);
  assert.match(newDay, /item update batch failed; retrying individually/);
  assert.match(newDay, /item delete batch failed; retrying individually/);
  assert.doesNotMatch(functionBody(stateProgression, "calendarApplyOptions"), /documentOptions|render:\s*false/);
  assert.match(stateProgression, /finalIteration \? \{\} : \{ render: false \}/);
});

test("BIO saves one dirty subtree when safe and does not recalculate language layout for unrelated controls", () => {
  const source = read("scripts", "biography.js");
  assert.match(source, /const SAVE_DIRTY_PATHS = new Map\(\)/);
  assert.match(source, /dirtyPaths\.size === 1 && !dirtyPaths\.has\("\*"\)/);
  assert.match(source, /if \(control\.closest\?\.\("\.fblqa-language-list"\)\) scheduleLanguageLayout\(scope\)/);
  assert.match(source, /persistedPath === "languages"/);
  assert.match(source, /persistedPath === "rumors"/);
});


test("lazy BIO activation also covers programmatic tab switches without retaining old sheets", () => {
  const source = read("scripts", "main.js");
  assert.match(source, /const BIO_ACTIVATION_GUARDS = new WeakMap\(\)/);
  assert.match(source, /new MutationObserver\(queueMountCheck\)/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /cleanupBiographyActivationGuard\(app\)/);
});

test("Reputation input work is scoped and autosize frames are coalesced", () => {
  const source = read("scripts", "reputation.js");
  assert.match(source, /const REPUTATION_RESIZE_FRAMES = new WeakMap\(\)/);
  assert.match(source, /if \(field === "amount" \|\| field === "selected"\) refreshDialogSummary\(root\)/);
  assert.match(source, /if \(structureChanged\) resize\?\.\(\)/);
});

test("STAT provider listener lifecycle supports cleanup on rerender and sheet close", () => {
  const providers = read("scripts", "integration", "stat-providers.js");
  const main = read("scripts", "main.js");
  const docs = read("INTEGRATION_API.md");

  assert.match(providers, /const providerListenerCleanups = new WeakMap\(\)/);
  assert.match(providers, /if \(owner\) cleanupStatProviderListeners\(owner\)/);
  assert.match(providers, /if \(typeof cleanup === "function"\) cleanups\.push\(cleanup\)/);
  assert.match(main, /cleanupStatProviderListeners\(app\)/);
  assert.match(docs, /may return a cleanup function/);
});

test("global wallet click returns immediately when no wallet UI is active", () => {
  const source = read("scripts", "wallet.js");
  const close = functionBody(source, "closeOpenWallets");
  assert.match(source, /const ACTIVE_WALLET_SUMMARIES = new Set\(\)/);
  assert.match(source, /export function cleanupWalletSummaries\(/);
  assert.match(close, /if \(!OPEN_WALLET_ACTORS\.size && !ACTIVE_WALLET_SUMMARIES\.size\) return/);
});

test("condition and Pilgrim pointer drags coalesce pointermove work through RAF", () => {
  const conditions = read("scripts", "conditions", "main.js");
  const biography = read("scripts", "biography.js");

  assert.match(conditions, /pointerDrag\.pendingX = moveEv\.clientX[\s\S]*?requestAnimationFrame\(applyPointerDragPosition\)/);
  assert.match(biography, /pendingPointer = \{ pointerId: event\.pointerId, clientX: event\.clientX, clientY: event\.clientY \}[\s\S]*?requestAnimationFrame\(applyPointerPosition\)/);
});

test("expanded condition controls avoid transition-all", () => {
  const css = read("styles", "11-expanded-conditions.css");
  assert.doesNotMatch(css, /transition\s*:\s*all\b/i);
});
