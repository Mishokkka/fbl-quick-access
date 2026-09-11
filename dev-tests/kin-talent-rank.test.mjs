import test from "node:test";
import assert from "node:assert/strict";

const previousHooks = globalThis.Hooks;
const previousGame = globalThis.game;

globalThis.Hooks = { on() {} };
globalThis.game = {
  system: { id: "forbidden-lands" },
  i18n: { localize: (key) => key === "TALENT.RANK" ? "Rank" : key }
};

const { ensureKinTalentRankField } = await import("../scripts/kin-talent-rank.js");

if (previousHooks === undefined) delete globalThis.Hooks;
else globalThis.Hooks = previousHooks;
if (previousGame === undefined) delete globalThis.game;
else globalThis.game = previousGame;

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
    this.classNames = new Set();
    this.classList = { add: (...names) => names.forEach((name) => this.classNames.add(name)) };
    this.name = "";
    this.type = "";
    this.value = "";
    this.disabled = false;
    this.textContent = "";
  }

  append(child) {
    child.parentNode = this;
    this.children.push(child);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  insertAdjacentElement(position, element) {
    assert.equal(position, "afterend");
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    element.parentNode = this.parentNode;
    siblings.splice(index + 1, 0, element);
  }

  querySelector(selector) {
    if (selector === ".header-stats" && this.classNames.has("header-stats")) return this;
    if (selector === 'select[name="system.type"]' && this.tagName === "SELECT" && this.name === "system.type") return this;
    if (selector === 'input[name="system.rank"]' && this.tagName === "INPUT" && this.name === "system.rank") return this;

    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
}

function createTalentSheet(type = "kin", rank = 1) {
  const doc = { createElement: (tagName) => new FakeNode(tagName, doc) };
  const root = new FakeNode("form", doc);
  const headerStats = new FakeNode("div", doc);
  headerStats.classNames.add("header-stats");
  const typeSelect = new FakeNode("select", doc);
  typeSelect.name = "system.type";
  typeSelect.value = type;
  headerStats.append(typeSelect);
  root.append(headerStats);
  return { root, headerStats, typeSelect, rank };
}

test("Kin talent sheets get one editable native-style Rank field", async () => {
  const { root, headerStats, typeSelect } = createTalentSheet("kin", 2);
  const updates = [];
  const item = {
    type: "talent",
    isOwner: true,
    system: { type: "kin", rank: 2 },
    async update(data) { updates.push(data); }
  };
  const app = { options: { editable: true } };

  assert.equal(ensureKinTalentRankField(app, item, root), true);
  assert.equal(headerStats.children.length, 3);
  assert.equal(headerStats.children[0], typeSelect);
  assert.equal(headerStats.children[1].textContent, "Rank");

  const rankWrapper = headerStats.children[2];
  assert.equal(rankWrapper.classNames.has("rank"), true);
  const input = rankWrapper.children[0];
  assert.equal(input.name, "system.rank");
  assert.equal(input.type, "text");
  assert.equal(input.value, "2");

  input.value = "3";
  await input.listeners.get("change")({ currentTarget: input });
  assert.deepEqual(updates, [{ "system.rank": "3" }]);

  assert.equal(ensureKinTalentRankField(app, item, root), false, "must not duplicate an existing rank field");
  assert.equal(headerStats.querySelector('input[name="system.rank"]'), input);
});

test("non-Kin talents are left to the native Forbidden Lands sheet", () => {
  const { root, headerStats } = createTalentSheet("monster");
  const item = { type: "talent", isOwner: true, system: { type: "monster", rank: 1 }, update() {} };

  assert.equal(ensureKinTalentRankField({ options: { editable: true } }, item, root), false);
  assert.equal(headerStats.children.length, 1);
});
