import test from "node:test";
import assert from "node:assert/strict";
import { buildSlots } from "../scripts/quick-access.js";
import { setupGearOrdering } from "../scripts/gear-order.js";

class ElementFixture {
  constructor() {
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      [Symbol.iterator]: () => classes.values()
    };
    this.style = { setProperty() {} };
  }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 }; }
}

function fixture(t, { uuid = "Actor.pc", slots = ["sword", "shield"] } = {}) {
  const previous = Object.fromEntries(["HTMLElement", "document", "game", "CONFIG", "ui", "fromUuid"]
    .map(key => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  globalThis.HTMLElement = ElementFixture;
  globalThis.document = { createElement: () => new ElementFixture() };
  globalThis.game = { user: {}, i18n: { localize: key => key } };
  globalThis.CONFIG = { fbl: {} };
  globalThis.ui = { notifications: { warn() {} } };
  const flags = { slots: [...slots] }, writes = [];
  const actor = {
    id: uuid.split(".").at(-1), uuid, isOwner: true,
    system: { attribute: { agility: { max: 2 } } },
    items: new Map(["sword", "shield", "bow"].map(id => [id, { id, name: id, type: "weapon", system: { weight: "normal" } }])),
    getFlag: (_scope, key) => flags[key],
    async setFlag(_scope, key, value) { flags[key] = structuredClone(value); writes.push({ key, value: structuredClone(value) }); }
  };
  return { actor, flags, writes };
}

function dragEvent(data) {
  return {
    prevented: false, stopped: false, clientX: 0, clientY: 0,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    dataTransfer: { getData: type => type === "text/plain" ? JSON.stringify(data) : "" }
  };
}

function quickSlots(actor) {
  return buildSlots(null, actor, 2, actor.getFlag(null, "slots")).children;
}

test("quick-slot drag exchanges current bindings without duplicating an Item", async t => {
  const { actor, flags, writes } = fixture(t);
  const rows = quickSlots(actor);
  let data;
  rows[0].listeners.get("dragstart")({ dataTransfer: { setData: (_type, value) => { data = JSON.parse(value); } } });
  await rows[1].listeners.get("drop")(dragEvent(data));
  assert.deepEqual(flags.slots, ["shield", "sword"]);
  assert.equal(writes.length, 1);
});

for (const replacement of [null, "bow"]) {
  test(`quick-slot drag rejects a source binding changed to ${replacement}`, async t => {
    const { actor, flags, writes } = fixture(t);
    const rows = quickSlots(actor);
    const data = { type: "FBLQuickAccess", actorId: actor.id, actorUuid: actor.uuid, slotIndex: 0, itemId: "sword" };
    flags.slots[0] = replacement;
    await rows[1].listeners.get("drop")(dragEvent(data));
    assert.deepEqual(flags.slots, [replacement, "shield"]);
    assert.equal(writes.length, 0);
  });
}

test("quick-slot drag uses the full actor UUID when synthetic actors share ids", async t => {
  const { actor, flags, writes } = fixture(t, { uuid: "Scene.target.Token.target.Actor.shared" });
  const rows = quickSlots(actor);
  await rows[1].listeners.get("drop")(dragEvent({ type: "FBLQuickAccess", actorId: "shared",
    actorUuid: "Scene.other.Token.other.Actor.shared", slotIndex: 0, itemId: "sword" }));
  assert.deepEqual(flags.slots, ["sword", "shield"]);
  assert.equal(writes.length, 0);
});

test("quick-slot drag still accepts the same actor id when the UUID is absent", async t => {
  const { actor, flags } = fixture(t);
  await quickSlots(actor)[1].listeners.get("drop")(dragEvent({ type: "FBLQuickAccess", actorId: actor.id,
    slotIndex: 0, id: "sword" }));
  assert.deepEqual(flags.slots, ["shield", "sword"]);
});

function pendingInventoryDrop(actor, row) {
  const item = actor.items.get("bow");
  item.documentName = "Item";
  item.parent = actor;
  let finish;
  globalThis.fromUuid = () => new Promise(resolve => { finish = () => resolve(item); });
  const pending = row.listeners.get("drop")(dragEvent({ type: "Item", uuid: `${actor.uuid}.Item.bow` }));
  return { pending, finish };
}

test("inventory drop preserves slot edits made while resolving the Item UUID", async t => {
  const { actor, flags, writes } = fixture(t);
  const { pending, finish } = pendingInventoryDrop(actor, quickSlots(actor)[1]);
  flags.slots[0] = null;
  finish();
  await pending;
  assert.deepEqual(flags.slots, [null, "bow"]);
  assert.equal(writes.length, 1);
});

for (const change of ["capacity", "deleted Item", "changed target slot"]) {
  test(`inventory drop rechecks ${change} after resolving the Item UUID`, async t => {
    const { actor, flags, writes } = fixture(t);
    const { pending, finish } = pendingInventoryDrop(actor, quickSlots(actor)[1]);
    if (change === "capacity") actor.system.attribute.agility.max = 1;
    if (change === "deleted Item") actor.items.delete("bow");
    if (change === "changed target slot") flags.slots[1] = null;
    const preservedSlots = [...flags.slots];
    finish();
    await pending;
    assert.deepEqual(flags.slots, preservedSlots);
    assert.equal(writes.length, 0);
  });
}

function gearRows(actor) {
  const gears = new ElementFixture(), gearTab = new ElementFixture();
  const rows = ["sword", "shield"].map(itemId => {
    const row = new ElementFixture();
    row.dataset.itemId = itemId;
    row.parentElement = gears;
    row.closest = selector => selector === ".items-list, .inventory-list, ol, ul, tbody" ? gears : null;
    return row;
  });
  gears.querySelectorAll = selector => selector.startsWith(".fblqa-gear-card") && !selector.includes(",")
    || selector.startsWith(".items-header") ? [] : rows;
  gearTab.querySelectorAll = () => [gears];
  setupGearOrdering(null, actor, gearTab, null);
  return rows;
}

for (const sameSheet of [true, false]) {
  test(`native Gear payload reorders within its actor across ${sameSheet ? "one sheet" : "two sheets"}`, async t => {
    const { actor, flags, writes } = fixture(t);
    const rows = gearRows(actor);
    let data;
    rows[0].listeners.get("dragstart")({ dataTransfer: { setData: (_type, value) => { data = JSON.parse(value); } } });
    assert.equal(data.type, "Item");
    assert.equal(data.fblqaGearOrder, true);
    assert.equal(data.actorUuid, actor.uuid);
    const drop = dragEvent(data); drop.clientY = 30;
    await (sameSheet ? rows : gearRows(actor))[1].listeners.get("drop")(drop);
    assert.deepEqual(flags.gearOrder, ["shield", "sword"]);
    assert.equal(writes.length, 1);
    assert.equal(drop.stopped, true);
  });
}

test("foreign Gear drags with colliding Item ids remain available to native transfer", async t => {
  const { actor, writes } = fixture(t);
  const rows = gearRows(actor);
  rows[0].listeners.get("dragstart")({ dataTransfer: { setData() {} } });
  const drop = dragEvent({ type: "Item", itemId: "sword", actorUuid: "Actor.other", fblqaGearOrder: true });
  drop.clientY = 30;
  await rows[1].listeners.get("drop")(drop);
  assert.equal(writes.length, 0);
  assert.equal(drop.prevented, false);
  assert.equal(drop.stopped, false);
});

test("Gear drops between carry states remain available to the native sheet", async t => {
  const { actor, writes } = fixture(t);
  actor.items.get("sword").system.state = "equipped";
  actor.items.get("shield").system.state = "backpack";
  const rows = gearRows(actor);
  const drop = dragEvent({ type: "Item", itemId: "sword", actorUuid: actor.uuid, fblqaGearOrder: true });
  await rows[1].listeners.get("drop")(drop);
  assert.equal(writes.length, 0);
  assert.equal(drop.prevented, false);
  assert.equal(drop.stopped, false);
});
