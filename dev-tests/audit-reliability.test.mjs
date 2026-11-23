import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildNewDayPlan, applyNewDayPlan, decrementFirstInteger } from "../scripts/new-day.js";
import { queueProfileSave, flushBiographySaves, releaseBiographyState, getBiographyProfile, biographyDisplayHtml } from "../scripts/biography.js";
import { applyMorGain, changePermanentMor, clearStaleMorGain, getMorState, updateHeatItem, parseHeatValue, saveAddictionState } from "../scripts/conditions/features/special-counters.js";
import { canonicalJson } from "../scripts/document-writes.js";
import { withWalletLocks } from "../scripts/actor-mutation-lock.js";
import { transitionWashLevel } from "../scripts/conditions/features/wash.js";
import { getConditionKind, getWashStage } from "../scripts/conditions/condition-kind.js";
import { getReputationEntries, normalizeReputationEntries, selectRandomReputation, saveReputationEntries } from "../scripts/reputation.js";
import { initializeWalletOperations } from "../scripts/wallet.js";
import { executeAsActiveGM } from "../scripts/integration/socket-api.js";
import { registerNewDayProvider, initializeNewDayProviderBridge } from "../scripts/integration/new-day-providers.js";
import { enqueueCurrencyOperation, enqueueCustomConditionOperation } from "../scripts/operation-queue.js";
import { scheduleStatSync, cleanupStatSync } from "../scripts/conditions/stat-sync.js";
import { refreshConditionsRows } from "../scripts/conditions/render/refresh-rows.js";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";

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
  if (leaf.startsWith("-=")) delete parent[leaf.slice(2)];
  else if (leaf.startsWith("==")) parent[leaf.slice(2)] = structuredClone(entry);
  else parent[leaf] = structuredClone(entry);
};
function reset() {
  globalThis.foundry = { utils: { getProperty: get, deepClone: structuredClone,
    randomID: () => `audit${String(++nextId).padStart(20, "0")}`,
    mergeObject: (base, patch) => ({ ...base, ...patch }) } };
  globalThis.Hooks = { on() {}, callAll() {} };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} }, windows: {} };
  globalThis.game = { user: user("gm", true), users: [], actors: new Map(), items: [], packs: [],
    world: { id: "audit-world" },
    modules: new Map([["calendaria", { active: true }]]), time: { worldTime: 0 },
    settings: { get: (_scope, key) => key === "stateProgressionMode" ? "calendaria" : key.startsWith("feature") || key === "chatMessages" || key === "playersCanEdit" },
    i18n: { localize: key => key, format: key => key }, socket: { on() {}, emit() {} } };
  game.users = [game.user]; game.users.get = id => game.users.find(entry => entry.id === id);
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => null };
  globalThis.CALENDARIA = { api: { getCurrentDateTime: () => ({ year: 1, month: 1, day: 3, hour: 0 }),
    getActiveCalendar: () => ({ id: "audit", days: { hoursPerDay: 24 } }),
    daysBetween: (from, to) => to.day - from.day, addDays: (from, days) => ({ ...from, day: from.day + days }) } };
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = createMemoryStorage();
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
    update: async data => { result.updates.push(data); for (const [key, value] of Object.entries(data)) set(result, key, value); },
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
    update: async data => { result.updates.push(data); for (const [key, value] of Object.entries(data)) set(result, key, value); },
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
  "buildPlayerResultContent", "handleCalendariaMultiDayJump", "processActorAutomaticDays", "recordCalendarFailures",
  "resetAllFromGMSummary", "rewindAllFromGMSummary", "applyCalendarDay"
]);
const rest = await expose("scripts/rest.js", ["applyRest"]);
const money = await expose("scripts/money-transfer.js", ["executeMoneyTransfer", "processTransferDecision"]);
const start = { year: 1, month: 1, day: 1 };
const context = { calendarId: "audit", date: { ...start, day: 3 } };

function captureCalendarDialogs() {
  const dialogs = [];
  foundry.applications = { api: { DialogV2: class {
    constructor(config) { this.config = config; dialogs.push(this); }
    addEventListener() {}
    close() {}
    render() {}
    submit(action) { return this.config.buttons.find(button => button.action === action).callback({}, {}, this); }
  } } };
  return dialogs;
}

function assignedActor(items) {
  const character = actor(items);
  const owner = user(`owner-${character.id}`);
  owner.character = character;
  game.users.push(owner);
  return character;
}

function withEffectStore(actor, server) {
  const local = new Map(server);
  actor.getEmbeddedCollection = () => local;
  actor.createEmbeddedDocuments = async (type, [effect], options) => {
    if (type !== "ActiveEffect" || !options.keepId) throw new Error("Invalid lock document");
    if (server.has(effect._id)) throw new Error("Duplicate embedded document ID");
    const document = { ...effect, id: effect._id };
    server.set(document.id, document);
    local.set(document.id, document);
    return [document];
  };
  actor.deleteEmbeddedDocuments = async (_type, ids) => {
    for (const id of ids) {
      server.delete(id);
      local.delete(id);
    }
    return ids;
  };
  return actor;
}

test("two wallet operations cannot share a character across client caches", async () => {
  reset();
  const server = new Map();
  const shared = withEffectStore({ id: "shared" }, server);
  const otherClient = withEffectStore({ id: shared.id }, server);
  const anotherActor = withEffectStore({ id: "another" }, new Map());
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = withWalletLocks([shared], async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await assert.rejects(withWalletLocks([anotherActor, otherClient], () => assert.fail("conflicting wallet write")), { code: "actor-mutation-busy" });
    assert.equal(anotherActor.getEmbeddedCollection().size, 0);
  } finally { release.resolve(); }
  await first;
  assert.equal(server.size, 0);
  assert.equal(await withWalletLocks([otherClient], () => "completed"), "completed");
});

test("a separate client cannot replace a pending Mor gain", async () => {
  reset();
  const server = new Map();
  const firstItem = item("mor", { healingTime: "1/0" }, "Mor");
  const secondItem = item("mor", { healingTime: "1/0" }, "Mor");
  const firstActor = withEffectStore(actor([firstItem]), server);
  const secondActor = withEffectStore(actor([secondItem]), server);
  secondActor.id = firstActor.id;
  firstActor.system.attribute.strength.value = 4;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let rolls = 0;
  globalThis.Roll = class {
    async evaluate() {
      rolls += 1;
      entered.resolve();
      await release.promise;
      this.terms = [{ results: [{ result: 1 }] }];
      return this;
    }
  };
  const first = applyMorGain(firstActor, firstItem);
  await entered.promise;
  try {
    await assert.rejects(applyMorGain(secondActor, secondItem), { code: "actor-mutation-busy" });
  } finally { release.resolve(); }
  const result = await first;
  assert.equal(rolls, 1);
  assert.equal(result.state.current, 2);
  assert.equal(firstActor.system.attribute.strength.value, 3);
  assert.equal(server.size, 0);
});

test("New Day leaves custom conditions intact while another client is editing the list", async () => {
  reset();
  const server = new Map();
  const editor = withEffectStore(actor(), server);
  const dayClient = withEffectStore(actor(), server);
  dayClient.id = editor.id;
  const key = "conditions.list";
  const conditions = [{ id: "cold", name: "Cold", time: "3 days", notes: "", order: 10 }];
  await dayClient.setFlag(scope, key, conditions);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const editing = enqueueCustomConditionOperation(editor, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    const plan = buildNewDayPlan(dayClient);
    await assert.rejects(applyNewDayPlan(dayClient, plan, ["custom:cold:timer"], { postChat: false }), { code: "actor-mutation-busy" });
    assert.deepEqual(dayClient.updates, []);
    assert.deepEqual(dayClient.getFlag(scope, key), conditions);
  } finally { release.resolve(); }
  await editing;
});

test("A01: overlapping calendar requests read the live marker inside the queue", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  await a.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: start });
  const results = await Promise.all([calendar.processActorAutomaticDays(a, start, context, 2), calendar.processActorAutomaticDays(a, start, context, 2)]);
  assert.equal(a.items[0].system.healingTime, "8 days");
  assert.equal(results.reduce((sum, result) => sum + result.processedDays, 0), 2);
});
test("A01: a later calendar date supersedes a queued time skip after the started day", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  await a.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: start });
  const nextContext = { ...context, date: { ...start, day: 4 } };
  const write = a.update;
  a.update = async patch => {
    await write(patch);
    if (patch[`flags.${scope}.==stateProgressionCalendaria`]?.date.day === 2) {
      CALENDARIA.api.getCurrentDateTime = () => nextContext.date;
    }
  };
  const first = calendar.processActorAutomaticDays(a, start, context, 2);
  const next = calendar.processActorAutomaticDays(a, start, nextContext, 3);
  await assert.rejects(first, { code: "stale-calendar-day" });
  assert.equal((await next).processedDays, 2);
  assert.equal(a.items[0].system.healingTime, "7 days");
});

test("a confirmation from the old calendar cannot replace another calendar's baseline", async () => {
  reset();
  const dialogs = captureCalendarDialogs();
  const character = assignedActor();
  const skip = calendar.handleCalendariaMultiDayJump(start, { ...context, api: CALENDARIA.api }, 2);
  await delay(0);
  const confirmation = dialogs.at(-1);
  assert.match(confirmation.config.window.title, /time skip/i);

  CALENDARIA.api.getActiveCalendar = () => ({ id: "new-calendar" });
  const newMarker = { calendarId: "new-calendar", date: context.date };
  await character.setFlag(scope, "stateProgressionCalendaria", newMarker);
  await confirmation.submit("yes");
  await skip;
  assert.deepEqual(calendar.getActorCalendarMarker(character), newMarker);
  assert.deepEqual(character.updates, []);
});

test("bulk reset leaves markers untouched when the confirmation date changes", async () => {
  reset();
  const dialogs = captureCalendarDialogs();
  const characters = [assignedActor(), assignedActor()];
  const original = { calendarId: context.calendarId, date: start };
  for (const character of characters) await character.setFlag(scope, "stateProgressionCalendaria", original);
  const manager = await calendar.openStateProgressionManager();
  const resetting = calendar.resetAllFromGMSummary(manager);
  const confirmation = dialogs.at(-1);
  CALENDARIA.api.getCurrentDateTime = () => ({ ...context.date, day: 4 });
  await confirmation.submit("yes");
  await resetting;
  for (const character of characters) {
    assert.deepEqual(calendar.getActorCalendarMarker(character), original);
    assert.deepEqual(character.updates, []);
  }
});

test("bulk rewind keeps Resolve available for an interrupted day", async () => {
  reset();
  const dialogs = captureCalendarDialogs();
  const character = assignedActor();
  const unfinished = {
    id: "unfinished", phase: "applying", calendarId: context.calendarId, previousDate: start,
    date: { ...start, day: 2 }, through: { ...start, day: 2 }
  };
  await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: context.calendarId, date: start });
  await character.setFlag(scope, "stateProgressionOperation", unfinished);
  const eligible = assignedActor();
  await eligible.setFlag(scope, "stateProgressionCalendaria", { calendarId: context.calendarId, date: context.date });
  const manager = await calendar.openStateProgressionManager();
  const rewinding = calendar.rewindAllFromGMSummary(manager);
  await dialogs.at(-1).submit("rewind");
  await rewinding;
  assert.equal(manager.statuses.get(character.id).state, "recovery");
  assert.equal(manager.statuses.get(character.id).canAcknowledge, true);
  assert.deepEqual(character.getFlag(scope, "stateProgressionOperation"), unfinished);
  assert.deepEqual(calendar.getActorCalendarMarker(character).date, start);
  assert.equal(calendar.getActorCalendarMarker(eligible).date.day, 2);
});

test("the manager drops an unassigned character when it refreshes", async () => {
  reset();
  const original = assignedActor();
  const player = game.users.at(-1);
  const state = await calendar.openStateProgressionManager();
  assert.ok(state.entries.has(original.id));
  player.character = actor();
  const updated = await calendar.openStateProgressionManager();
  assert.deepEqual([...updated.entries.keys()], [player.character.id]);
  assert.equal(updated.statuses.has(original.id), false);
});

test("changing a pending marker invalidates an open time-skip approval", async () => {
  reset();
  const dialogs = captureCalendarDialogs();
  const wound = item("wound", { healingTime: "10 days" });
  const character = assignedActor([wound]);
  await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: context.calendarId, date: start });
  const skip = calendar.handleCalendariaMultiDayJump(start, { ...context, api: CALENDARIA.api }, 2);
  await delay(0);
  const changed = { calendarId: context.calendarId, date: { ...start, day: 2 } };
  await character.setFlag(scope, "stateProgressionCalendaria", changed);
  await dialogs.at(-1).submit("yes");
  await skip;
  assert.deepEqual(calendar.getActorCalendarMarker(character), changed);
  assert.equal(wound.system.healingTime, "10 days");
});

for (const [change, code] of [["mode", "wrong-progression-mode"], ["date", "stale-calendar-day"], ["timer", "stale-plan"]]) {
  test(`Calendaria keeps the marker pending if the ${change} changes while journaling`, async () => {
    reset();
    const date = { ...start, day: 2 };
    const live = { ...context, date, api: CALENDARIA.api };
    CALENDARIA.api.getCurrentDateTime = () => date;
    const wound = item("wound", { healingTime: "6 days" });
    const character = actor([wound]);
    await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: live.calendarId, date: start });
    const plan = buildNewDayPlan(character);
    const write = character.update;
    const settings = game.settings.get;
    character.update = async patch => {
      await write(patch);
      if (patch[`flags.${scope}.==stateProgressionOperation`]?.phase !== "applying") return;
      if (change === "mode") game.settings.get = (scope, key) => key === "stateProgressionMode" ? "long-rest" : settings(scope, key);
      else if (change === "date") CALENDARIA.api.getCurrentDateTime = () => start;
      else wound.system.healingTime = "9 days";
    };
    await assert.rejects(calendar.applyCalendarDay(character, live, start, date, date, plan, ["injury:wound:healing"]), { code });
    assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
    assert.deepEqual(calendar.getActorCalendarMarker(character).date, start);
    assert.deepEqual(wound.updates, []);
  });
}

test("a time skip stops after its current day when switched to Long Rest", async () => {
  reset();
  const wound = item("wound", { healingTime: "6 days" });
  const character = actor([wound]);
  await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: context.calendarId, date: start });
  const settings = game.settings.get;
  const write = character.update;
  character.update = async patch => {
    await write(patch);
    if (patch[`flags.${scope}.==stateProgressionCalendaria`]?.date.day === 2) {
      game.settings.get = (scope, key) => key === "stateProgressionMode" ? "long-rest" : settings(scope, key);
    }
  };
  await assert.rejects(calendar.processActorAutomaticDays(character, start, context, 2), { code: "wrong-progression-mode" });
  assert.equal(wound.system.healingTime, "5 days");
  assert.equal(calendar.getActorCalendarMarker(character).date.day, 2);
  assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
});

test("the player result distinguishes marker recovery from an empty day", () => {
  reset();
  const recovered = calendar.buildPlayerResultContent({ recoveredMarkerDate: context.date, days: [] });
  assert.match(recovered, /Saved the marker through 3\.1\.1/);
  assert.doesNotMatch(recovered, /No selected state changes/);
  assert.match(calendar.buildPlayerResultContent({ days: [] }), /No selected state changes/);
});

test("canonical document values preserve every own JSON property", () => {
  const value = Object.create(null);
  value.z = 1;
  value["__proto__"] = { label: "metadata" };
  value.a = 2;
  assert.deepEqual(Object.keys(JSON.parse(canonicalJson(value))), ["__proto__", "a", "z"]);
  assert.deepEqual(JSON.parse(canonicalJson(value))["__proto__"], { label: "metadata" });
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
test("A06: failed Heat damage keeps an intent and can be completed safely", async () => {
  reset(); const h = item("heat", { healingTime: "" }, "Heat"); const a = actor([h]); a.system.attribute.strength.value = 5;
  set(h.flags, `${scope}.conditions.heatValue`, 2); const update = a.update; a.update = async () => { throw new Error("damage failure"); };
  await assert.rejects(updateHeatItem(a, h, 3, "failure")); assert.equal(parseHeatValue(h), 2); assert.ok(h.getFlag(scope, "conditions.heatPendingChange"));
  a.update = update; await updateHeatItem(a, h, 3, "failure"); assert.equal(parseHeatValue(h), 3); assert.equal(a.system.attribute.strength.value, 4);
});
test("A06: retry after failed Heat finalization does not apply damage twice", async () => {
  reset(); const h = item("heat", { healingTime: "" }, "Heat"); const a = actor([h]); a.system.attribute.strength.value = 5;
  set(h.flags, `${scope}.conditions.heatValue`, 2); const update = h.update;
  h.update = async data => { if (data[`flags.${scope}.conditions.heatPendingChange`] === null) throw new Error("finalize failure"); return update(data); };
  await assert.rejects(updateHeatItem(a, h, 3, "failure")); assert.equal(a.system.attribute.strength.value, 4);
  h.update = update; await updateHeatItem(a, h, 3, "failure"); assert.equal(a.system.attribute.strength.value, 4); assert.equal(parseHeatValue(h), 3);
});
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
test("A07: failed provider build does not consume the calendar day and persists failure metadata", async () => {
  reset(); initializeNewDayProviderBridge(); const a = actor(); await a.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: start });
  const unregister = registerNewDayProvider({ id: "audit.fail", category: "audit", buildActions: async () => { throw new Error("offline provider"); }, applyAction: async () => ({}), describeAction: () => "", icon: () => "fa-check" });
  try { const result = await calendar.processActorAutomaticDays(a, start, context, 2); assert.equal(result.processedDays, 0); assert.equal(result.failedActions, 1);
    assert.equal(a.getFlag(scope, "stateProgressionCalendaria").date.day, 1); assert.equal(a.getFlag(scope, "stateProgressionFailures")[0].failures[0].kind, "provider-build"); }
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
test("A08: wallet edits and transfers share one authoritative queue", async () => {
  reset(); initializeWalletOperations(); const source = actor(); const target = actor(); source.system.currency.copper.value = 100;
  await Promise.all([executeAsActiveGM("wallet.apply-change", { actorUuid: source.uuid, mode: "delta", key: "copper", value: -10 }),
    enqueueCurrencyOperation(() => money.executeMoneyTransfer(source, target, { copper: 20 }))]);
  assert.equal(source.system.currency.copper.value, 70); assert.equal(target.system.currency.copper.value, 20);
});

test("a transfer cannot change either wallet without a saved reconciliation record", async () => {
  reset();
  const source = actor();
  const target = actor();
  source.system.currency.copper.value = 100;
  globalThis.localStorage.setItem = () => {};
  const result = await money.executeMoneyTransfer(source, target, { copper: 20 });
  assert.deepEqual(result, { ok: false, error: "update-failed" });
  assert.equal(source.system.currency.copper.value, 100);
  assert.equal(target.system.currency.copper.value, 0);
  assert.deepEqual(source.updates, []);
  assert.deepEqual(target.updates, []);
});
test("A08: wallet input bounds and insufficient funds reject before a write", async () => {
  reset(); initializeWalletOperations(); const a = actor();
  await assert.rejects(executeAsActiveGM("wallet.apply-change", { actorUuid: a.uuid, mode: "delta", key: "copper", value: -1 }));
  await assert.rejects(executeAsActiveGM("wallet.apply-change", { actorUuid: a.uuid, mode: "delta", key: "copper", value: Infinity }));
  assert.equal(a.updates.length, 0);
});
test("A09: revoking sender ownership while acceptance waits cancels the transfer", async () => {
  reset(); const source = actor(); const target = actor(); source.system.currency.copper.value = 100;
  const sender = user("sender"); const recipient = user("recipient"); game.users.push(sender, recipient);
  let owns = true; source.testUserPermission = () => owns;
  let unblock;
  const blocker = enqueueCurrencyOperation(() => new Promise(resolve => { unblock = resolve; }));
  await delay(0);
  const offer = { requestId: "audit-transfer", requesterId: sender.id, recipientUserId: recipient.id, primaryGmId: game.user.id,
    sourceActorId: source.id, targetActorId: target.id, amounts: { copper: 20 }, createdAt: Date.now() };
  const acceptance = money.processTransferDecision(offer, { ...offer, accepted: true });
  owns = false; unblock(); await blocker; await acceptance;
  assert.equal(source.system.currency.copper.value, 100); assert.equal(target.system.currency.copper.value, 0);
  assert.equal(source.updates.length + target.updates.length, 0);
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
  try { await assert.rejects(providerModule.handleApplyProviderAction({ actorUuid: a.uuid, providerId: "audit.stale", action: { id: "today", caseId: "other" } }, { requesterId: game.user.id, requestUser: game.user, activeGM: game.user, isRemote: false }), { code: "stale-provider-action" }); assert.equal(applications, 0); }
  finally { unregister(); }
});
test("provider action revalidation preserves the existing index fallback", async () => {
  reset(); const a = actor(); const providerModule = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const actions = [{ label: "First", value: 1 }, { label: "Second", value: 2 }]; let applied;
  const unregister = providerModule.registerNewDayProvider({ id: "audit.index", category: "audit", buildActions: async () => structuredClone(actions),
    applyAction: async (_actor, action) => { applied = action; return { changed: true }; }, describeAction: () => "", icon: () => "fa-check" });
  try { await providerModule.handleApplyProviderAction({ actorUuid: a.uuid, providerId: "audit.index", actionId: "1", action: actions[1] },
    { requesterId: game.user.id, requestUser: game.user, activeGM: game.user, isRemote: false }); assert.deepEqual(applied, actions[1]); }
  finally { unregister(); }
});

test("provider apply rechecks ownership after the provider rebuild awaits", async () => {
  reset();
  const owner = user("owner");
  game.users.push(owner);
  const character = actor();
  let allowed = true;
  character.testUserPermission = () => allowed;
  const { handleApplyProviderAction, registerNewDayProvider } = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const action = { id: "daily" };
  let applications = 0;
  const unregister = registerNewDayProvider({
    id: "audit.revoke", category: "audit",
    async buildActions() { await Promise.resolve(); allowed = false; return [action]; },
    async applyAction() { applications += 1; return { changed: true }; },
    describeAction: () => "", icon: () => "fa-check"
  });
  try {
    await assert.rejects(handleApplyProviderAction({ actorUuid: character.uuid, providerId: "audit.revoke", action }, {
      requesterId: owner.id, requestUser: owner, activeGM: game.user, isRemote: true
    }), { code: "actor-permission" });
    assert.equal(applications, 0);
  } finally {
    unregister();
  }
});

test("the rebuilt provider action is dispatched without another async actor lookup", async () => {
  reset();
  const character = actor();
  const { handleApplyProviderAction, registerNewDayProvider } = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const action = { id: "daily", days: 4 };
  let rebuilt = false;
  const lookup = globalThis.fromUuid;
  globalThis.fromUuid = async uuid => {
    assert.equal(rebuilt, false);
    return lookup(uuid);
  };
  const unregister = registerNewDayProvider({
    id: "audit.fresh-dispatch", category: "audit",
    async buildActions() { rebuilt = true; return [action]; },
    async applyAction(_actor, current) { assert.deepEqual(current, action); return { changed: true }; },
    describeAction: () => "", icon: () => "fa-check"
  });
  try {
    const result = await handleApplyProviderAction({ actorUuid: character.uuid, providerId: "audit.fresh-dispatch", action }, {
      requesterId: game.user.id, requestUser: game.user, activeGM: game.user, isRemote: false
    });
    assert.equal(result.changed, true);
  } finally {
    unregister();
  }
});

test("unregistering a provider while its plan rebuilds prevents dispatch", async () => {
  reset();
  const character = actor();
  const { handleApplyProviderAction, registerNewDayProvider } = await expose("scripts/integration/new-day-providers.js", ["handleApplyProviderAction"]);
  const action = { id: "daily" };
  let called = false;
  const unregister = registerNewDayProvider({
    id: "audit.unregister", category: "audit",
    async buildActions() { unregister(); return [action]; },
    async applyAction() { called = true; return { changed: true }; },
    describeAction: () => "", icon: () => "fa-check"
  });
  await assert.rejects(handleApplyProviderAction({ actorUuid: character.uuid, providerId: "audit.unregister", action }, {
    requesterId: game.user.id, requestUser: game.user, activeGM: game.user, isRemote: false
  }), { code: "provider-registration-changed" });
  assert.equal(called, false);
});

test("Mor gain resumes a vetoed Item write after reload without repeating damage or the roll", async () => {
  reset();
  let rolls = 0;
  globalThis.Roll = class {
    async evaluate() { rolls += 1; this.terms = [{ results: [{ result: 1 }] }]; return this; }
    static fromJSON(raw) { return Object.assign(new this(), JSON.parse(raw)); }
  };
  const mor = item("mor", { healingTime: "1/0" }, "Mor");
  const character = actor([mor]);
  character.system.attribute.strength.value = 4;
  const write = mor.update;
  mor.update = async patch => Object.values(patch).includes(null) ? undefined : write(patch);
  await assert.rejects(applyMorGain(character, mor), { code: "write-not-persisted" });
  assert.equal(character.system.attribute.strength.value, 3);
  assert.equal(getMorState(mor).current, 1);

  const reloadedMor = item(mor.id, structuredClone(mor.system), "Mor");
  reloadedMor.flags = structuredClone(mor.flags);
  const reloadedActor = actor([reloadedMor]);
  reloadedActor.flags = structuredClone(character.flags);
  reloadedActor.system = structuredClone(character.system);
  const result = await applyMorGain(reloadedActor, reloadedMor);
  assert.equal(result.state.current, 2);
  assert.equal(rolls, 1);
  assert.equal(reloadedActor.system.attribute.strength.value, 3);
});

test("a stale Mor gain can be cleared without replaying damage", async () => {
  reset();
  let rolls = 0;
  globalThis.Roll = class {
    async evaluate() { rolls += 1; this.terms = [{ results: [{ result: 1 }] }]; return this; }
  };
  const mor = item("mor", { healingTime: "1/0" }, "Mor");
  const character = actor([mor]);
  character.system.attribute.strength.value = 4;
  const write = character.update;
  character.update = async patch => {
    await write(patch);
    if (Object.hasOwn(patch, `flags.${scope}.conditions.morReceipts.${mor.id}`)) {
      await mor.update({ [`flags.${scope}.conditions.morState`]: { current: 1, permanent: 2 } });
    }
  };
  const pendingKey = "conditions.morPendingGain";
  await assert.rejects(applyMorGain(character, mor), { code: "stale-mor-gain" });
  const pending = mor.getFlag(scope, pendingKey);
  await assert.rejects(applyMorGain(character, mor), { code: "stale-mor-gain", pendingGainId: pending.id });
  await assert.rejects(clearStaleMorGain(mor, "older-operation"), { code: "stale-mor-state" });

  assert.equal(await clearStaleMorGain(mor, pending.id), true);
  assert.equal(mor.getFlag(scope, pendingKey), null);
  assert.deepEqual(await changePermanentMor(mor, 1), { current: 1, permanent: 3 });
  assert.equal(character.system.attribute.strength.value, 3);
  assert.equal(rolls, 1);
});

test("Biography keeps the more recent field edit when a queued write is vetoed", async () => {
  reset();
  const character = actor();
  const initial = getBiographyProfile(character);
  await character.setFlag(scope, "biographyProfile", initial);
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const write = character.update;
  character.update = async patch => {
    if (Object.values(patch).includes("older edit")) {
      started.resolve();
      await resume.promise;
      return;
    }
    return write(patch);
  };
  queueProfileSave(character, { ...initial, concept: "older edit" }, null, 10_000, "concept");
  const older = flushBiographySaves(character.id);
  await started.promise;
  queueProfileSave(character, { ...initial, concept: "newer edit" }, null, 10_000, "concept");
  const newer = flushBiographySaves(character.id);
  resume.resolve();
  assert.equal((await older)[0], false);
  assert.equal((await newer)[0], true);
  await flushBiographySaves(character);
  assert.equal(getBiographyProfile(character).concept, "newer edit");
});

test("the BIO tab restores running and pending patches over persisted fields", async () => {
  reset();
  const bio = await expose("scripts/biography.js", ["getBiographyDraft"]);
  const character = actor();
  const original = bio.getBiographyProfile(character);
  await character.setFlag(scope, "biographyProfile", original);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  character.update = async () => { entered.resolve(); await release.promise; };
  bio.queueProfileSave(character, { ...original, concept: "draft concept" }, null, 10_000, "concept");
  const saving = bio.flushBiographySaves(character);
  await entered.promise;
  bio.queueProfileSave(character, { ...original, languages: [{ name: "Draft language" }] }, null, 10_000, "languages");
  try {
    const draft = bio.getBiographyDraft(character);
    assert.equal(draft.concept, "draft concept");
    assert.equal(draft.languages[0].name, "Draft language");
    assert.equal(bio.getBiographyProfile(character).concept, original.concept);
    release.resolve();
    assert.equal((await saving)[0], false);
    assert.equal(bio.getBiographyDraft(character).concept, "draft concept");
  } finally {
    release.resolve();
    bio.releaseBiographyState(character);
  }
});

test("whole BIO and Pilgrim Card saves drop obsolete keys while keeping migrated values", async () => {
  reset();
  const { saveBiographyProfile, savePilgrimCardProfile } = await import("../scripts/biography.js");
  const character = actor();
  const legacy = { identity: { name: character.name, country: "Old Country" } };
  await character.setFlag(scope, "biographyProfile", structuredClone(legacy));
  await character.setFlag(scope, "pilgrimCardProfile", structuredClone(legacy));
  const write = character.update;
  character.update = async patch => {
    for (const path of [`flags.${scope}.biographyProfile`, `flags.${scope}.pilgrimCardProfile`]) {
      if (Object.hasOwn(patch, path)) patch[path] = { ...patch[path], identity: { ...legacy.identity, ...patch[path].identity } };
    }
    return write(patch);
  };
  assert.equal(await saveBiographyProfile(character, legacy), true);
  assert.equal(await savePilgrimCardProfile(character, legacy), true);
  for (const key of ["biographyProfile", "pilgrimCardProfile"]) {
    const saved = character.getFlag(scope, key);
    assert.equal(saved.identity.issuingCountry, "Old Country");
    assert.equal(Object.hasOwn(saved.identity, "country"), false);
  }
});

test("a reopened Pilgrim Card retains the name from a failed or in-flight save", async testContext => {
  reset();
  const bio = await expose("scripts/biography.js", ["openPilgrimCard", "queuePilgrimSave"]);
  const character = actor();
  const persisted = bio.normalizePilgrimCardProfile({ identity: { name: "Original name" }, physical: { height: "170" } });
  const draft = { ...persisted, identity: { ...persisted.identity, name: "Draft name" } };
  await character.setFlag(scope, "pilgrimCardProfile", persisted);

  const write = character.update;
  character.update = async () => undefined;
  bio.queuePilgrimSave(character, draft, 10_000);
  assert.equal((await bio.flushBiographySaves(character))[1], false);

  const retryStarted = Promise.withResolvers();
  const releaseRetry = Promise.withResolvers();
  character.update = async patch => {
    retryStarted.resolve();
    await releaseRetry.promise;
    return write(patch);
  };
  const drawers = [];
  globalThis.requestAnimationFrame = callback => { callback(); return 0; };
  testContext.after(() => { delete globalThis.requestAnimationFrame; });
  Object.assign(window, { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} });
  globalThis.document = {
    body: { append: drawer => drawers.push(drawer) },
    createElement: () => ({
      innerHTML: "",
      dataset: {},
      style: {},
      classList: { add() {}, remove() {} },
      height: {
        dataset: { bioPath: "physical.height" },
        matches: () => false,
        addEventListener(_type, listener) { this.edit = listener; }
      },
      querySelector: () => null,
      querySelectorAll(selector) { return selector.startsWith("[data-bio-path]") ? [this.height] : []; },
      remove() {}
    })
  };

  try {
    bio.openPilgrimCard(character, {}, null, true);
    assert.match(drawers.at(-1).innerHTML, /value="Draft name"/);
    await retryStarted.promise;
    bio.openPilgrimCard(character, {}, null, true);
    const reopened = drawers.at(-1);
    assert.match(reopened.innerHTML, /value="Draft name"/);
    reopened.height.value = "180";
    reopened.height.edit({ stopPropagation() {} });
    releaseRetry.resolve();
    assert.equal((await bio.flushBiographySaves(character))[1], true);
    const saved = bio.getPilgrimCardProfile(character);
    assert.equal(saved.identity.name, "Draft name");
    assert.equal(saved.physical.height, "180");
  } finally {
    releaseRetry.resolve();
    bio.releaseBiographyState(character);
  }
});

test("Reputation rejects a veto, but accepts a no-op with an already persisted total and ledger", async () => {
  reset();
  const character = actor();
  const write = character.update;
  const entries = [{ id: "reputation", amount: 2, description: "Deed", location: "City" }];
  character.update = async () => undefined;
  await assert.rejects(saveReputationEntries(character, entries), { code: "write-not-persisted" });
  character.update = write;
  assert.equal(await saveReputationEntries(character, entries), true);
  character.update = async () => undefined;
  assert.equal(await saveReputationEntries(character, entries), true);
});

test("New Day rejects a changed legacy timer after waiting behind a STAT operation", async () => {
  reset();
  const character = actor();
  const entry = { name: "Cold", time: "3 days", order: 10 };
  const key = "conditions.list";
  await character.setFlag(scope, key, [entry]);
  const plan = buildNewDayPlan(character);
  const action = plan.actions.find(candidate => candidate.kind === "custom-condition");
  assert.ok(action);
  const release = Promise.withResolvers();
  const edit = enqueueCustomConditionOperation(character, async () => {
    await release.promise;
    await character.setFlag(scope, key, [{ ...entry, time: "8 days" }]);
  });
  const applying = applyNewDayPlan(character, plan, [action.id], { postChat: false });
  release.resolve();
  await edit;
  const result = await applying;
  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(character.getFlag(scope, key)[0].time, "8 days");
});

test("Long Rest verifies the source under Sleepy and can finish remaining effect deletion", async () => {
  reset();
  const { applyRest } = await expose("scripts/rest.js", ["applyRest"]);
  const character = actor();
  character.system.condition.sleepy = { value: true };
  character.effects = [{ id: "sleepy", active: true, statuses: ["sleepy"] }];
  character._source = { system: structuredClone(character.system) };
  const write = character.update;
  character.update = async patch => {
    for (const [path, value] of Object.entries(patch)) if (path.startsWith("system.")) set(character._source, path, value);
    await write(patch);
    if (character.effects.length) character.system.condition.sleepy.value = true;
  };
  let deletes = 0;
  character.deleteEmbeddedDocuments = async () => { deletes += 1; return []; };
  const first = await applyRest(null, character, { type: "long" });
  assert.equal(first.failed, true);
  assert.equal(deletes, 1);
  assert.equal(character._source.system.condition.sleepy.value, false);
  assert.equal(character.system.condition.sleepy.value, true);
  assert.equal(character.system.attribute.strength.value, 2);

  const reloaded = actor();
  reloaded.flags = structuredClone(character.flags);
  reloaded.system = structuredClone(character._source.system);
  reloaded.effects = structuredClone(character.effects);
  reloaded.deleteEmbeddedDocuments = async (_type, ids) => {
    assert.deepEqual(ids, ["sleepy"]);
    reloaded.effects.length = 0;
  };
  const resumed = await applyRest(null, reloaded, { type: "long" });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.failed, undefined);
  assert.equal(reloaded.getFlag(scope, "pendingRestCleanup"), null);
  assert.equal(reloaded.system.attribute.strength.value, 2);
  assert.deepEqual(reloaded.effects, []);

  const alreadyClean = actor();
  alreadyClean.flags = structuredClone(character.flags);
  alreadyClean.system = structuredClone(character._source.system);
  alreadyClean.deleteEmbeddedDocuments = async () => assert.fail("the effect is already gone");
  assert.equal((await applyRest(null, alreadyClean, { type: "long" })).failed, undefined);
  assert.equal(alreadyClean.getFlag(scope, "pendingRestCleanup"), null);
  assert.equal(alreadyClean.system.attribute.strength.value, 2);
});

for (const intervening of [false, true]) {
  test(`Long Rest ${intervening ? "preserves a conflicting edit" : "retries recovery omitted by a hook"}`, async () => {
    reset();
    const character = actor();
    character.system.condition.sleepy = { value: true };
    character.effects = [{ id: "sleepy", active: true, statuses: ["sleepy"] }];
    const write = character.update;
    const strengthPath = "system.attribute.strength.value";
    character.update = patch => {
      const filtered = { ...patch };
      delete filtered[strengthPath];
      return write(filtered);
    };
    let effectsDeleted = 0;
    character.deleteEmbeddedDocuments = async () => { effectsDeleted += 1; character.effects.length = 0; };
    assert.equal((await rest.applyRest(null, character, { type: "long" })).failed, true);
    assert.equal(character.system.attribute.strength.value, 1);
    const pending = character.getFlag(scope, "pendingRestCleanup");
    assert.ok(pending);
    assert.equal(effectsDeleted, 0);
    character.update = write;
    if (intervening) character.system.attribute.strength.value = 4;

    const result = await rest.applyRest(null, character, { type: "long" });
    assert.equal(character.system.attribute.strength.value, intervening ? 4 : 2);
    assert.equal(effectsDeleted, intervening ? 0 : 1);
    if (intervening) {
      assert.equal(result.error?.code, "rest-recovery-conflict");
      assert.deepEqual(character.getFlag(scope, "pendingRestCleanup"), pending);
    } else {
      assert.equal(result.changed, true);
      assert.equal(result.failed, undefined);
      assert.equal(character.getFlag(scope, "pendingRestCleanup"), null);
    }
  });
}

test("Short Rest verifies the replacement record even within the same quarter", async () => {
  reset();
  const character = actor();
  const getQuarter = (await import("../scripts/rest.js")).getCurrentQuarterInfo;
  const used = { quarterKey: getQuarter().key, attribute: "strength" };
  await character.setFlag(scope, "shortRestRecovery", used);
  const write = character.update;
  character.update = patch => write(Object.fromEntries(Object.entries(patch).filter(([path]) => !path.endsWith("shortRestRecovery"))));
  const result = await rest.applyRest(null, character, {
    type: "short", resetShortQuarter: true, useShortRecovery: true, shortAttribute: "agility", shortConsumable: "water"
  });
  assert.equal(result.error?.code, "write-not-persisted");
  assert.equal(character.system.attribute.agility.value, 2);
  assert.deepEqual(character.getFlag(scope, "shortRestRecovery"), used);
});

test("Short Rest rechecks the owner's reset permission after waiting in the queue", async () => {
  reset();
  const character = actor();
  game.user = user("player");
  const settings = game.settings.get;
  let allowReset = true;
  game.settings.get = (scope, key) => key === "playersCanResetShortRest" ? allowReset : settings(scope, key);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const write = character.update;
  character.update = async patch => {
    started.resolve();
    await release.promise;
    return write(patch);
  };
  const first = rest.applyRest(null, character, { type: "short", useShortRecovery: true, shortAttribute: "strength", shortConsumable: "food" });
  await started.promise;
  const queued = rest.applyRest(null, character, { type: "short", resetShortQuarter: true, useShortRecovery: true, shortAttribute: "agility", shortConsumable: "water" });
  allowReset = false;
  release.resolve();
  assert.equal((await first).changed, true);
  assert.ok((await queued).errors.length);
  assert.equal(character.system.attribute.agility.value, 1);
  assert.equal(character.getFlag(scope, "shortRestRecovery").attribute, "strength");
});

test("bulk reset reports a refused marker and continues resetting the next Actor", async () => {
  reset();
  const { resetAllCalendarMarkersToCurrent } = await import("../scripts/state-progression.js");
  const characters = [actor(), actor(), actor()];
  for (const [index, character] of characters.entries()) {
    const player = user(`player${index}`);
    player.character = character;
    game.users.push(player);
    await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: { year: 1, month: 1, day: 1 } });
  }
  characters[1].update = async () => undefined;
  const result = await resetAllCalendarMarkersToCurrent();
  assert.equal(result.count, 2);
  assert.deepEqual(result.failedActorIds, [characters[1].id]);
  assert.deepEqual(result.succeededActorIds, [characters[0].id, characters[2].id]);
  assert.equal(characters[1].getFlag(scope, "stateProgressionCalendaria").date.day, 1);
  assert.equal(characters[2].getFlag(scope, "stateProgressionCalendaria").date.day, 3);
});
test("calendar failure records retain IDs without action payloads or private errors", async () => {
  reset(); const a = actor(); await calendar.recordCalendarFailures(a, context, context.date, [{ action: { id: "public-id", secret: "Hidden diagnosis" }, error: "Private failure" }]);
  const records = a.getFlag(scope, "stateProgressionFailures"); assert.equal(records[0].failures[0].id, "public-id");
  assert.doesNotMatch(JSON.stringify(records), /Hidden diagnosis|Private failure/);
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
  state.physical.height = "180"; state.physical.eyes = "green"; state.physical.hair = "red";
  const originalUpdate = a.update; let rejectEyes = true;
  a.update = async patch => {
    if (rejectEyes && Object.hasOwn(patch, `flags.${scope}.biographyProfile.physical.eyes`)) {
      throw new Error("Second path unavailable");
    }
    return originalUpdate(patch);
  };
  for (const path of ["physical.height", "physical.eyes", "physical.hair"]) queueProfileSave(a, state, null, 10_000, path);
  await flushBiographySaves(a);
  assert.equal(getBiographyProfile(a).physical.height, "180");
  assert.equal(getBiographyProfile(a).physical.eyes, "");
  assert.equal(getBiographyProfile(a).physical.hair, "");
  await originalUpdate({ [`flags.${scope}.biographyProfile.physical.height`]: "190" });
  const retryStart = a.updates.length; rejectEyes = false; await flushBiographySaves(a);
  const saved = getBiographyProfile(a); assert.equal(saved.physical.height, "190");
  assert.equal(saved.physical.eyes, "green"); assert.equal(saved.physical.hair, "red");
  assert.equal(a.updates.slice(retryStart).some(patch => Object.hasOwn(patch, `flags.${scope}.biographyProfile.physical.height`)), false);
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
  reset(); const rep = await expose("scripts/reputation.js", ["refreshDialogSummary", "buildDialogContent"]);
  const a = actor(); await a.setFlag(scope, "reputationEntries", [{ id: "old", amount: 1500, description: "Legacy" }]);
  const content = rep.buildDialogContent(true, getReputationEntries(a));
  assert.match(content, /data-role="limit-warning" role="alert" >[\s\S]*Existing values are preserved/);
  let amount = "1500"; const warning = { hidden: true }; const controls = Object.fromEntries(["roll-selected", "roll-half", "roll-third"].map(key => [key, { disabled: false }]));
  const row = { dataset: { entryId: "old" }, querySelector: selector => selector.includes("amount") ? { value: amount } : selector.includes("selected") ? { checked: true } : { value: "Legacy" } };
  const rowsRoot = { querySelectorAll: () => [row] };
  const root = { querySelector: selector => selector === ".fblqa-reputation-rows" ? rowsRoot : selector.includes("limit-warning") ? warning
    : controls[selector.match(/data-action='([^']+)'/)?.[1]] ?? null };
  rep.refreshDialogSummary(root); assert.equal(warning.hidden, false); assert.ok(Object.values(controls).every(control => control.disabled));
  amount = "900"; rep.refreshDialogSummary(root); assert.equal(warning.hidden, true); assert.ok(Object.values(controls).every(control => !control.disabled));
});
