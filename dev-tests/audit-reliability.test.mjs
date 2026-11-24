import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { applyDocumentUpdate, expandUpdateInPlace } from "./helpers/document-update.mjs";
import { buildNewDayPlan, buildNewDayPlanWithProviders, applyNewDayPlan, decrementFirstInteger, getNewDaySelection, initializeNewDayOperations } from "../scripts/new-day.js";
import { queueProfileSave, flushBiographySaves, releaseBiographyState, getBiographyProfile, biographyDisplayHtml } from "../scripts/biography.js";
import { updateHeatItem, parseHeatValue, saveAddictionState } from "../scripts/conditions/features/special-counters.js";
import { transitionWashLevel } from "../scripts/conditions/features/wash.js";
import { getConditionKind, getWashStage } from "../scripts/conditions/condition-kind.js";
import { applyActorAttributeDamage } from "../scripts/conditions/services/condition-writes.js";
import { getReputationEntries, normalizeReputationEntries, selectRandomReputation, saveReputationEntries } from "../scripts/reputation.js";
import { initializeWalletOperations } from "../scripts/wallet.js";
import { writeCurrencyUpdate } from "../scripts/currency.js";
import { executeAsActiveGM, registerIntegrationSocket } from "../scripts/integration/socket-api.js";
import { registerNewDayProvider, initializeNewDayProviderBridge } from "../scripts/integration/new-day-providers.js";
import { enqueueActorMutation, enqueueCurrencyOperation } from "../scripts/operation-queue.js";
import { scheduleStatSync, cleanupStatSync } from "../scripts/conditions/stat-sync.js";
import { refreshConditionsRows } from "../scripts/conditions/render/refresh-rows.js";
import { getCurrentQuarterInfo } from "../scripts/rest.js";
import { performEquipmentAction } from "../scripts/integration/equipment-api.js";

const scope = "fbl-quick-access";
// Several cases deliberately simulate failed writes/notifications. Keep their
// expected diagnostics from flooding TAP with data-URL module stack traces.
const originalError = console.error;
console.error = () => {};
after(() => { console.error = originalError; });
let nextId = 0;
const get = (value, key) => key.split(".").reduce((object, part) => object?.[part], value);
const set = (value, key, entry) => {
  const parts = key.split("."); const leaf = parts.pop();
  const parent = parts.reduce((object, part) => object[part] ??= {}, value);
  if (leaf.startsWith("-=")) delete parent[leaf.slice(2)]; else parent[leaf] = structuredClone(entry);
};
function reset() {
  globalThis.foundry = { utils: { getProperty: get, deepClone: structuredClone,
    randomID: () => `audit${String(++nextId).padStart(20, "0")}`,
    mergeObject: (base, patch) => ({ ...base, ...patch }) } };
  globalThis.Hooks = { on() {}, callAll() {} };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} }, windows: {} };
  globalThis.game = { user: user("gm", true), users: [], actors: new Map(), items: [], packs: [],
    modules: new Map([["calendaria", { active: true }]]), time: { worldTime: 0 },
    settings: { get: (_scope, key) => key === "stateProgressionMode" ? "calendaria" : key.startsWith("feature") || key === "chatMessages" || key === "playersCanEdit" },
    i18n: { localize: key => key, format: key => key }, socket: { on() {}, emit() {} } };
  game.users = [game.user]; game.users.get = id => game.users.find(entry => entry.id === id);
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => null };
  globalThis.CALENDARIA = { api: { getCurrentDateTime: () => ({ year: 1, month: 1, day: 3, hour: 0 }),
    getActiveCalendar: () => ({ id: "audit", days: { hoursPerDay: 24 } }),
    daysBetween: (from, to) => to.day - from.day, addDays: (from, days) => ({ ...from, day: from.day + days }) } };
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.HTMLElement = class {};
  globalThis.fromUuid = async uuid => [...game.actors.values()].find(actor => actor.uuid === uuid) ?? null;
  delete globalThis.document;
}
function user(id, isGM = false) {
  const result = { id, name: id, isGM, active: true, flags: {}, getFlag: (module, key) => get(result.flags[module], key),
    setFlag: async (module, key, value) => set(result.flags, `${module}.${key}`, value),
    unsetFlag: async (module, key) => set(result.flags, `${module}.${key}`, null) };
  return result;
}
function item(id, system = {}, name = "Wound") {
  const result = { id, name, type: "criticalInjury", flags: {}, system, updates: [],
    getFlag: (module, key) => get(result.flags[module], key),
    update: async data => {
      result.updates.push(structuredClone(data));
      applyDocumentUpdate(result, data);
    },
    toObject: () => ({ name: result.name, type: result.type, system: structuredClone(result.system), flags: structuredClone(result.flags) }) };
  return result;
}
class ActorStub {
  static async updateDocuments(updates) { for (const update of updates) await game.actors.get(update._id).update(update); }
}
function actor(items = []) {
  items.get = id => items.find(entry => entry.id === id);
  const result = Object.assign(new ActorStub(), { id: `actor${++nextId}`, name: "Audit", type: "character", documentName: "Actor", isOwner: true,
    flags: {}, items, effects: [], updates: [],
    system: { attribute: Object.fromEntries(["strength", "agility", "wits", "empathy"].map(key => [key, { value: 1, max: 6 }])), condition: {}, bio: {},
      currency: { gold: { value: 0 }, silver: { value: 0 }, copper: { value: 0 } } },
    getFlag: (module, key) => get(result.flags[module], key),
    setFlag: async (module, key, value) => set(result.flags, `${module}.${key}`, value),
    testUserPermission: () => true,
    update: async data => {
      result.updates.push(structuredClone(data));
      applyDocumentUpdate(result, data);
    },
    updateEmbeddedDocuments: async (_type, updates) => { for (const update of updates) await items.get(update._id).update(update); },
    deleteEmbeddedDocuments: async (_type, ids) => { for (const id of ids) { const index = items.findIndex(entry => entry.id === id); if (index >= 0) items.splice(index, 1); } },
    createEmbeddedDocuments: async (_type, sources) => sources.map(source => {
      const created = item(`created${++nextId}`, source.system, source.name); created.flags = source.flags ?? {}; items.push(created); return created;
    }) });
  result.uuid = `Actor.${result.id}`;
  game.actors.set(result.id, result);
  for (const entry of items) { entry.parent = result; entry.delete = async () => result.deleteEmbeddedDocuments("Item", [entry.id]); }
  return result;
}
const exposedModules = new Map();
async function expose(path, names) {
  const key = `${path}:${names}`;
  if (!exposedModules.has(key)) {
    const url = new URL(`../${path}`, import.meta.url);
    let source = await fs.readFile(url, "utf8");
    source = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
    source += `\nexport { ${names.join(", ")} };\n`;
    exposedModules.set(key, import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
  }
  return exposedModules.get(key);
}
reset();
const calendar = await expose("scripts/state-progression.js", [
  "processActorAutomaticDays", "handleCalendariaApplyRequest", "sendPlayerResult",
  "handlePlayerResultMessage", "buildPlayerResultContent", "prepareGMSummary", "applyAutomaticDaysFromSummary"
]);
const rest = await expose("scripts/rest.js", ["applyRest"]);
const money = await expose("scripts/money-transfer.js", ["gmOffers", "processTransferDecision"]);
const start = { year: 1, month: 1, day: 1 };
const context = { calendarId: "audit", date: { ...start, day: 3 } };

async function assignForCalendar(actor, date = context.date) {
  const player = user(`player-${actor.id}`);
  player.character = actor;
  game.users.push(player);
  CALENDARIA.api.getCurrentDateTime = () => date;
  await actor.setFlag(scope, "stateProgressionCalendaria", { calendarId: context.calendarId, date: start });
  return player;
}

test("Rest and manual New Day send player writes to the active GM and share its Actor queue", { timeout: 2_000 }, async () => {
  reset();
  const wound = item("wound", { healingTime: "3 days" });
  const a = actor([wound]);
  const gm = game.user;
  const owner = user("owner");
  game.users.push(owner);
  game.user = owner;
  rest.initializeRestOperations();
  initializeNewDayOperations();
  let receive;
  const packets = [];
  game.socket = { on(_channel, listener) { receive = listener; }, emit(_channel, packet, options) { packets.push({ packet, options }); } };
  registerIntegrationSocket();
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await delay(2);
    assert.ok(predicate(), "Expected both socket packets");
  };

  const restResult = rest.applyRest(null, a, { type: "short", useShortRecovery: true, shortAttribute: "strength", shortConsumable: "food" });
  const plan = buildNewDayPlan(a);
  const dayResult = applyNewDayPlan(a, plan, ["injury:wound:healing"], { postChat: false });
  await waitFor(() => packets.length === 2);
  assert.deepEqual(packets.map(({ packet }) => packet.operation).sort(), ["new-day.apply", "rest.apply"]);
  assert.ok(packets.every(({ packet, options }) => packet.activeGMId === gm.id && options.recipients[0] === gm.id));
  assert.deepEqual(owner.flags, {}, "addressed requests do not store payloads on User flags");
  assert.equal(wound.system.healingTime, "3 days");
  assert.equal(a.system.attribute.strength.value, 1);

  game.user = gm;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const queued = enqueueActorMutation(a, () => barrier);
  const requests = packets.splice(0);
  for (const { packet } of requests) receive(packet, gm.id);
  await delay(5);
  assert.deepEqual(packets, [], "a claimed requester must match the server sender");
  for (const { packet } of requests) receive(packet, owner.id);
  await delay(5);
  assert.equal(wound.system.healingTime, "3 days");
  assert.equal(a.system.attribute.strength.value, 1);
  release();
  await queued;
  await waitFor(() => packets.length === 2);
  assert.ok(packets.every(({ options }) => options.recipients.length === 1 && options.recipients[0] === owner.id));
  assert.deepEqual(gm.flags, {}, "addressed responses do not store results on User flags");
  game.user = owner;
  for (const { packet } of packets) receive({ ...packet, result: { forged: true } }, owner.id);
  for (const { packet } of packets) receive(packet, gm.id);
  assert.equal((await restResult).changed, true);
  assert.equal((await dayResult).changed, true);
  assert.equal(a.system.attribute.strength.value, 2);
  assert.equal(wound.system.healingTime, "2 days");
});

test("a dropped connection after sending a Rest request reports an unknown outcome immediately", { timeout: 1_000 }, async () => {
  reset();
  const a = actor();
  const owner = user("owner");
  game.users.push(owner);
  game.user = owner;
  const socketListeners = new Map();
  const sent = [];
  game.socket = { connected: true, on(event, fn) { socketListeners.set(event, fn); },
    off(event, fn) { if (socketListeners.get(event) === fn) socketListeners.delete(event); },
    emit(_channel, packet) { sent.push(packet); } };
  const warnings = [];
  ui.notifications.warn = message => warnings.push(message);
  const restResult = rest.applyRest(null, a, { type: "long" });
  assert.equal(sent.length, 1);
  game.socket.connected = false;
  socketListeners.get("disconnect")();
  const result = await restResult;
  assert.equal(result.outcomeUnknown, true);
  assert.match(warnings[0], /outcome.*unknown.*Check the sheet/);
  assert.equal(socketListeners.has("disconnect"), false);
});

test("A01: overlapping calendar requests read the live marker inside the queue", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  await assignForCalendar(a);
  const results = await Promise.all([calendar.processActorAutomaticDays(a.id, context, 2), calendar.processActorAutomaticDays(a.id, context, 2)]);
  assert.equal(a.items[0].system.healingTime, "8 days");
  assert.equal(results.reduce((sum, result) => sum + result.processedDays, 0), 2);
});
test("A01: a superseded calendar target stops before processing", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  const target = { ...context, date: { ...start, day: 4 } };
  await assignForCalendar(a, target.date);
  await assert.rejects(calendar.processActorAutomaticDays(a.id, context, 2), { code: "stale-calendar-day" });
  assert.equal(a.items[0].system.healingTime, "10 days");
  await calendar.processActorAutomaticDays(a.id, target, 3);
  assert.equal(a.items[0].system.healingTime, "7 days");
});

test("Calendaria sends results only to assigned players and verifies the server sender", async () => {
  reset();
  const a = actor();
  const player = await assignForCalendar(a);
  const gm = game.user;
  const sent = [];
  game.socket.emit = (_channel, message, options) => sent.push({ message, options });
  const result = { days: [{ date: context.date, result: { entries: [{ itemName: "Private injury" }] } }] };
  await calendar.sendPlayerResult(user("other"), a, context, result);
  assert.equal(sent.length, 0);
  await calendar.sendPlayerResult(player, a, context, result);
  assert.deepEqual(sent.map(({ options }) => options.recipients), [[player.id]]);
  assert.deepEqual(gm.flags, {});
  const notices = [];
  ui.notifications.info = message => notices.push(message);
  game.user = player;
  await calendar.handlePlayerResultMessage(sent[0].message, player.id);
  assert.deepEqual(notices, []);
  await calendar.handlePlayerResultMessage(sent[0].message, gm.id);
  await calendar.handlePlayerResultMessage(sent[0].message, gm.id);
  assert.equal(notices.length, 1);
});
for (const [initial, replacement, expectedLength] of [["2 days", "10 days", 1], ["1 day", "20 days", 1]]) {
  test(`A02: stale ${initial} preview neither overwrites nor deletes a changed injury`, async () => {
    reset(); const wound = item("wound", { healingTime: initial }); const a = actor([wound]); const plan = buildNewDayPlan(a);
    wound.system.healingTime = replacement;
    const result = await applyNewDayPlan(a, plan, plan.actions.map(action => action.id), { postChat: false });
    assert.equal(a.items.length, expectedLength); assert.equal(wound.system.healingTime, replacement); assert.equal(result.failed.length, 1);
  });
}
test("A02: stale custom timer preview preserves a newer timer", async () => {
  reset(); const a = actor(); await a.setFlag(scope, "conditions.list", [{ id: "c", name: "Effect", time: "2 days" }]);
  const plan = buildNewDayPlan(a); await a.setFlag(scope, "conditions.list", [{ id: "c", name: "Effect", time: "9 days" }]);
  const result = await applyNewDayPlan(a, plan, plan.actions.map(action => action.id), { postChat: false });
  assert.equal(a.getFlag(scope, "conditions.list")[0].time, "9 days"); assert.equal(result.failed.length, 1);
});

test("New Day detects a changed stored injury timer even when its prepared data is stale", async () => {
  reset();
  const wound = item("source", { healingTime: "2 days" });
  wound._source = { system: { healingTime: "2 days" } };
  const a = actor([wound]);
  const plan = buildNewDayPlan(a);
  wound._source.system.healingTime = "10 days";
  const result = await applyNewDayPlan(a, plan, ["injury:source:healing"], { postChat: false });
  assert.equal(result.failed[0].code, "stale-plan");
  assert.equal(wound._source.system.healingTime, "10 days");
  assert.deepEqual(wound.updates, []);
});
test("A03: reset then recover records the newly consumed quarter", async () => {
  reset(); const a = actor();
  await rest.applyRest(null, a, { type: "short", resetShortQuarter: true, useShortRecovery: true, shortAttribute: "strength", shortConsumable: "food" }, { allowResetShortQuarter: true });
  assert.ok(a.getFlag(scope, "shortRestRecovery"));
  const second = await rest.applyRest(null, a, { type: "short", useShortRecovery: true, shortAttribute: "agility" });
  assert.ok(second.errors.length); assert.equal(a.system.attribute.agility.value, 1);
});
test("A05: failed chat is a notification error after a successful rest", async () => {
  reset(); const a = actor(); ChatMessage.create = async () => { throw new Error("offline chat"); };
  const result = await rest.applyRest(null, a, { type: "long" });
  assert.notEqual(result.failed, true); assert.equal(result.notificationError, "offline chat"); assert.equal(a.system.attribute.strength.value, 2);
});

test("parallel Short Rests can recover only once in a single quarter", async () => {
  reset();
  const a = actor();
  const options = { type: "short", useShortRecovery: true, shortConsumable: "food" };
  const results = await Promise.all(["strength", "agility"].map(shortAttribute => rest.applyRest(null, a, { ...options, shortAttribute })));
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal(results.filter(result => result.errors.length).length, 1);
  assert.equal(a.updates.length, 1);
});

test("Short Rest honors a saved Calendaria quarter key from before calendar IDs were included", async () => {
  reset();
  const a = actor();
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "calendaria:1:1:3:q0" });
  const result = await rest.applyRest(null, a, { type: "short", useShortRecovery: true, shortAttribute: "strength" });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(a.updates, []);
});

test("Short Rest stops on an active Calendaria error without falling back to world time", async () => {
  reset();
  const a = actor();
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "calendaria:audit:1:1:3:q0" });
  CALENDARIA.api.getActiveCalendar = () => { throw new Error("calendar broken"); };
  const result = await rest.applyRest(null, a, { type: "short", useShortRecovery: true, shortAttribute: "strength" });
  assert.equal(result.failed, true);
  assert.equal(result.changed, false);
  assert.match(result.error, /Calendaria could not determine the current quarter day/i);
  assert.deepEqual(a.updates, []);

  delete globalThis.CALENDARIA;
  game.modules.set("calendaria", { active: false });
  assert.equal(getCurrentQuarterInfo().source, "foundry");
});

test("Long Rest reads active effects, ignores disabled ones and removes active conditions in one batch", async () => {
  reset();
  const a = actor();
  a.system.condition = { sleepy: { value: false }, cold: { value: false }, thirsty: { value: false } };
  a.effects = [
    { id: "sleepy", statuses: ["sleepy"] }, { id: "cold", statuses: ["cold"] },
    { id: "inactive", statuses: ["thirsty"], disabled: true }
  ];
  const deletions = [];
  a.deleteEmbeddedDocuments = async (type, ids) => {
    deletions.push([type, ids]);
    a.effects = a.effects.filter(effect => !ids.includes(effect.id));
  };
  const result = await rest.applyRest(null, a, { type: "long", hasHeatSource: true });
  assert.deepEqual(result.recovered, ["agility", "empathy"]);
  assert.deepEqual(deletions, [["ActiveEffect", ["sleepy", "cold"]]]);
  assert.deepEqual(a.effects.map(effect => effect.id), ["inactive"]);
});

test("Long Rest reports only conditions removed after Actor and Item effects are applied", async () => {
  reset();
  const cloak = item("cloak", {}, "Cloak");
  const a = actor([cloak]);
  const transferred = { id: "item-sleepy", parent: cloak, transfer: true, statuses: new Set(["sleepy"]) };
  cloak.effects = [transferred];
  a.effects = [
    { id: "actor-sleepy", parent: a, statuses: new Set(["sleepy"]) },
    { id: "actor-cold", parent: a, statuses: new Set(["cold"]) }
  ];
  Object.defineProperty(a, "appliedEffects", {
    get: () => [...a.effects, ...cloak.effects.filter(effect => effect.transfer)]
  });
  a.system.condition = { sleepy: { value: true }, cold: { value: true } };
  const deletions = [];
  a.deleteEmbeddedDocuments = async (type, ids) => {
    deletions.push([type, ids]);
    a.effects = a.effects.filter(effect => !ids.includes(effect.id));
  };

  const result = await rest.applyRest(null, a, { type: "long", hasHeatSource: true });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.clearedConditions, ["cold"]);
  assert.match(result.notification, /\bCold\b/);
  assert.doesNotMatch(result.notification, /\bSleepy\b/);
  assert.deepEqual(deletions, [["ActiveEffect", ["actor-sleepy", "actor-cold"]]]);
  assert.deepEqual(a.appliedEffects, [transferred]);
  assert.deepEqual(cloak.effects, [transferred]);
});

for (const timeout of [false, true]) test(`Long Rest reports ${timeout ? "an unknown outcome" : "a partial application"} when effect removal fails`, async () => {
  reset();
  const a = actor();
  a.effects = [{ id: "sleepy", statuses: ["sleepy"] }];
  const messages = [];
  const notices = [];
  ChatMessage.create = async message => messages.push(message);
  ui.notifications.warn = ui.notifications.error = message => notices.push(message);
  a.deleteEmbeddedDocuments = async () => {
    if (timeout) throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" });
    return [];
  };
  const result = await rest.applyRest(null, a, { type: "long" });
  assert.equal(result.failed, true);
  assert.equal(result.partiallyApplied, true);
  assert.equal(result.outcomeUnknown, timeout);
  assert.equal(a.effects.length, 1);
  assert.equal(a.system.attribute.strength.value, 2);
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /Audit.*ActiveEffect removal/);
  assert.match(notices[0], timeout ? /outcome .* unknown/ : /partially applied/);
});

test("Long Rest skips ActiveEffect deletion when its Actor update was vetoed", async () => {
  reset();
  const a = actor();
  a.effects = [{ id: "sleepy", statuses: ["sleepy"] }];
  a.update = async () => {};
  a.deleteEmbeddedDocuments = async () => assert.fail("An unverified Actor update must stop Rest");
  const result = await rest.applyRest(null, a, { type: "long" });
  assert.equal(result.failed, true);
  assert.equal(result.partiallyApplied, false);
  assert.equal(a.effects.length, 1);
});
test("BIO close flush saves captured patches without waiting for debounce", async () => {
  reset(); const a = actor(); const state = getBiographyProfile(a); state.physical.appearance = "New appearance";
  queueProfileSave(a, state, null, 350, "physical.appearance"); await flushBiographySaves(a);
  assert.equal(a.getFlag(scope, "biographyProfile").physical.appearance, "New appearance");
});
test("A04 correction: deleting an Actor discards pending edits and never tries to flush them", async () => {
  reset(); const a = actor(); const state = getBiographyProfile(a); state.physical.appearance = "Deleted draft";
  queueProfileSave(a, state, null, 20, "physical.appearance"); releaseBiographyState(a); await delay(30);
  assert.equal(a.updates.length, 0);
});
test("A11: independent sheets' captured patches preserve both fields", async () => {
  reset(); const a = actor(); const first = getBiographyProfile(a); const second = getBiographyProfile(a);
  first.physical.appearance = "First edit"; second.physical.hair = "Second edit";
  queueProfileSave(a, first, null, 350, "physical.appearance"); queueProfileSave(a, second, null, 350, "physical.hair");
  await flushBiographySaves(a); const saved = a.getFlag(scope, "biographyProfile");
  assert.equal(saved.physical.appearance, "First edit"); assert.equal(saved.physical.hair, "Second edit");
});
test("A11: unrelated BIO edits preserve newer native notes and explicit empty pride", async () => {
  reset(); const a = actor(); a.system.bio.note = { value: "Old note" }; a.system.bio.pride = { value: "" };
  await a.setFlag(scope, "biographyProfile", { publicNote: "Old note", pride: "Old pride" });
  const stale = getBiographyProfile(a); stale.physical.appearance = "New look"; a.system.bio.note.value = "External edit";
  queueProfileSave(a, stale, null, 350, "physical.appearance"); await flushBiographySaves(a);
  assert.equal(a.system.bio.note.value, "External edit"); assert.equal(getBiographyProfile(a).publicNote, "External edit"); assert.equal(getBiographyProfile(a).pride, "");
});
test("A10: observer preview fails closed on secret HTML even without a DOM", () => {
  reset(); const secret = '<section class="secret"><p>Hidden</p></section>';
  assert.equal(biographyDisplayHtml(secret, { isOwner: false }), ""); assert.match(biographyDisplayHtml(secret, { isOwner: true }), /Hidden/);
});
test("Heat stops before writing the counter when damage is vetoed", async () => {
  reset(); const h = item("heat", { healingTime: "" }, "Heat"); const a = actor([h]); a.system.attribute.strength.value = 5;
  set(h.flags, `${scope}.conditions.heatValue`, 2); a.update = async () => undefined;
  await assert.rejects(updateHeatItem(a, h, 3, "failure"), /Condition write was not persisted.*strength/);
  assert.equal(parseHeatValue(h), 2); assert.equal(a.system.attribute.strength.value, 5);
  assert.equal(h.updates.length, 0);
});
test("Heat reports confirmed damage when the counter write fails", async () => {
  reset(); const h = item("heat", { healingTime: "" }, "Heat"); const a = actor([h]); a.system.attribute.strength.value = 5;
  set(h.flags, `${scope}.conditions.heatValue`, 2);
  const messages = [];
  h.update = async () => { throw new Error("finalize failure"); };
  ChatMessage.create = async message => { messages.push(message); };
  await assert.rejects(updateHeatItem(a, h, 3, "failure"), { code: "condition-partial-failure" });
  assert.equal(a.system.attribute.strength.value, 4); assert.equal(parseHeatValue(h), 2);
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
});

test("Active Effect overrides on Strength and copper do not hide successful writes", async () => {
  reset();
  const a = actor();
  a.system.attribute.strength.value = 5;
  a.system.currency.copper.value = 10;
  // Prepared values stay overridden while the document update changes its source.
  a._source = { system: structuredClone(a.system) };

  const damage = await applyActorAttributeDamage(a, { strength: 1 }, {});
  await writeCurrencyUpdate(a, { "system.currency.copper.value": 9 });

  assert.equal(damage[0].value, 4);
  assert.equal(a._source.system.attribute.strength.value, 4);
  assert.equal(a._source.system.currency.copper.value, 9);
  assert.equal(a.system.attribute.strength.value, 5);
  assert.equal(a.system.currency.copper.value, 10);
});

for (const partial of [false, true]) {
  test(`currency distinguishes a ${partial ? "partial write" : "veto"} using stored balances`, async () => {
    reset();
    const a = actor();
    a._source = { system: structuredClone(a.system) };
    a._source.system.currency.copper.value = 10;
    a.system.currency.copper.value = 50;
    const copper = "system.currency.copper.value";
    const silver = "system.currency.silver.value";
    a.update = async data => {
      if (partial) applyDocumentUpdate(a, { [copper]: data[copper] });
    };

    await assert.rejects(writeCurrencyUpdate(a, { [copper]: 9, [silver]: 1 }), {
      code: partial ? "outcome-unknown" : "write-not-persisted"
    });
    assert.equal(a._source.system.currency.copper.value, partial ? 9 : 10);
    assert.equal(a._source.system.currency.silver.value, 0);
  });
}
test("A06: Addiction phase and modifiers are one Item update", async () => {
  reset(); const dependency = item("dependency", { rollModifiers: {} }, "Addiction"); actor([dependency]);
  await saveAddictionState(dependency, { phase: "down", die: 8, daysLeft: 0, severity: 5 });
  assert.equal(dependency.updates.length, 1); assert.equal(dependency.getFlag(scope, "conditions.addictionState").die, 8);
  assert.equal(dependency.system.rollModifiers.fblecAddictionStrength.value, "-1");
});
test("A06: retrying Wash cleanup reuses the created target", async () => {
  reset(); const old = item("old", { healingTime: "1 day" }, "Помытый"); const a = actor([old]); const source = item("source", { healingTime: "3 days" }, "Немытый"); game.items.push(source);
  const remove = a.deleteEmbeddedDocuments; a.deleteEmbeddedDocuments = async () => { throw new Error("cleanup failure"); };
  assert.equal((await transitionWashLevel(a, "Помытый")).reason, "cleanup-failed"); assert.equal(a.items.length, 2);
  a.deleteEmbeddedDocuments = remove; assert.equal((await transitionWashLevel(a, "Помытый")).changed, true);
  assert.equal(a.items.length, 1); assert.equal(getWashStage(a.items[0]), "Немытый");
});
test("A07: failed provider build leaves the date pending and whispers to the GM", async () => {
  reset(); initializeNewDayProviderBridge(); const a = actor(); await assignForCalendar(a);
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const unregister = registerNewDayProvider({ id: "audit.fail", category: "audit", buildActions: async () => { throw new Error("offline provider"); }, applyAction: async () => ({}), describeAction: () => "", icon: () => "fa-check" });
  try { const result = await calendar.processActorAutomaticDays(a.id, context, 2); assert.equal(result.processedDays, 0); assert.equal(result.failedActions, 1);
    assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 1);
    assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
    assert.match(messages[0].content, /audit.fail/);
    assert.equal(a.getFlag(scope, "stateProgressionFailures"), undefined); }
  finally { unregister(); }
});
test("A12: duration parser refuses formulas and non-day/free-text inputs", () => {
  for (const value of ["2 hours", "2 часа", "1-3 days", "d6", "1.5 days", "Due 2026-10-09", "Permanent"]) assert.equal(decrementFirstInteger(value), null, value);
  assert.equal(decrementFirstInteger("2 дня").afterText, "1 день"); assert.equal(decrementFirstInteger("12 дней").afterText, "11 дней");
});
test("A13: persisted kind survives renaming and disabled feature is not a normal injury", () => {
  reset(); const h = item("h", { healingTime: "1 day" }, "Renamed condition"); set(h.flags, `${scope}.conditions.kind`, "heat"); const a = actor([h]);
  game.settings.get = () => false; assert.equal(getConditionKind(h), "heat"); assert.equal(buildNewDayPlan(a).actions.some(action => action.itemId === h.id), false);
});
test("A14: invalid reputation never reaches an unbounded selection loop", async () => {
  reset(); const a = actor(); const invalid = [{ amount: "1e309", description: "Malformed import" }];
  assert.deepEqual(normalizeReputationEntries(invalid), []); assert.deepEqual(selectRandomReputation(invalid, 2), []);
  await assert.rejects(saveReputationEntries(a, invalid), RangeError); assert.equal(a.updates.length, 0);
  assert.throws(() => selectRandomReputation([{ amount: 1000 }, { amount: 1000 }], 2), RangeError);
});
function acceptTransfer(source, target, copper) {
  const sender = user("sender");
  const recipient = user("recipient");
  game.users.push(sender, recipient);
  const offer = { requestId: `audit-transfer-${++nextId}`, requesterId: sender.id, recipientUserId: recipient.id,
    primaryGmId: game.user.id, sourceActorId: source.id, targetActorId: target.id, amounts: { copper }, createdAt: Date.now() };
  const results = [];
  game.socket.emit = (_channel, message) => results.push(message.result);
  money.gmOffers.set(offer.requestId, { offer });
  return { completion: money.processTransferDecision(offer, { ...offer, accepted: true }), results };
}

for (const [side, delta, before, amount, error] of [
  ["sender", -10, 100, 95, "insufficient-denomination"],
  ["recipient", 1, Number.MAX_SAFE_INTEGER - 1, 1, "amount-overflow"]
]) {
  test(`wallet and transfer share the authority queue and recheck the ${side}'s balance`, async () => {
    reset(); initializeWalletOperations();
    const source = actor(), target = actor();
    source.system.currency.copper.value = 100;
    const wallet = side === "sender" ? source : target;
    wallet.system.currency.copper.value = before;
    let start, release;
    const started = new Promise(resolve => { start = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const update = wallet.update;
    wallet.update = async patch => { start(); await blocked; return update(patch); };
    const edit = executeAsActiveGM("wallet.apply-change", { actorUuid: wallet.uuid, mode: "delta", key: "copper", value: delta });
    await started;
    const { completion, results } = acceptTransfer(source, target, amount);
    await delay(0);
    release();
    await Promise.all([edit, completion]);
    assert.equal(wallet.system.currency.copper.value, before + delta);
    assert.equal(results[0]?.error, error);
    assert.equal(source.updates.length + target.updates.length, 1);
  });
}
test("A08: wallet input bounds and insufficient funds reject before a write", async () => {
  reset(); initializeWalletOperations(); const a = actor();
  await assert.rejects(executeAsActiveGM("wallet.apply-change", { actorUuid: a.uuid, mode: "delta", key: "copper", value: -1 }));
  await assert.rejects(executeAsActiveGM("wallet.apply-change", { actorUuid: a.uuid, mode: "delta", key: "copper", value: Infinity }));
  assert.equal(a.updates.length, 0);
});
for (const [change, expected] of [["sender", "source-permission"], ["recipient", "invalid-recipient"],
  ["deadline", "recipient-timeout"], ["active GM", "no-gm"]]) {
  test(`transfer rechecks ${change} after waiting on the currency queue`, async () => {
    reset(); const source = actor(); const target = actor(); source.system.currency.copper.value = 100;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const blocker = enqueueCurrencyOperation(() => blocked);
    const { completion, results } = acceptTransfer(source, target, 20);
    if (change === "sender") source.testUserPermission = () => false;
    if (change === "recipient") target.testUserPermission = () => false;
    if (change === "deadline") game.time.serverTime = Date.now() + 90_000;
    if (change === "active GM") game.users.push(user("another-gm", true));
    release();
    await Promise.all([blocker, completion]);
    assert.equal(results[0]?.error, expected);
    assert.equal(source.updates.length + target.updates.length, 0);
  });
}

for (const [failure, expected] of [["debit veto", "update-failed"], ["credit failure", "partial-failure"], ["credit timeout", "outcome-unknown"]]) {
  test(`transfer stops on ${failure} and reports completed steps to the GM`, async () => {
    reset();
    const source = actor(), target = actor();
    source.name = "Sender <one>";
    target.name = "Recipient <two>";
    source.system.currency.copper.value = 100;
    const whispers = [], events = [], notices = [];
    ui.notifications.warn = ui.notifications.error = message => notices.push(message);
    let noticeBeforeWhisper;
    ChatMessage.create = async message => {
      noticeBeforeWhisper = notices[0];
      whispers.push(message);
      if (failure === "credit timeout") throw new Error("Chat unavailable");
    };
    Hooks.callAll = event => events.push(event);
    if (failure === "debit veto") source.update = async () => undefined;
    let credits = 0;
    target.update = async () => {
      credits += 1;
      throw Object.assign(new Error("Credit failed"), { code: failure === "credit timeout" ? "ETIMEDOUT" : "validation" });
    };
    const { completion, results } = acceptTransfer(source, target, 20);
    await completion;
    assert.equal(results[0]?.error, expected);
    assert.equal(target.system.currency.copper.value, 0);
    assert.deepEqual(events, []);
    if (failure === "debit veto") {
      assert.equal(credits, 0);
      assert.equal(source.system.currency.copper.value, 100);
    } else {
      assert.equal(credits, 1);
      assert.equal(source.system.currency.copper.value, 80);
      assert.equal(source.updates.length, 1);
      assert.deepEqual(whispers.map(message => message.whisper), [[game.user.id]]);
      assert.match(whispers[0].content, /Sender &lt;one&gt;.*Recipient &lt;two&gt;.*20 CP.*Списание.*подтверждено/s);
      assert.match(noticeBeforeWhisper, /Sender &lt;one&gt;.*Recipient &lt;two&gt;.*20 CP.*Списание.*подтверждено/i);
    }
  });
}
test("losing the socket during credit stops the transfer and releases the queue with a warning", async () => {
  reset();
  const source = actor(), target = actor();
  source.name = "Sender";
  target.name = "Recipient";
  source.system.currency.copper.value = 100;
  const disconnect = new Set(), warnings = [];
  game.socket.connected = true;
  game.socket.on = (event, handler) => { if (event === "disconnect") disconnect.add(handler); };
  game.socket.off = (_event, handler) => disconnect.delete(handler);
  ui.notifications.warn = message => warnings.push(message);
  let start;
  const started = new Promise(resolve => { start = resolve; });
  target.update = () => { start(); return new Promise(() => {}); };
  const { completion, results } = acceptTransfer(source, target, 20);
  await started;
  game.socket.connected = false;
  for (const handle of disconnect) handle();
  await completion;
  assert.deepEqual(results, []);
  assert.equal(disconnect.size, 0);
  assert.equal(source.system.currency.copper.value, 80);
  assert.match(warnings[0], /Sender.*Recipient.*20 CP.*исход зачисления неизвестен.*90 секунд.*сверьте оба кошелька/i);
  assert.equal(await enqueueCurrencyOperation(() => "ready"), "ready");
});
test("BIO failed save keeps its captured draft for an explicit retry", async () => {
  reset(); const a = actor(); const state = getBiographyProfile(a); state.concept = "Keep this draft";
  const originalUpdate = a.update; a.update = async () => { throw new Error("Write unavailable"); };
  queueProfileSave(a, state, null, 10_000, "concept"); await flushBiographySaves(a);
  a.update = originalUpdate; await flushBiographySaves(a);
  assert.equal(getBiographyProfile(a).concept, "Keep this draft");
});
test("New Day chat failure does not change the result of committed timer updates", async () => {
  reset(); const wound = item("w", { healingTime: "3 days" }); const a = actor([wound]);
  ChatMessage.create = async () => { throw new Error("Chat unavailable"); };
  const plan = buildNewDayPlan(a); const result = await applyNewDayPlan(a, plan, plan.actions.map(entry => entry.id), { postChat: true });
  assert.equal(wound.system.healingTime, "2 days"); assert.equal(result.failed.length, 0); assert.ok(result.notificationError);
});
test("A16: a remote STAT refresh preserves an active edit until blur", async () => {
  reset(); const a = actor(); let blur;
  const input = { matches: () => true, addEventListener: (_event, listener) => { blur = listener; }, removeEventListener() {} };
  globalThis.document = { activeElement: input };
  const root = { querySelector: () => ({}), contains: value => value === input, isConnected: true };
  const app = { actor: a, element: root, rendered: true }; a.apps = { app }; let renders = 0;
  scheduleStatSync(a, { render: false }, "other", async () => { renders += 1; }); await delay(5); assert.equal(renders, 0);
  document.activeElement = null; blur(); await delay(5); assert.equal(renders, 1);
});
test("A15: remote second-GM action returns no private summary and cannot suppress its GM whisper", async () => {
  reset(); const a = actor(); const second = user("gm2", true); game.users.push(second); const messages = []; ChatMessage.create = async data => { messages.push(data); };
  const providerModule = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const action = { id: "today", caseId: "public-case" };
  const unregister = providerModule.registerNewDayProvider({ id: "audit.private", category: "audit", buildActions: async () => [action], applyAction: async () => ({ changed: true, summary: "Public result", privateSummary: "Secret diagnosis" }), describeAction: () => "", icon: () => "fa-check" });
  try { const result = await providerModule.handleApplyProviderAction({ actorUuid: a.uuid, providerId: "audit.private", action, suppressChat: true }, { requestUser: second, requesterId: second.id, activeGM: game.user, isRemote: true });
    assert.equal(result.privateSummary, undefined); assert.ok(messages.some(message => message.content.includes("Secret diagnosis") && message.whisper.includes("gm2"))); }
  finally { unregister(); }
});
test("provider apply rejects a stale/tampered action before invoking privileged code", async () => {
  reset(); const a = actor(); const providerModule = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]); let applications = 0;
  const unregister = providerModule.registerNewDayProvider({ id: "audit.stale", category: "audit", buildActions: async () => [{ id: "today", caseId: "allowed" }], applyAction: async () => { applications += 1; return {}; }, describeAction: () => "", icon: () => "fa-check" });
  try { await assert.rejects(providerModule.handleApplyProviderAction({ actorUuid: a.uuid, providerId: "audit.stale", action: { id: "today", caseId: "other" } }, { requestUser: game.user, activeGM: game.user, isRemote: false })); assert.equal(applications, 0); }
  finally { unregister(); }
});
test("provider action revalidation preserves the existing index fallback", async () => {
  reset(); const a = actor(); const providerModule = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const actions = [{ label: "First", value: 1 }, { label: "Second", value: 2 }]; let applied;
  const unregister = providerModule.registerNewDayProvider({ id: "audit.index", category: "audit", buildActions: async () => structuredClone(actions),
    applyAction: async (_actor, action) => { applied = action; return { changed: true }; }, describeAction: () => "", icon: () => "fa-check" });
  try { await providerModule.handleApplyProviderAction({ actorUuid: a.uuid, providerId: "audit.index", actionId: "1", action: actions[1] },
    { requestUser: game.user, activeGM: game.user, isRemote: false }); assert.deepEqual(applied, actions[1]); }
  finally { unregister(); }
});
test("Calendaria stops on an invalid addDays endpoint without clearing the Short Rest marker", async () => {
  reset(); const a = actor(); await assignForCalendar(a);
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "world:0" });
  const addDays = CALENDARIA.api.addDays;
  CALENDARIA.api.addDays = (date, count) => count === 2 ? { ...date, day: NaN } : addDays(date, count);
  await assert.rejects(calendar.processActorAutomaticDays(a.id, context, 2), { code: "invalid-calendar-date" });
  assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 1);
  assert.ok(a.getFlag(scope, "shortRestRecovery"));
  assert.deepEqual(a.updates, []);
});

test("Calendaria advances the Short Rest-only shortcut by its default and approved limits", async () => {
  reset();
  const a = actor();
  const target = { ...context, date: { ...start, day: 500 } };
  await assignForCalendar(a, target.date);
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "world:0" });
  const first = await calendar.processActorAutomaticDays(a.id, target, 499);
  assert.equal(first.processedDays, 90);
  assert.equal(first.limitedDays, 409);
  assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 91);
  assert.equal(a.getFlag(scope, "shortRestRecovery"), null);
  const next = await calendar.processActorAutomaticDays(a.id, target, 499, { maxDays: 499 });
  assert.equal(next.processedDays, 365);
  assert.equal(next.limitedDays, 44);
  assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 456);
});

for (const field of ["date", "calendarId"]) test(`Calendaria stops when the marker's ${field} fails verification`, async () => {
  reset();
  const wound = item("w", { healingTime: "4 days" }, "Broken arm");
  const a = actor([wound]);
  await assignForCalendar(a);
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const update = a.update;
  const markPath = `flags.${scope}.stateProgressionCalendaria`;
  a.update = async (data, options) => {
    if (data[markPath]) data[markPath][field] = field === "date" ? start : "other-calendar";
    await update(data, options);
  };
  const result = await calendar.processActorAutomaticDays(a.id, context, 2);
  assert.equal(result.processedDays, 0);
  assert.equal(result.failedDays, 1);
  assert.equal(result.limitedDays, 2);
  assert.equal(wound.system.healingTime, "3 days");
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /2\.1\.1 \(audit\).*Actual marker.*Broken arm/);
  assert.equal(a.getFlag(scope, "stateProgressionFailures"), undefined);
  await assert.rejects(calendar.processActorAutomaticDays(a.id, context, 2), { code: "calendar-needs-review" });
  assert.equal(wound.system.healingTime, "3 days");
});

for (const deleting of [false, true]) test(`New Day verifies the ${deleting ? "delete" : "update"} batch and halts on the omitted actions`, async () => {
  reset();
  const wounds = [item("first", { healingTime: deleting ? "1 day" : "3 days" }, "First wound"),
    item("omitted", { healingTime: deleting ? "1 day" : "4 days" }, "Omitted wound")];
  const a = actor([...wounds]);
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "world:0" });
  const update = a.updateEmbeddedDocuments;
  const remove = a.deleteEmbeddedDocuments;
  a.updateEmbeddedDocuments = async (type, batch) => update(type, batch.filter(document => document._id === "first"));
  a.deleteEmbeddedDocuments = async (type, batch) => remove(type, batch.filter(id => id === "first"));
  const plan = buildNewDayPlan(a);
  const result = await applyNewDayPlan(a, plan, plan.actions.map(action => action.id), { postChat: false });
  assert.equal(result.partiallyApplied, true);
  assert.deepEqual(result.succeeded.map(entry => entry.action.itemId), ["first"]);
  assert.deepEqual(result.failed.map(entry => entry.action.itemId), ["omitted"]);
  assert.equal(wounds[1].system.healingTime, deleting ? "1 day" : "4 days");
  assert.ok(a.getFlag(scope, "shortRestRecovery"), "the next stage must not write");
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /First wound.*Omitted wound/);
});

test("New Day reports a batch-level failure without duplicating already confirmed items", async () => {
  reset();
  const wounds = [item("first", { healingTime: "3 days" }, "First wound"), item("second", { healingTime: "4 days" }, "Second wound")];
  const a = actor([...wounds]);
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const update = a.updateEmbeddedDocuments;
  a.updateEmbeddedDocuments = async (type, batch) => {
    await update(type, batch);
    throw new Error("hook failed");
  };
  const plan = buildNewDayPlan(a);
  const result = await applyNewDayPlan(a, plan, plan.actions.map(action => action.id), { postChat: false });
  assert.equal(result.partiallyApplied, true);
  assert.deepEqual(result.succeeded.map(entry => entry.action.itemId), ["first", "second"]);
  assert.deepEqual(result.failed.map(entry => entry.action.id), ["item-update-batch"]);
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /Confirmed actions: First wound, Second wound.*Failed: Item update batch \(item-update-batch\): hook failed/);
});

test("player progression dialog distinguishes an unknown write outcome from a confirmed partial failure", () => {
  reset();
  const unknownHtml = calendar.buildPlayerResultContent({
    detail: "Some detail",
    days: [{ date: context.date, result: { outcomeUnknown: true, entries: [] } }]
  });
  const confirmedHtml = calendar.buildPlayerResultContent({
    detail: "Some detail",
    days: [{ date: context.date, result: { outcomeUnknown: false, partiallyApplied: true, entries: [] } }]
  });
  assert.match(unknownHtml, /outcome is unknown\. Check the sheet before trying again\./i);
  assert.doesNotMatch(confirmedHtml, /outcome is unknown/i);
});

test("an interactive Calendaria request must include fresh preview data for each selected action", async () => {
  reset();
  const wound = item("w", { healingTime: "4 days" });
  const a = actor([wound]);
  const date = { ...start, day: 2 };
  const player = await assignForCalendar(a, date);
  const plan = buildNewDayPlan(a, { dayKey: "calendar:audit:1:1:2" });
  const selection = getNewDaySelection(plan, ["injury:w:healing"]);
  const request = { ...selection, actorId: a.id, calendarId: "audit", targetDate: date };
  await assert.rejects(calendar.handleCalendariaApplyRequest({ ...request, selectedPreconditions: null }, { requestUser: player }), { code: "stale-plan" });
  wound.system.healingTime = "6 days";
  await assert.rejects(calendar.handleCalendariaApplyRequest(request, { requestUser: player }), { code: "stale-plan" });
  assert.equal(wound.system.healingTime, "6 days");
  assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 1);
});

test("interactive Calendaria apply preserves the player request context for providers and GM private summaries", async () => {
  reset();
  const wound = item("w", { healingTime: "4 days" });
  const a = actor([wound]);
  const date = { ...start, day: 2 };
  const player = await assignForCalendar(a, date);
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const applyContexts = [];
  const unregister = registerNewDayProvider({
    id: "audit.requester-context",
    category: "audit",
    buildActions: async (_actor, providerContext) => [{
      id: "ctx-action",
      label: `Action for ${providerContext.requestUser?.id}:${providerContext.isRemote}`
    }],
    applyAction: async (_actor, _action, providerContext) => {
      applyContexts.push({ userId: providerContext.requestUser?.id, isRemote: providerContext.isRemote, suppressChat: providerContext.suppressChat });
      return { changed: true, summary: "Public done", privateSummary: "Secret GM note" };
    },
    describeAction: action => action.label,
    icon: () => "fa-check"
  });
  try {
    const playerContext = { requestUser: player, requesterId: player.id, activeGM: game.user, isRemote: true };
    const plan = await buildNewDayPlanWithProviders(a, { dayKey: "calendar:audit:1:1:2", authority: playerContext });
    const selection = getNewDaySelection(plan, ["provider:audit.requester-context:ctx-action"]);
    const result = await calendar.handleCalendariaApplyRequest(
      { ...selection, actorId: a.id, calendarId: "audit", targetDate: date },
      playerContext
    );
    await delay(0);

    assert.equal(result.status, "processed");
    assert.deepEqual(applyContexts, [{ userId: player.id, isRemote: true, suppressChat: false }]);
    const entry = result.calendarResult.days[0].result.entries[0];
    assert.equal(entry.detail, "Public done");
    assert.equal(entry.privateSummary, undefined);
    assert.equal(messages.some(message => /Secret GM note/.test(message.content) && message.whisper.includes(game.user.id)), true);
  } finally {
    unregister();
  }
});

test("Calendaria finishes Wash, STAT timers, multiple Addictions and providers before pausing a later day", { timeout: 1_000 }, async () => {
  reset();
  const wash = item("wash", { healingTime: "1 day" }, "Помытый");
  const addictions = [item("a", {}, "Addiction A"), item("b", {}, "Addiction B")];
  const a = actor([wash, ...addictions]);
  await assignForCalendar(a);
  await a.setFlag(scope, "conditions.list", [{ id: "fever", name: "Fever", time: "3 days" }]);
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "world:0" });
  game.items.push(item("wash-source", { healingTime: "3 days" }, "Немытый"));
  const totals = [2, 4];
  globalThis.Roll = class { async evaluate() { this.total = totals.shift(); return this; } };
  const providerCalls = [];
  const unregister = registerNewDayProvider({
    id: "audit.queued", category: "audit", buildActions: async () => [{ id: "today", label: "Provider action" }],
    applyAction: async (actor, action, providerContext) => {
      providerCalls.push([actor.id, action.id, providerContext.suppressChat]);
      return { changed: true, summary: "Provider applied" };
    }, describeAction: () => "", icon: () => "fa-check"
  });
  try {
    const result = await calendar.processActorAutomaticDays(a.id, context, 2);
    assert.equal(result.processedDays, 1);
    assert.equal(result.pendingManual, 1);
    assert.equal(result.limitedDays, 1);
    assert.equal(result.failedActions, 0);
    assert.equal(a.items.some(entry => entry.id === wash.id), false);
    assert.ok(a.items.some(entry => getWashStage(entry) === "Немытый"));
    assert.equal(a.getFlag(scope, "conditions.list")[0].time, "2 days");
    assert.equal(a.getFlag(scope, "shortRestRecovery"), null);
    assert.deepEqual(addictions.map(entry => entry.getFlag(scope, "conditions.addictionMorning").dayKey),
      ["calendar:audit:1:1:2", "calendar:audit:1:1:2"]);
    assert.deepEqual(providerCalls, [[a.id, "today", true]]);
  } finally {
    unregister();
  }
});

test("an unknown Wash creation outcome halts New Day before the Short Rest reset", async () => {
  reset();
  const wash = item("wash", { healingTime: "1 day" }, "Помытый");
  const a = actor([wash]);
  game.items.push(item("source", { healingTime: "3 days" }, "Немытый"));
  await a.setFlag(scope, "shortRestRecovery", { quarterKey: "world:0" });
  a.createEmbeddedDocuments = async () => { throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }); };
  a.deleteEmbeddedDocuments = async () => assert.fail("Unknown creation must not delete the old stage");
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const plan = buildNewDayPlan(a);
  const result = await applyNewDayPlan(a, plan, plan.actions.map(action => action.id), { postChat: false });
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.partiallyApplied, false);
  assert.equal(result.failed[0].code, "condition-outcome-unknown");
  assert.ok(a.getFlag(scope, "shortRestRecovery"));
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /outcome.*unknown.*Check the sheet/);
});
test("reputation caps direct selected rolls before allocating dice", async () => {
  reset(); const a = actor(); const rep = await expose("scripts/reputation.js", ["rollReputation"]); let rolls = 0;
  globalThis.Roll = class { constructor() { rolls += 1; } };
  const entries = [{ id: "r1", amount: 1000 }, { id: "r2", amount: 1000 }];
  assert.equal(await rep.rollReputation(a, entries, entries.map(entry => ({ entry, amount: entry.amount }))), null); assert.equal(rolls, 0);
});
test("A16: suppressed writes coalesce a refresh on another view and close cancels it", async () => {
  reset(); const a = actor(); const root = { querySelector: () => ({}), contains: () => false, isConnected: true }; const app = { actor: a, element: root, rendered: true }; a.apps = { app }; let renders = 0;
  scheduleStatSync(a, { render: false }, "other", async () => { renders += 1; }); scheduleStatSync(a, { render: false }, "other", async () => { renders += 1; });
  await delay(10); assert.equal(renders, 1);
  scheduleStatSync(a, { render: false }, "other", async () => { renders += 1; }); cleanupStatSync(app); await delay(10); assert.equal(renders, 1);
});
test("A16: a stale asynchronous row build cannot replace the current view", async () => {
  reset(); let finish; let current = true; let replacements = 0;
  const html = { find: () => ({ html: () => { replacements += 1; } }) };
  const refresh = refreshConditionsRows({ html, buildRows: () => new Promise(resolve => { finish = resolve; }), isCurrent: () => current });
  current = false; finish("old rows"); assert.equal(await refresh, null); assert.equal(replacements, 0);
});
test("A02: a new special kind or lethal flag invalidates a previously ordinary injury plan", async () => {
  for (const change of [wound => set(wound.flags, `${scope}.conditions.kind`, "heat"), wound => { wound.system.lethal = "yes"; }]) {
    reset(); const wound = item("w", { healingTime: "1 day", lethal: "no" }); const a = actor([wound]); const plan = buildNewDayPlan(a);
    change(wound); const result = await applyNewDayPlan(a, plan, plan.actions.map(entry => entry.id), { postChat: false });
    assert.equal(a.items.includes(wound), true); assert.ok(result.failed.length > 0);
  }
});
test("CodeRabbit: partial BIO retry preserves a newer edit to the committed field", async () => {
  reset(); const a = actor(); const state = getBiographyProfile(a);
  const status = {};
  state.physical.height = "180"; state.physical.eyes = "green"; state.physical.hair = "red";
  const originalUpdate = a.update; let rejectEyes = true;
  a.update = async patch => {
    if (rejectEyes && Object.hasOwn(patch, `flags.${scope}.biographyProfile.physical.eyes`)) {
      throw new Error("Second path unavailable");
    }
    return originalUpdate(patch);
  };
  for (const path of ["physical.height", "physical.eyes", "physical.hair"]) queueProfileSave(a, state, status, 10_000, path);
  await flushBiographySaves(a);
  assert.match(status.className, /\bis-error\b/);
  assert.equal(getBiographyProfile(a).physical.height, "180");
  assert.equal(getBiographyProfile(a).physical.eyes, "");
  assert.equal(getBiographyProfile(a).physical.hair, "");
  await originalUpdate({ [`flags.${scope}.biographyProfile.physical.height`]: "190" });
  const retryStart = a.updates.length; rejectEyes = false; await flushBiographySaves(a);
  const saved = getBiographyProfile(a); assert.equal(saved.physical.height, "190");
  assert.equal(saved.physical.eyes, "green"); assert.equal(saved.physical.hair, "red");
  assert.equal(a.updates.slice(retryStart).some(patch => Object.hasOwn(patch, `flags.${scope}.biographyProfile.physical.height`)), false);
});

test("closing the base Actor sheet keeps the synthetic Actor's Willpower popover open", async () => {
  reset();
  const { openWillpowerTalentPopover, closeWillpowerTalentPopover } = await expose("scripts/willpower.js", ["openWillpowerTalentPopover"]);
  const { document, window } = globalThis;
  let removes = 0;
  const popover = {
    dataset: {}, style: {}, classList: { add() {} },
    querySelector: () => null, remove: () => { removes += 1; }
  };
  globalThis.document = { createElement: () => popover, body: { appendChild() {} }, removeEventListener() {} };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  const actor = { id: "same", uuid: "Scene.scene.Token.token.Actor.same" };
  const anchor = { getBoundingClientRect: () => ({ top: 80, bottom: 100, left: 100 }) };

  try {
    openWillpowerTalentPopover(null, actor, anchor);
    closeWillpowerTalentPopover({ id: "same", uuid: "Actor.same" });
    assert.equal(removes, 0);
    closeWillpowerTalentPopover("same");
    assert.equal(removes, 1);

    openWillpowerTalentPopover(null, actor, anchor);
    closeWillpowerTalentPopover({ ...actor });
    assert.equal(removes, 2);
  } finally {
    closeWillpowerTalentPopover();
    Object.assign(globalThis, { document, window });
  }
});
test("CodeRabbit: over-limit reputation stays visible and unchanged until explicitly corrected", async () => {
  for (const amount of [1500, Number.MAX_SAFE_INTEGER + 1]) {
    reset(); const a = actor(); const original = [{ id: "old", amount, description: "Legacy achievement", location: "Town" }];
    await a.setFlag(scope, "reputationEntries", structuredClone(original));
    const visible = getReputationEntries(a); assert.deepEqual(visible, original);
    const edited = visible.map(entry => ({ ...entry, description: "Edited description" }));
    await assert.rejects(saveReputationEntries(a, edited), RangeError);
    assert.throws(() => selectRandomReputation(visible, 2), RangeError);
    assert.equal(a.updates.length, 0); assert.deepEqual(a.getFlag(scope, "reputationEntries"), original);
    await saveReputationEntries(a, edited.map(entry => ({ ...entry, amount: 900 })));
    assert.equal(a.getFlag(scope, "reputationEntries")[0].amount, 900);
    assert.equal(a.getFlag(scope, "reputationEntries")[0].location, "Town");
  }
});
test("CodeRabbit: reputation dialog warns and disables rolls until the displayed pool is corrected", async () => {
  reset(); const rep = await expose("scripts/reputation.js", ["refreshDialogSummary", "reputationTemplateData"]);
  const a = actor(); await a.setFlag(scope, "reputationEntries", [{ id: "old", amount: 1500, description: "Legacy" }]);
  const data = rep.reputationTemplateData(a);
  assert.equal(data.overLimit, true);
  assert.match(data.labels.limit, /Existing values are preserved/);
  const template = await fs.readFile(new URL("../templates/reputation/reputation-dialog.hbs", import.meta.url), "utf8");
  assert.match(template, /data-role="limit-warning" role="alert"{{#unless overLimit}} hidden{{\/unless}}>\s*{{labels\.limit}}/);
  let amount = "1500"; const warning = { hidden: true }; const controls = Object.fromEntries(["roll-selected", "roll-half", "roll-third"].map(key => [key, { disabled: false }]));
  const row = { dataset: { entryId: "old" }, querySelector: selector => selector.includes("amount") ? { value: amount } : selector.includes("selected") ? { checked: true } : { value: "Legacy" } };
  const rowsRoot = { querySelectorAll: () => [row] };
  const root = { querySelector: selector => selector === ".fblqa-reputation-rows" ? rowsRoot : selector.includes("limit-warning") ? warning
    : controls[selector.match(/data-action='([^']+)'/)?.[1]] ?? null };
  rep.refreshDialogSummary(root); assert.equal(warning.hidden, false); assert.ok(Object.values(controls).every(control => control.disabled));
  amount = "900"; rep.refreshDialogSummary(root); assert.equal(warning.hidden, true); assert.ok(Object.values(controls).every(control => !control.disabled));
});

test("handleApplyProviderAction allows GM and OWNER players on NPC actors and rejects non-owners", async () => {
  reset();
  const npc = actor();
  npc.type = "npc";
  const owner = user("npc-owner");
  const outsider = user("npc-outsider");
  npc.testUserPermission = (candidate, perm) => perm === "OWNER" && candidate.id === owner.id;
  const providerModule = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const action = { id: "npc-step", label: "NPC tick" };
  let calls = 0;
  const unregister = providerModule.registerNewDayProvider({
    id: "audit.npc",
    category: "audit",
    buildActions: async () => [{ ...action }],
    applyAction: async () => { calls += 1; return { changed: true, summary: "Ticked" }; },
    describeAction: () => "",
    icon: () => "fa-check"
  });
  try {
    const gmResult = await providerModule.handleApplyProviderAction(
      { actorUuid: npc.uuid, providerId: "audit.npc", action },
      { requestUser: game.user, requesterId: game.user.id, activeGM: game.user, isRemote: false }
    );
    assert.equal(gmResult.changed, true);
    const ownerResult = await providerModule.handleApplyProviderAction(
      { actorUuid: npc.uuid, providerId: "audit.npc", action },
      { requestUser: owner, requesterId: owner.id, activeGM: game.user, isRemote: true }
    );
    assert.equal(ownerResult.changed, true);
    await assert.rejects(
      providerModule.handleApplyProviderAction(
        { actorUuid: npc.uuid, providerId: "audit.npc", action },
        { requestUser: outsider, requesterId: outsider.id, activeGM: game.user, isRemote: true }
      ),
      { code: "no-actor-permission" }
    );
    assert.equal(calls, 2);
  } finally {
    unregister();
  }
});

test("handleCalendariaApplyRequest rejects assigned players who lost OWNER permission before writing", async () => {
  reset();
  const wound = item("w", { healingTime: "4 days" });
  const a = actor([wound]);
  const date = { ...start, day: 2 };
  const player = await assignForCalendar(a, date);
  a.testUserPermission = () => false;
  const plan = buildNewDayPlan(a, { dayKey: "calendar:audit:1:1:2" });
  const selection = getNewDaySelection(plan, ["injury:w:healing"]);
  await assert.rejects(
    calendar.handleCalendariaApplyRequest({ ...selection, actorId: a.id, calendarId: "audit", targetDate: date }, { requestUser: player }),
    { code: "no-actor-permission" }
  );
  assert.equal(wound.system.healingTime, "4 days");
  assert.equal(a.updates.length, 0);
});

test("New Day rejects as stale-plan if the calendar returns to request.dayKey after building an earlier day plan", async () => {
  reset();
  const addiction = item("addiction-item", {}, "Addiction");
  set(addiction.flags, `${scope}.conditions.kind`, "addiction");
  set(addiction.flags, `${scope}.conditions.addictionState`, { phase: "down", die: 12, daysLeft: 0, severity: 5 });
  const a = actor([addiction]);
  let rolls = 0;
  globalThis.Roll = class { constructor() { rolls += 1; } async evaluate() { this.total = 4; return this; } };
  const requestedDate = { year: 1, month: 1, day: 5 };
  const earlierDate = { year: 1, month: 1, day: 4 };
  let flipDuringBuild = false;
  const unregister = registerNewDayProvider({
    id: "audit.date-flip",
    category: "audit",
    buildActions: async () => {
      if (flipDuringBuild) CALENDARIA.api.getCurrentDateTime = () => requestedDate;
      return [{ id: "noop", label: "Provider" }];
    },
    applyAction: async () => ({ changed: true }),
    describeAction: () => "",
    icon: () => "fa-check"
  });
  try {
    CALENDARIA.api.getCurrentDateTime = () => requestedDate;
    const plan = await buildNewDayPlanWithProviders(a);
    flipDuringBuild = true;
    CALENDARIA.api.getCurrentDateTime = () => earlierDate;
    const result = await applyNewDayPlan(a, plan, [`addiction:${addiction.id}:day`, "provider:audit.date-flip:noop"], { postChat: false });
    assert.equal(rolls, 0);
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.every(entry => entry.code === "stale-plan"));
    assert.equal(addiction.updates.length, 0);
  } finally {
    unregister();
  }
});

test("prepareGMSummary stops writing subsequent baselines after one actor baseline write fails", async () => {
  reset();
  const first = actor();
  const second = actor();
  const third = actor();
  first.name = "Alpha";
  second.name = "Beta";
  third.name = "Gamma";
  for (const candidate of [first, second, third]) {
    const owner = user(`player-${candidate.id}`);
    owner.character = candidate;
    game.users.push(owner);
  }
  second.setFlag = async () => { throw new Error("baseline rejected"); };
  let thirdWrites = 0;
  const origThirdSetFlag = third.setFlag;
  third.setFlag = async (...args) => { thirdWrites += 1; return origThirdSetFlag(...args); };

  const summary = await calendar.prepareGMSummary(context, { reason: "day-change" });
  assert.ok(first.getFlag(scope, "stateProgressionCalendaria"));
  assert.equal(summary.statuses.get(second.id)?.state, "error");
  assert.equal(third.getFlag(scope, "stateProgressionCalendaria"), undefined);
  assert.equal(thirdWrites, 0);
});

test("applyAutomaticDaysFromSummary preserves error state and stops the batch when unassignment races a day failure", async () => {
  reset();
  const wound = item("w", { healingTime: "4 days" });
  const a = actor([wound]);
  const player = await assignForCalendar(a);
  const origSetFlag = a.setFlag;
  a.setFlag = async (module, key, value) => {
    if (key === "stateProgressionCalendaria") {
      player.character = null;
      throw new Error("marker write failed");
    }
    return origSetFlag(module, key, value);
  };
  const entry = { actor: a, users: [player], primaryUser: player };
  const state = { key: "audit:1.1.3", context, entries: new Map([[a.id, entry]]), statuses: new Map(), root: null, dialog: null };
  const marker = a.getFlag(scope, "stateProgressionCalendaria");

  const proceed = await calendar.applyAutomaticDaysFromSummary(state, entry, context, 1, { marker });
  assert.equal(proceed, false);
  assert.equal(state.statuses.get(a.id)?.state, "error");
});

test("equipment updates still verify changes when Foundry expands dotted paths in place", async () => {
  reset();
  const { CONFIG } = globalThis;
  globalThis.CONFIG = { fbl: {} };
  try {
    const sword = item("sword", { weight: "normal" }, "Sword");
    sword.type = "weapon";
    const a = actor([sword]);
    await a.setFlag(scope, "slots", ["sword"]);
    const origUpdate = a.update;
    a.update = async data => {
      await origUpdate({ [`flags.${scope}.equipmentHands`]: { left: null, right: null } });
      expandUpdateInPlace(data);
      return a;
    };
    await assert.rejects(
      performEquipmentAction(a, { type: "hold", hand: "left", itemId: "sword" }),
      /changed during the update/
    );
  } finally {
    if (CONFIG === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = CONFIG;
  }
});
