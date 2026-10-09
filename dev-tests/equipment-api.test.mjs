import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.CONFIG = { fbl: {} };
globalThis.game = { user: { id: "player" } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };
const { getEquipmentState, performEquipmentAction, registerEquipmentHooks, previewEquipmentAction, getEquipmentReceipt } = await import("../scripts/integration/equipment-api.js");

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
    flags, writes: [], failNext: false, cancelNext: false,
    testUserPermission: () => observer,
    getFlag: (_module, key) => flags[key],
    async update(data) {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (this.failNext) { this.failNext = false; throw new Error("storage failed"); }
      if (this.cancelNext) { this.cancelNext = false; return undefined; }
      this.writes.push(structuredClone(data));
      for (const [path, value] of Object.entries(data)) flags[path.split(".").at(-1)] = structuredClone(value);
      return this;
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
  actor.cancelNext = true;
  const result = await performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" });
  assert.equal(result.changed, false);
  assert.equal(actor.cancelNext, true);
  assert.equal(actor.writes.length, 0);
  actor.items.delete("sword");
  const state = getEquipmentState(actor);
  assert.equal(state.hands.left, null);
  assert.equal(state.heldItems.left, null);
});

for (const command of [
  { type: "hold", hand: "both", itemId: "sword" },
  { type: "stow", hand: "left" },
  { type: "swapHands" },
  { type: "clearSlot", index: 0 }
]) {
  test(`cancelled ${command.type} rejects without changing hands, slots or inventory`, async () => {
    const actor = actorFixture({ hands: { left: "shield", right: "sword" } });
    const before = getEquipmentState(actor);
    actor.cancelNext = true;
    await assert.rejects(performEquipmentAction(actor, command, { expectedRevision: before.revision }), /update was cancelled/i);
    assert.deepEqual(getEquipmentState(actor), before);
    assert.equal(actor.writes.length, 0);
    assert.equal(actor.items.size, 3);
  });
}

test("queued commands recover after cancellation and keep the unchanged revision usable", async () => {
  const actor = actorFixture();
  const expectedRevision = getEquipmentState(actor).revision;
  actor.cancelNext = true;
  const cancelled = performEquipmentAction(actor, { type: "hold", hand: "left", itemId: "sword" }, { expectedRevision });
  const next = performEquipmentAction(actor, { type: "hold", hand: "right", itemId: "shield" }, { expectedRevision });
  await assert.rejects(cancelled, /update was cancelled/i);
  const result = await next;
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.hands, { left: null, right: "shield" });
  assert.equal(actor.writes.length, 1);
});

test("documented equipment examples handle absent integrations and select an eligible owned slot", async () => {
  const markdown = readFileSync(new URL("../INTEGRATION_API.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const section = markdown.split("## Equipment and action-widget integration")[1].split("## Item tooltips")[0];
  const snippets = [...section.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1]);
  const directExample = snippets.find(code => code.includes("qa.performEquipmentAction"));
  const widgetExample = snippets.find(code => code.includes("widget.quickAccess.performAction"));
  assert.ok(directExample && widgetExample);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = async (code, modules, actor) => new AsyncFunction("game", "actor", code)({ modules }, actor);
  await run(directExample, new Map(), actorFixture());
  await run(widgetExample, new Map());
  await run(widgetExample, new Map([["yze-combat-permission-fix", { api: {} }]]));
  let writes = 0;
  const quickAccess = { getState: () => null, performAction: async () => { writes++; } };
  const modules = new Map([["yze-combat-permission-fix", { api: { quickAccess } }]]);
  await run(widgetExample, modules);
  assert.equal(writes, 0);
  quickAccess.getState = () => ({ editable: false, revision: "readonly" });
  await run(widgetExample, modules);
  assert.equal(writes, 0);
  quickAccess.getState = () => ({ editable: true, revision: "snapshot" });
  quickAccess.performAction = async (command, options) => {
    assert.deepEqual(command, { type: "swapHands" });
    assert.deepEqual(options, { expectedRevision: "snapshot" });
    writes++;
  };
  await run(widgetExample, modules);
  assert.equal(writes, 1);
  const actor = actorFixture({ slots: [null, "sword"] });
  const qa = { capabilities: { equipment: true }, equipmentApiVersion: 1, getEquipmentState, performEquipmentAction };
  await run(directExample, new Map([["fbl-quick-access", { api: qa }]]), actor);
  assert.deepEqual(getEquipmentState(actor).hands, { left: null, right: "sword" });
  const emptyActor = actorFixture({ slots: [] });
  await run(directExample, new Map([["fbl-quick-access", { api: qa }]]), emptyActor);
  assert.equal(emptyActor.writes.length, 0);
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

test("preview shows displaced items and never writes; inventory contains only eligible items", () => {
  const actor=actorFixture({hands:{left:'shield',right:'sword'}});
  const plan=previewEquipmentAction(actor,{type:'hold',itemId:'sword',hand:'both'});
  assert.deepEqual(plan.hands,{left:'sword',right:'sword'});
  assert.deepEqual(plan.displaced.map(i=>i.id),['shield']);
  assert.deepEqual(getEquipmentState(actor).inventory.map(i=>i.id),['sword','shield']);
  assert.equal(actor.writes.length,0);
});

test("atomic receipts replay before stale-revision checks and reject id reuse", async () => {
  const actor=actorFixture(), command={type:'hold',itemId:'sword',hand:'both'};
  const options={operationId:'one',expectedRevision:getEquipmentState(actor).revision};
  await performEquipmentAction(actor,command,options);
  const replay=await performEquipmentAction(actor,command,options);
  assert.equal(replay.replayed,true); assert.equal(actor.writes.length,1);
  assert.ok(Object.hasOwn(actor.writes[0],'flags.fbl-quick-access.equipmentReceipts'));
  const detached=getEquipmentReceipt(actor,'one'); detached.after.hands.left='wrong';
  assert.equal(getEquipmentReceipt(actor,'one').after.hands.left,'sword');
  await assert.rejects(performEquipmentAction(actor,{type:'stow',hand:'both'},{operationId:'one'}),/another command/);
});

test("assignment moves existing bindings, preserves overflow and rejects ineligible inventory", async () => {
  const actor=actorFixture({slots:['sword',null,'shield','sword']});
  await performEquipmentAction(actor,{type:'assignSlot',index:1,itemId:'sword'});
  assert.deepEqual(actor.flags.slots,[null,'sword','shield',null]);
  await assert.rejects(performEquipmentAction(actor,{type:'assignSlot',index:2,itemId:'shield'}),/available slot/);
  await assert.rejects(performEquipmentAction(actor,{type:'assignSlot',index:0,itemId:'heavy'}),/eligible inventory/);
});

test("slot swap can recover overflow and clearSlot does not release a grip", async () => {
  const actor=actorFixture({slots:['sword',null,'shield'],hands:{left:'shield',right:null}});
  await performEquipmentAction(actor,{type:'swapSlots',from:2,to:1},{operationId:'move'});
  assert.deepEqual(actor.flags.slots,['sword','shield',null]);
  await performEquipmentAction(actor,{type:'clearSlot',index:1});
  assert.deepEqual(getEquipmentState(actor).hands,{left:'shield',right:null});
  await performEquipmentAction(actor,{type:'hold',itemId:'shield',hand:'both'});
  assert.deepEqual(getEquipmentState(actor).hands,{left:'shield',right:'shield'});
});

test("undo restores only the touched fields and is itself safely replayable", async () => {
  const actor=actorFixture();
  await performEquipmentAction(actor,{type:'swapSlots',from:0,to:1},{operationId:'move'});
  await performEquipmentAction(actor,{type:'hold',itemId:'sword',hand:'both'});
  await performEquipmentAction(actor,{type:'undo',receiptId:'move'},{operationId:'move_undo'});
  await performEquipmentAction(actor,{type:'undo',receiptId:'move'},{operationId:'move_undo'});
  assert.deepEqual(actor.flags.slots,['sword','shield']);
  assert.deepEqual(getEquipmentState(actor).hands,{left:'sword',right:'sword'});
  assert.equal(actor.writes.length,3);
});

test("undo refuses modified postimages and deleted restored items", async () => {
  const actor=actorFixture({hands:{left:'shield',right:null}});
  await performEquipmentAction(actor,{type:'hold',itemId:'sword',hand:'both'},{operationId:'hold'});
  actor.items.delete('shield');
  assert.throws(()=>previewEquipmentAction(actor,{type:'undo',receiptId:'hold'}),/removed/);
  actor.flags.equipmentHands={left:null,right:'sword'};
  await assert.rejects(performEquipmentAction(actor,{type:'undo',receiptId:'hold'}),/changed since/);
  assert.equal(actor.writes.length,1);
});

test("cancelled or rejected writes cannot leave a receipt, and retry uses the same id", async () => {
  const actor=actorFixture(), command={type:'hold',itemId:'sword',hand:'left'};
  actor.cancelNext=true;
  await assert.rejects(performEquipmentAction(actor,command,{operationId:'retry'}),/cancelled/);
  assert.equal(getEquipmentReceipt(actor,'retry'),null);
  await performEquipmentAction(actor,command,{operationId:'retry'});
  assert.equal(actor.writes.length,1);
});

test("receipts remain bounded and no-op operations do not write a receipt", async () => {
  const actor=actorFixture();
  await performEquipmentAction(actor,{type:'stow',hand:'both'},{operationId:'noop'});
  assert.equal(getEquipmentReceipt(actor,'noop'),null);
  for(let n=0;n<34;n++) await performEquipmentAction(actor,{type:'hold',itemId:'sword',hand:n%2?'right':'left'},{operationId:'op'+n});
  assert.equal(actor.flags.equipmentReceipts.length,32);
  assert.equal(getEquipmentReceipt(actor,'op0'),null);
  assert.equal(getEquipmentReceipt(actor,'op33').id,'op33');
});

test("a hook-altered update cannot report success without its durable receipt", async () => {
  const actor=actorFixture();
  const original=actor.update;
  actor.update=async function(data){const filtered={...data};delete filtered['flags.fbl-quick-access.equipmentReceipts'];return original.call(this,filtered);};
  await assert.rejects(performEquipmentAction(actor,{type:'hold',hand:'left',itemId:'sword'},{operationId:'altered'}),/changed during the update/);
  assert.equal(getEquipmentReceipt(actor,'altered'),null);
});
