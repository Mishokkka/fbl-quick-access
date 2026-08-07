import test from "node:test";
import assert from "node:assert/strict";

const PreviousGame = globalThis.game;
globalThis.game = {
  i18n: { localize: (key) => key },
  modules: new Map()
};

const reputation = await import("../scripts/reputation.js");

test("reputation entries normalize legacy names and positive integer values", () => {
  const entries = reputation.normalizeReputationEntries([
    { id: "a", value: 3.9, reason: "Monster hunter", place: "Noctis" },
    { id: "b", amount: 0, description: "Ignored" },
    { id: "c", quantity: "2", description: "Rescue", location: "Damia" }
  ]);

  assert.deepEqual(entries, [
    { id: "a", amount: 3, description: "Monster hunter", location: "Noctis" },
    { id: "c", amount: 2, description: "Rescue", location: "Damia" }
  ]);
  assert.equal(reputation.getReputationTotal(entries), 5);
});

test("native reputation migrates into one anonymous ledger row", () => {
  const actor = {
    system: { bio: { reputation: { value: 4 } } },
    getFlag: () => undefined
  };

  const entries = reputation.getReputationEntries(actor);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 4);
  assert.equal(entries[0].description, "");
  assert.equal(entries[0].location, "");
});

test("stored empty ledger is authoritative over the native total", () => {
  const actor = {
    system: { bio: { reputation: { value: 7 } } },
    getFlag: () => []
  };

  assert.deepEqual(reputation.getReputationEntries(actor), []);
});

test("half and third checks sample individual reputation points rather than rows", () => {
  const entries = [
    { id: "hunter", amount: 5, description: "Hunter", location: "A" },
    { id: "cat", amount: 1, description: "Cat", location: "B" }
  ];

  const deterministic = () => 0;
  const half = reputation.selectRandomReputation(entries, 2, deterministic);
  const third = reputation.selectRandomReputation(entries, 3, deterministic);

  assert.equal(half.reduce((sum, selection) => sum + selection.amount, 0), 3);
  assert.equal(third.reduce((sum, selection) => sum + selection.amount, 0), 2);
  assert.ok(half.some((selection) => selection.amount < selection.entry.amount), "a row can be sampled only partially");
});

test("remote checks round fractional Reputation down", () => {
  const five = [{ id: "five", amount: 5, description: "", location: "" }];
  assert.equal(reputation.selectRandomReputation(five, 2, () => 0.5).reduce((sum, item) => sum + item.amount, 0), 2);
  assert.equal(reputation.selectRandomReputation(five, 3, () => 0.5).reduce((sum, item) => sum + item.amount, 0), 1);

  const one = [{ id: "one", amount: 1, description: "", location: "" }];
  assert.deepEqual(reputation.selectRandomReputation(one, 2, () => 0.5), []);
  assert.deepEqual(reputation.selectRandomReputation(one, 3, () => 0.5), []);
});

if (PreviousGame === undefined) delete globalThis.game;
else globalThis.game = PreviousGame;

test("native header Reputation control opens the ledger dialog", () => {
  const previous = {
    HTMLElement: globalThis.HTMLElement,
    foundry: globalThis.foundry,
    ui: globalThis.ui
  };
  let rendered = 0;
  let dialogConfig = null;

  class FakeElement {
    constructor() {
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.classList = { add: () => {}, contains: () => false };
      this.previousElementSibling = null;
      this.parentCell = null;
      this.title = "";
      this.value = "";
      this.readOnly = false;
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    closest(selector) { return selector === "td" ? this.parentCell : null; }
    querySelector() { return null; }
    dispatch(type, extra = {}) {
      this.listeners.get(type)?.({
        key: extra.key,
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {}
      });
    }
  }

  class FakeDialogV2 {
    constructor(config) {
      dialogConfig = config;
      assert.ok(Array.isArray(config.buttons) && config.buttons.length > 0, "v13 fixture rejects empty DialogV2 button arrays");
      this.config = config;
      this.listeners = new Map();
      this.element = null;
      this.form = null;
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    render(force) { assert.equal(force, true); rendered += 1; return Promise.resolve(this); }
  }

  const input = new FakeElement();
  const inputCell = new FakeElement();
  const labelCell = new FakeElement();
  const nativeRoll = new FakeElement();
  input.parentCell = inputCell;
  inputCell.previousElementSibling = labelCell;
  labelCell.querySelector = (selector) => selector === ".roll-reputation" ? nativeRoll : null;

  const root = {
    querySelector(selector) {
      if (selector === 'input[name="system.bio.reputation.value"]') return input;
      return null;
    }
  };
  const actor = {
    id: "reputation-click-test",
    uuid: "Actor.reputation-click-test",
    name: "Tester",
    isOwner: true,
    system: { bio: { reputation: { value: 3 } } },
    getFlag: () => []
  };

  try {
    globalThis.HTMLElement = FakeElement;
    globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };
    globalThis.ui = { notifications: {} };

    reputation.setupReputationManager({}, actor, root);
    assert.equal(input.dataset.fblqaReputationBound, "true");
    assert.equal(nativeRoll.dataset.fblqaReputationBound, "true");

    nativeRoll.dispatch("click");
    assert.equal(rendered, 1);
    assert.equal(dialogConfig.buttons.length, 1);
    assert.equal(dialogConfig.buttons[0].action, "__fblqa_buttonless");
    assert.equal(dialogConfig.buttons[0].disabled, true);
  } finally {
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.foundry = previous.foundry;
    globalThis.ui = previous.ui;
  }
});
