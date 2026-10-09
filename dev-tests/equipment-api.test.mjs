import test from "node:test";
import assert from "node:assert/strict";

globalThis.CONFIG = { fbl: {} };
globalThis.game = { user: { id: "player" } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };
const { getEquipmentState, performEquipmentAction, registerEquipmentHooks } = await import("../scripts/integration/equipment-api.js");

function actorFixture({ owner = true, observer = true, slots = ["sword", "shield"], hands } = {}) {
  const flags = { slots: structuredClone(slots), equipmentHands: structuredClone(hands) };
  return {
    documentName: "Actor", type: "character", id: "pc", uuid: "Actor.pc", isOwner: owner,
    system: { attribute: { agility: { max: 2 } }, skill: { "sleight-of-hand": { value: 0 } } },
    items: new Map([
      ["sword", { id: "sword", uuid: "Actor.pc.Item.sword", name: "Sword", type: "weapon", system: { weight: "normal" } }],
      ["shield", { id: "shield", name: "Shield", type: "armor", system: { weight: "normal" } }],
      ["heavy", { id: "heavy", name: "Heavy", type: "gear", system: { weight: "heavy" } }]
    ]),
    flags, writes: [], failNext: false,
    testUserPermission: () => observer,
    getFlag: (_module, key) => flags[key],
    async update(data) {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (this.failNext) { this.failNext = false; throw new Error("storage failed"); }
      this.writes.push(structuredClone(data));
      for (const [path, value] of Object.entries(data)) flags[path.split(".").at(-1)] = structuredClone(value);
    }
  };
}

test("snapshot preserves overflow/missing slots and never mutates actor flags", () => {
  const actor = actorFixture({ slots: ["sword", "missing", "shield"], hands: { left: "missing", right: "sword" } });
  const state = getEquipmentState(actor);
  assert.equal(state.slots[1].missing, true);
  assert.equal(state.slots[2].available, false);
  assert.equal(state.slots[2].canHold, false);
  assert.deepEqual(state.hands, { left: null, right: "sword" });
  state.slots[0].item.name = "edited";
  state.hands.right = "edited";
  assert.equal(actor.items.get("sword").name, "Sword");
  assert.equal(actor.flags.equipmentHands.right, "sword");
  assert.equal(actor.writes.length, 0);
});

test("observers can read but cannot write; private actors cannot be read", async () => {
  const observer = actorFixture({ owner: false });
  assert.equal(getEquipmentState(observer).editable, false);
  await assert.rejects(performEquipmentAction(observer, { type: "hold", hand: "left", itemId: "sword" }), /permission to modify/i);
  assert.throws(() => getEquipmentState(actorFixture({ owner: false, observer: false })), /permission to view/i);
  assert.throws(() => getEquipmentState({}), /Actor document/);
});

test("holding in both hands uses one write and leaves native item/slot data intact", async () => {
  const actor = actorFixture();
  const result = await performEquipmentAction(actor, { type: "hold", hand: "both", itemId: "sword" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.hands, { left: "sword", right: "sword" });
  assert.deepEqual(actor.writes, [{ "flags.fbl-quick-access.equipmentHands": { left: "sword", right: "sword" } }]);
  assert.deepEqual(actor.flags.slots, ["sword", "shield"]);
  assert.equal(actor.items.get("sword").system.weight, "normal");
});

test("replacing or stowing either side releases the entire two-handed grip", async () => {
  const actor = actorFixture({ hands: { left: "sword", right: "sword" } });
  await performEquipmentAction(actor, { type: "hold", hand: "right", itemId: "shield" });
  assert.deepEqual(getEquipmentState(actor).hands, { left: null, right: "shield" });
  await performEquipmentAction(actor, { type: "hold", hand: "both", itemId: "sword" });
  await performEquipmentAction(actor, { type: "stow", hand: "left" });
  assert.deepEqual(getEquipmentState(actor).hands, { left: null, right: null });
});

test("moving an item between hands and swapping hands does not duplicate it", async () => {
  const actor = actorFixture({ hands: { left: "sword", right: "shield" } });
  await performEquipmentAction(actor, { type: "swapHands" });
  assert.deepEqual(getEquipmentState(actor).hands, { left: "shield", right: "sword" });
  await performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" });
  assert.deepEqual(getEquipmentState(actor).hands, { left: "sword", right: null });
});

test("hold rejects heavy, overflow, missing, foreign and unslotted item ids", async () => {
  const actor = actorFixture({ slots: ["sword", "heavy", "shield"] });
  for (const itemId of ["heavy", "shield", "missing", "foreign"]) {
    await assert.rejects(performEquipmentAction(actor, { type: "hold", hand: "left", itemId }), /eligible item/i);
  }
  actor.items.delete("sword");
  await assert.rejects(performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" }), /eligible item/i);
  assert.equal(actor.writes.length, 0);
});

test("clearSlot preserves overflow, held items and inventory", async () => {
  const actor = actorFixture({ slots: ["sword", "shield", "heavy"], hands: { left: "sword", right: null } });
  await performEquipmentAction(actor, { type: "clearSlot", index: 0 });
  assert.deepEqual(actor.flags.slots, [null, "shield", "heavy"]);
  assert.equal(getEquipmentState(actor).hands.left, "sword");
  assert.equal(actor.items.size, 3);
  await assert.rejects(performEquipmentAction(actor, { type: "clearSlot", index: -1 }), /index/);
});

test("stale snapshots and unknown commands do not write", async () => {
  const actor = actorFixture();
  const revision = getEquipmentState(actor).revision;
  const other = actorFixture();
  other.uuid = "Scene.other.Token.pc.Actor.pc";
  await assert.rejects(performEquipmentAction(other, { type: "swapHands" }, { expectedRevision: revision }), /changed/);
  actor.flags.slots[0] = null;
  await assert.rejects(performEquipmentAction(actor, { type: "swapHands" }, { expectedRevision: revision }), /changed/);
  await assert.rejects(performEquipmentAction(actor, { type: "deleteItem" }), /Unknown/);
  await assert.rejects(performEquipmentAction(actor, { type: "stow", hand: "head" }), /hand must/);
  assert.equal(actor.writes.length, 0);
});

test("queued commands use live state, capture input and recover after failed persistence", async () => {
  const actor = actorFixture();
  const command = { type: "hold", hand: "left", itemId: "sword" };
  const first = performEquipmentAction(actor, command);
  command.itemId = "foreign";
  const second = performEquipmentAction(actor, { type: "hold", hand: "right", itemId: "shield" });
  await Promise.all([first, second]);
  assert.deepEqual(getEquipmentState(actor).hands, { left: "sword", right: "shield" });
  actor.failNext = true;
  await assert.rejects(performEquipmentAction(actor, { type: "stow", hand: "both" }), /storage failed/);
  await performEquipmentAction(actor, { type: "stow", hand: "both" });
  assert.deepEqual(getEquipmentState(actor).hands, { left: null, right: null });
});

test("queued revision and ownership checks run at execution time", async () => {
  const actor = actorFixture();
  const expectedRevision = getEquipmentState(actor).revision;
  const first = performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" }, { expectedRevision });
  const second = performEquipmentAction(actor, { type: "hold", hand: "right", itemId: "shield" }, { expectedRevision });
  await first;
  await assert.rejects(second, /changed/);
  const denied = performEquipmentAction(actor, { type: "stow", hand: "both" });
  actor.isOwner = false;
  await assert.rejects(denied, /permission to modify/i);
});

test("repeated no-op commands do not write, and deleted held items disappear from snapshots", async () => {
  const actor = actorFixture({ hands: { left: "sword", right: null } });
  await performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" });
  assert.equal(actor.writes.length, 0);
  actor.items.delete("sword");
  const state = getEquipmentState(actor);
  assert.equal(state.hands.left, null);
  assert.equal(state.heldItems.left, null);
});

test("equipment change hook follows Actor/Item updates even without sheet renders", () => {
  const handlers = new Map();
  const events = [];
  globalThis.Hooks = { on: (name, handler) => handlers.set(name, handler), callAll: (...args) => events.push(args) };
  registerEquipmentHooks();
  const actor = actorFixture();
  handlers.get("updateActor")(actor, {}, { render: false });
  handlers.get("deleteItem")({ parent: actor });
  handlers.get("createItem")({ parent: { documentName: "Item" } });
  assert.deepEqual(events, [["fblQuickAccess.equipmentChanged", actor], ["fblQuickAccess.equipmentChanged", actor]]);
});
