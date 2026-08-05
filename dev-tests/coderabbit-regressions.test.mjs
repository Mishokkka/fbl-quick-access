import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("currency actor updates accept only known finite safe values", async () => {
  const { buildActorCurrencyUpdate } = await import("../scripts/actor-data.js");
  const actor = {
    system: {
      currency: {
        gold: { value: 2 },
        silver: { value: 3 },
        copper: { value: 4 }
      }
    }
  };

  assert.deepEqual(buildActorCurrencyUpdate(actor, { gold: 3.9, silver: "8", copper: -2 }), {
    "system.currency.gold.value": 3,
    "system.currency.silver.value": 8,
    "system.currency.copper.value": 0
  });
  assert.throws(() => buildActorCurrencyUpdate(actor, { platinum: 1 }), /Unknown currency key/);
  assert.throws(() => buildActorCurrencyUpdate(actor, { gold: Number.NaN }), /finite safe integer/);
  assert.throws(() => buildActorCurrencyUpdate(actor, { gold: "" }), /must be numeric/);
  assert.throws(() => buildActorCurrencyUpdate(actor, { gold: null }), /must be numeric/);
  assert.throws(() => buildActorCurrencyUpdate(actor, { gold: Number.MAX_SAFE_INTEGER + 1 }), /finite safe integer/);
});

test("currency expressions reject values outside Number safe-integer range", async () => {
  globalThis.game ??= { i18n: { localize: (key) => key }, modules: new Map() };
  const { parseCurrencyExpression } = await import("../scripts/currency.js");

  assert.deepEqual(parseCurrencyExpression(String(Number.MAX_SAFE_INTEGER)), {
    ok: true,
    value: Number.MAX_SAFE_INTEGER,
    relative: false
  });
  assert.equal(parseCurrencyExpression("9007199254740992").ok, false);
  assert.equal(parseCurrencyExpression("9007199254740991+1").ok, false);
});

test("condition refresh owns only the row container and preserves provider sections", () => {
  const template = read("templates", "conditions", "stat-tab.hbs");
  const main = read("scripts", "conditions", "main.js");
  const css = read("styles", "11-expanded-conditions.css");

  assert.match(template, /conditions-list[\s\S]*conditions-rows[\s\S]*rowsHtml[\s\S]*providerSectionsHtml/);
  assert.match(main, /html\.find\("\.conditions-rows"\)\.html\(rowsHtml\)/);
  assert.doesNotMatch(main, /html\.find\("\.conditions-list"\)\.html\(rowsHtml\)/);
  assert.match(css, /\.conditions-rows\s*\{[\s\S]*column-count:/);
});

test("condition controls inside actor forms are non-submit buttons", () => {
  const renderer = read("scripts", "conditions", "render", "stat-tab-renderer.js");
  assert.doesNotMatch(renderer, /<button(?!\s+type="button")/);

  for (const template of [
    "addiction.hbs",
    "custom-arc.hbs",
    "custom-condition.hbs",
    "heat.hbs",
    "injury.hbs",
    "mor.hbs"
  ]) {
    assert.doesNotMatch(
      read("templates", "conditions", "rows", template),
      /<button(?!\s+type="button")/,
      `${template} must not submit the actor sheet form`
    );
  }
});

test("hidden-input controls and Willpower anchor retain visible keyboard focus", () => {
  const walletCss = read("styles", "05-wallet.css");
  const borderCss = read("styles", "06-sheet-borders.css");
  const willpowerCss = read("styles", "08-willpower.css");

  assert.match(walletCss, /fblqa-round-checkbox:has\(input:focus-visible\)[\s\S]*outline:/);
  assert.match(borderCss, /fblqa-border-toggle input:focus-visible \+ \.fblqa-border-toggle-slider[\s\S]*outline:/);
  assert.match(willpowerCss, /fblqa-wp-label-anchor:focus-visible[\s\S]*outline:/);
  assert.doesNotMatch(willpowerCss, /fblqa-wp-label-anchor:focus-visible\s*\{[^}]*outline:\s*none/);
  assert.doesNotMatch(borderCss, /:\s*revert-layer/);
});

test("Chargen text heuristics stay in the window header while exact selectors scan the app", () => {
  const source = read("scripts", "header-controls.js");

  assert.match(source, /appRoot\.querySelectorAll\?\.\(selector\)/);
  assert.match(source, /if \(header instanceof HTMLElement\)[\s\S]*header\.querySelectorAll\?\.\("a, button, \[role='button'\]"\)/);
  assert.doesNotMatch(source, /const header = appRoot\.querySelector\?\.\("\.window-header"\) \?\? appRoot/);
});

test("wallet handlers capture currentTarget before queued asynchronous work", () => {
  const source = read("scripts", "wallet.js");

  assert.match(source, /const (?:target|control) = event\.currentTarget;[\s\S]*runWalletOperation\(actor, (?:target|control)/);
  assert.doesNotMatch(source, /\(\) => (?:changeCurrency|applyCurrencyInput)\([^\n]*event\.currentTarget/);
});

test("world migration is single-GM and does not stamp partial failures", () => {
  const source = read("scripts", "conditions", "migrations.js");
  const failureGuard = source.indexOf("if (failures > 0)");
  const versionWrite = source.indexOf("SETTINGS.MIGRATION_VERSION, MIGRATION_VERSION");

  assert.match(source, /const activeGM = getActiveGM\(\)/);
  assert.match(source, /activeGM\?\.id !== game\.user\.id/);
  assert.ok(failureGuard >= 0 && versionWrite > failureGuard, "migration version must be written only after the failure guard");
});

test("integration socket cleans a pending request when emit throws synchronously", async () => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const player = { id: "player", isGM: false, active: true };
  const gm = { id: "gm", isGM: true, active: true };

  globalThis.foundry = { utils: { deepClone: (value) => structuredClone(value) } };
  globalThis.game = {
    user: player,
    users: [player, gm],
    socket: {
      on() {},
      emit() { throw new Error("socket offline"); }
    }
  };

  try {
    const { executeAsActiveGM } = await import(`../scripts/integration/socket-api.js?emit-test=${Date.now()}`);
    await assert.rejects(
      executeAsActiveGM("test.operation", { value: 1 }, { timeoutMs: 1000 }),
      (error) => error?.code === "socket-emit-failed"
    );
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
    if (previousFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = previousFoundry;
  }
});

test("new-day custom-condition application recalculates the live timer", () => {
  const source = read("scripts", "new-day.js");
  const applySection = source.slice(source.indexOf("export async function applyNewDayPlan"));

  assert.match(applySection, /const timer = decrementFirstInteger\(condition\.time, 1\)/);
  assert.doesNotMatch(applySection, /time:\s*action\.afterText/);
});

test("rest deletes ActiveEffects in one embedded-document batch", () => {
  const source = read("scripts", "rest.js");

  assert.match(source, /deleteEmbeddedDocuments\("ActiveEffect", effectIds\)/);
  assert.doesNotMatch(source, /for \(const effect of result\.effectsToDelete\) await effect\.delete/);
  assert.match(source, /statusEffect\?\.img \?\? statusEffect\?\.icon/);
});
