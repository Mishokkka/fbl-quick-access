import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function getCssRuleBody(source, selectorPattern, message) {
  const match = source.match(new RegExp(`${selectorPattern}[^{}]*\\{([^}]*)\\}`, "m"));
  assert.ok(match, message);
  return match[1];
}

function getCssDeclaration(ruleBody, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ruleBody.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "m"))?.[1]?.trim() ?? null;
}

test("Gear context menu uses a light palette and a red Delete icon", () => {
  const tokens = readFileSync(join(root, "styles", "00-tokens.css"), "utf8");
  const gearCss = readFileSync(join(root, "styles", "04-gear-cards.css"), "utf8");

  const tokenBody = getCssRuleBody(tokens, ":root", "token variables must remain in :root");
  const dangerIconBody = getCssRuleBody(
    gearCss,
    "\\.fblqa-gear-menu-button-danger\\s+\\.fblqa-gear-menu-icon",
    "Delete icon rule must exist"
  );

  assert.match(getCssDeclaration(tokenBody, "--fblqa-context-bg") ?? "", /^rgba\(255,\s*255,\s*255/);
  assert.equal(getCssDeclaration(tokenBody, "--fblqa-context-text"), "#111111");
  assert.equal(getCssDeclaration(dangerIconBody, "color"), "#b00020");
});

test("character-sheet render removes the Chargen header control", () => {
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");
  const controls = readFileSync(join(root, "scripts", "header-controls.js"), "utf8");

  assert.match(main, /removeChargenButton\(root\)/);
  assert.match(controls, /data-action='chargen'/);
  assert.match(controls, /CHARGEN_LABELS/);
});

test("Long Rest closes before opening the separate new-day workflow", async () => {
  const { runPostRestWorkflow } = await import(`../scripts/rest.js?post-rest=${Date.now()}`);
  const events = [];

  await runPostRestWorkflow({
    startsNewDay: true,
    closeDialog: async () => events.push("close"),
    openNewDay: async () => events.push("new-day")
  });
  assert.deepEqual(events, ["close", "new-day"]);

  events.length = 0;
  await runPostRestWorkflow({
    startsNewDay: false,
    closeDialog: async () => events.push("close"),
    openNewDay: async () => events.push("new-day")
  });
  assert.deepEqual(events, ["close"]);
});


test("Rest switching is state-driven, keeps circular radios, and reads the DialogV2 form", () => {
  const rest = readFileSync(join(root, "scripts", "rest.js"), "utf8");
  const css = readFileSync(join(root, "styles", "10-rest.css"), "utf8");

  assert.match(rest, /height:\s*"auto"/);
  assert.match(rest, /scheduleRestDialogAutoSize/);
  assert.match(rest, /setPosition\?\.\(\{ height: "auto" \}\)/);
  assert.match(rest, /pane\.hidden = hidden/);
  assert.match(rest, /if \(event\.target\?\.name === "restType"\) updatePanes\(\)/);
  assert.match(rest, /findDialogForm\(_button\?\.form \?\? renderedDialog \?\? html, "form"\)/);
  assert.match(css, /input\[type="radio"\][\s\S]*?appearance:\s*none;[\s\S]*?border-radius:\s*50%/);
  assert.match(css, /\.fblqa-rest-form \.fblqa-rest-pane\[hidden\][\s\S]*?display:\s*none/);
  assert.doesNotMatch(css, /:has\([^)]*restType[^)]*\)[^{]*\.fblqa-rest-pane/);
  assert.match(css, /fblqa-rest-dialog \.window-header \[data-action="close"\][\s\S]*?color:\s*#111/);
});

test("Rest Apply consumes the native DialogV2 button.form and performs the actor update", async () => {
  const previous = {
    game: globalThis.game,
    foundry: globalThis.foundry,
    HTMLElement: globalThis.HTMLElement,
    ui: globalThis.ui,
    ChatMessage: globalThis.ChatMessage
  };
  let dialogConfig = null;
  const updates = [];

  class FakeElement {
    matches(selector) { return selector === "form"; }
    querySelector() { return null; }
  }

  class FakeForm extends FakeElement {
    constructor() {
      super();
      this.controls = {
        restType: { value: "long", checked: true },
        hasHeatSource: { checked: false },
        startsNewDay: { checked: false },
        useShortRecovery: { checked: false },
        shortAttribute: { value: "strength" },
        shortConsumable: { value: "" },
        resetShortQuarter: { checked: false }
      };
    }
    querySelector(selector) {
      if (selector === 'input[name="restType"]:checked') return this.controls.restType;
      const name = selector.match(/name="([^"]+)"/)?.[1];
      return name ? this.controls[name] ?? null : null;
    }
  }

  class FakeDialogV2 {
    constructor(config) {
      dialogConfig = config;
      this.element = new FakeElement();
      this.form = new FakeForm();
      this.listeners = new Map();
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    render() { return Promise.resolve(this); }
    close() { this.listeners.get("close")?.(); return Promise.resolve(this); }
  }

  try {
    globalThis.HTMLElement = FakeElement;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (key) => key, format: (_key, data) => JSON.stringify(data) },
      settings: { get: () => false },
      time: { worldTime: 0 },
      modules: new Map()
    };
    globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    delete globalThis.ChatMessage;

    const actor = {
      id: "rest-dialog-actor",
      name: "Rest Tester",
      isOwner: true,
      system: {
        attribute: {
          strength: { value: 2, max: 3 },
          agility: { value: 3, max: 3 },
          wits: { value: 3, max: 3 },
          empathy: { value: 3, max: 3 }
        },
        condition: {}
      },
      effects: [],
      getFlag: () => null,
      async update(update) { updates.push(update); },
      async deleteEmbeddedDocuments() {},
      async setFlag() {},
      async unsetFlag() {}
    };

    const rest = await import(`../scripts/rest.js?dialog-apply=${Date.now()}`);
    const completion = rest.openRestDialog(null, actor, null);
    assert.ok(dialogConfig, "Rest DialogV2 configuration must be created synchronously");
    const apply = dialogConfig.buttons.find((button) => button.action === "apply");
    assert.ok(apply, "Rest Apply button must exist");

    const fakeButton = { form: new FakeForm() };
    await apply.callback({}, fakeButton, { element: new FakeElement(), close: async () => {} });
    const result = await completion;

    assert.equal(result?.type, "long");
    assert.deepEqual(updates, [{ "system.attribute.strength.value": 3 }]);
  } finally {
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.ui = previous.ui;
    globalThis.ChatMessage = previous.ChatMessage;
  }
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
  assert.match(reputation, /buttonless:\s*true/);
  assert.doesNotMatch(reputation, /Common\.Close/);
  assert.match(reputation, /scheduleReputationDialogAutoSize/);
  assert.match(reputation, /setupReputationNoteSummary/);
  assert.match(reputation, /ChatMessage\?\.create/);
  assert.doesNotMatch(reputation, /roll\.toMessage/);
  assert.match(css, /\.fblqa-reputation-row/);
  assert.match(css, /\.fblqa-reputation-chat-card/);
  assert.match(css, /\.fblqa-reputation-note-summary/);
  assert.doesNotMatch(css, /\.fblqa-reputation-value\s*\{[^}]*background:/);
});


test("Reputation dialog uses a light header and only the window close control", () => {
  const css = readFileSync(join(root, "styles", "12-reputation.css"), "utf8");
  const reputation = readFileSync(join(root, "scripts", "reputation.js"), "utf8");
  assert.match(css, /fblqa-reputation-dialog \.window-header[\s\S]*?background:\s*rgba\(221, 217, 211, 0\.98\)/);
  assert.match(css, /fblqa-reputation-dialog[\s\S]*?\[data-action="close"\][\s\S]*?color:\s*#111\s*!important/);
  assert.match(reputation, /buttons:\s*\{\}/);
  assert.match(reputation, /buttonless:\s*true/);
  assert.doesNotMatch(reputation, /label:\s*qaLocalize\("Common\.Close"/);
  assert.match(css, /fblqa-reputation-dialog \.form-footer,[\s\S]*?display:\s*none/);
});

test("Pilgrim font choices refresh the registered setting and live select", async () => {
  const previous = {
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    game: globalThis.game,
    document: globalThis.document
  };
  const setting = { choices: {} };
  const selectedOptions = [];
  const select = {
    tagName: "SELECT",
    value: "World Serif",
    replaceChildren(...options) { selectedOptions.splice(0, selectedOptions.length, ...options); },
    append(option) { selectedOptions.push(option); }
  };

  try {
    globalThis.foundry = {
      applications: { settings: { menus: { FontConfig: {
        getAvailableFontChoices: () => ({ "World Serif": "World Serif", "World Sans": "World Sans" }),
        getAvailableFonts: () => []
      } } } }
    };
    globalThis.CONFIG = { fontDefinitions: {}, defaultFontFamily: "World Serif" };
    globalThis.game = {
      settings: {
        settings: { get: () => setting },
        get(namespace, key) {
          if (namespace === "core" && key === "fonts") return {};
          if (namespace === "fbl-quick-access" && key === "pilgrimCardFont") return "World Serif";
          return null;
        }
      }
    };
    globalThis.document = {
      fonts: [],
      createElement: () => ({ value: "", textContent: "", selected: false })
    };

    const { refreshPilgrimFontChoices } = await import(`../scripts/settings.js?refresh=${Date.now()}`);
    const choices = refreshPilgrimFontChoices({ querySelector: () => select });

    assert.equal(choices["World Serif"], "World Serif");
    assert.equal(setting.choices["World Sans"], "World Sans");
    assert.equal(selectedOptions.some((option) => option.value === "World Serif" && option.selected), true);
  } finally {
    globalThis.foundry = previous.foundry;
    globalThis.CONFIG = previous.CONFIG;
    globalThis.game = previous.game;
    globalThis.document = previous.document;
  }
});


test("BIO form controls and rich editor inherit the Forbidden Lands sheet font", () => {
  const css = readFileSync(join(root, "styles", "13-biography.css"), "utf8");
  const body = getCssRuleBody(
    css,
    "\\.fblqa-biography-tab\\s+:where\\([\\s\\S]*?\\)",
    "BIO font inheritance rule must exist"
  );
  assert.equal(getCssDeclaration(body, "font-family"), "inherit");
});

test("moving directly to another item replaces the visible tooltip without delay", async () => {
  const { planTooltipTransition } = await import(`../scripts/tooltips.js?transition=${Date.now()}`);
  const first = {};
  const second = {};

  assert.deepEqual(planTooltipTransition(first, second, true), {
    replaceVisibleContent: true,
    delayMs: 0
  });
  assert.equal(planTooltipTransition(second, second, true).replaceVisibleContent, false);
});
