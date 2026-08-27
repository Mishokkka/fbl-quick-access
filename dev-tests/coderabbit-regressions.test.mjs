import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

function findButtonsMissingTypeButton(source) {
  return [...source.matchAll(/<button\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/\btype\s*=\s*(?:"button"|'button')/i.test(tag));
}

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

test("condition refresh owns only the row container and preserves provider sections", async () => {
  const template = read("templates", "conditions", "stat-tab.hbs");
  const css = read("styles", "11-expanded-conditions.css");
  const { refreshConditionsRows } = await import("../scripts/conditions/render/refresh-rows.js");

  const rows = {
    value: "<div>old row</div>",
    html(value) { this.value = value; }
  };
  const providers = {
    value: "<section>provider</section>",
    html(value) { this.value = value; }
  };
  const events = [];
  const html = {
    find(selector) {
      if (selector === ".conditions-rows") return rows;
      if (selector === ".fblqa-stat-provider-sections") return providers;
      throw new Error(`Unexpected selector: ${selector}`);
    }
  };

  await refreshConditionsRows({
    html,
    buildRows: async () => {
      events.push("build");
      return "<div>new row</div>";
    },
    captureScroll: () => events.push("capture"),
    restoreScroll: () => events.push("restore")
  });

  assert.equal(rows.value, "<div>new row</div>");
  assert.equal(providers.value, "<section>provider</section>");
  assert.deepEqual(events, ["capture", "build", "restore"]);
  assert.match(template, /conditions-list[\s\S]*conditions-rows[\s\S]*rowsHtml[\s\S]*providerSectionsHtml/);
  assert.match(css, /\.conditions-rows\s*\{[^}]*column-count:/);
});

test("condition controls inside actor forms are non-submit buttons", () => {
  const renderer = read("scripts", "conditions", "render", "stat-tab-renderer.js");
  assert.deepEqual(findButtonsMissingTypeButton(renderer), []);

  for (const template of [
    "addiction.hbs",
    "custom-arc.hbs",
    "custom-condition.hbs",
    "heat.hbs",
    "injury.hbs",
    "mor.hbs"
  ]) {
    assert.deepEqual(
      findButtonsMissingTypeButton(read("templates", "conditions", "rows", template)),
      [],
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
  const proofFlags = {};
  const player = {
    id: "player",
    isGM: false,
    active: true,
    async setFlag(_scope, key, value) { proofFlags[key] = value; return value; },
    getFlag(_scope, key) { return proofFlags[key]; },
    async unsetFlag(_scope, key) { delete proofFlags[key]; }
  };
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

test("nested CONDITIONS headings remain discoverable for the decorative-border toggle", async () => {
  const previousHTMLElement = globalThis.HTMLElement;

  class FakeElement {
    constructor(text = "", children = []) {
      this._text = text;
      this.children = children;
    }

    get textContent() {
      return `${this._text}${this.children.map((child) => child.textContent).join("")}`;
    }

    querySelectorAll(selector) {
      if (selector !== "*") return [];
      const result = [];
      const visit = (element) => {
        for (const child of element.children) {
          result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    }
  }

  globalThis.HTMLElement = FakeElement;
  try {
    const { findConditionHeader } = await import(`../scripts/sheet-adapter/forbidden-lands-v1.js?nested-condition-heading=${Date.now()}`);
    const label = new FakeElement("CONDITIONS");
    const heading = new FakeElement("", [label]);
    const mainTab = new FakeElement("", [heading]);

    assert.equal(findConditionHeader(mainTab), heading);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});

test("PR11: BIO save queues survive release until the active write settles", () => {
  const source = read("scripts", "biography.js");
  const release = source.slice(source.indexOf("export function releaseBiographyState"), source.indexOf("export function closeBiographyDrawer"));

  assert.doesNotMatch(release, /SAVE_CHAINS\.delete\(key\)/);
  assert.doesNotMatch(release, /PILGRIM_SAVE_CHAINS\.delete\(key\)/);
  assert.match(source, /chain\.finally\(\(\) => \{\s*if \(SAVE_CHAINS\.get\(key\) === chain\) SAVE_CHAINS\.delete\(key\);/);
  assert.match(source, /chain\.finally\(\(\) => \{\s*if \(PILGRIM_SAVE_CHAINS\.get\(key\) === chain\) PILGRIM_SAVE_CHAINS\.delete\(key\);/);
});

test("PR11: failed wash cleanup cannot fall through to the success path", () => {
  const source = read("scripts", "conditions", "features", "wash.js");
  const cleanupCatch = source.slice(source.indexOf("could not remove stale wash states"), source.indexOf("Notifications.WashChanged"));
  assert.match(cleanupCatch, /return \{[\s\S]*changed:\s*false,[\s\S]*reason:\s*"cleanup-failed"/);
});

test("PR11: only a GM requester may suppress provider private summaries", () => {
  const source = read("scripts", "integration", "new-day-providers.js");
  assert.match(source, /const suppressChat = Boolean\(payload\?\.suppressChat\) && Boolean\(context\.requestUser\?\.isGM\)/);
  assert.match(source, /suppressChat\s*\n\s*\}\)\) \?\? \{\}/);
  assert.match(source, /if \(!suppressChat\) await postPrivateSummary/);
});

test("PR11: BIO mounting is guarded against duplicate hooks in one render pass", () => {
  const source = read("scripts", "main.js");
  assert.match(source, /bioTab\.dataset\.fblqaBiographyMounted === "true"/);
  assert.match(source, /bioTab\.querySelector\?\.\("\.fblqa-bio-shell"\)/);
  assert.match(source, /if \(!alreadyMounted && isBiographyTabActive\(root, bioTab\)\) setupBiographyTab\(app, actor, root\)/);
});

test("PR11: addiction result formatter has a local state formatter", () => {
  const source = read("scripts", "new-day.js");
  assert.match(source, /function formatAddictionNewDayResult\(result\)/);
  assert.match(source, /function formatAddictionState\(state\)/);
});

test("PR11: README API heading tracks the packaged release", () => {
  const readme = read("README.md");
  const manifest = JSON.parse(read("module.json"));
  assert.ok(readme.includes(`Available methods in ${manifest.version}:`));
});
