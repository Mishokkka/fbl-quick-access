import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { buildNewDayPlan, buildNewDayPlanWithProviders, applyNewDayPlan } from "../scripts/new-day.js";
import { queueProfileSave, flushBiographySaves, releaseBiographyState, getBiographyProfile, biographyDisplayHtml } from "../scripts/biography.js";
import { acknowledgeCounterDamage, applyHeatFailure, applyMorGain, changePermanentMor, clearStaleMorGain, getAddictionState, getMorState, updateHeatItem, parseHeatValue, saveAddictionState } from "../scripts/conditions/features/special-counters.js";
import { getAddictionDayKey, getAddictionMorning, getPendingAddictionTransition, handleAddictionOperation, performAddictionMorning } from "../scripts/conditions/services/addiction-service.js";
import { FLAGS, LEGACY_FLAGS, LEGACY_MODULE_ID, flagUpdatePath } from "../scripts/conditions/constants.js";
import { migrateActorData } from "../scripts/conditions/migrations.js";
import { recoverActorMutationLock } from "../scripts/actor-mutation-lock.js";
import { getActorCalendarMarker, setActorCalendarMarker } from "../scripts/state-progression.js";
import { canonicalJson } from "../scripts/document-writes.js";
import { transitionWashLevel } from "../scripts/conditions/features/wash.js";
import { getConditionKind, getWashStage } from "../scripts/conditions/condition-kind.js";
import { getReputationEntries, normalizeReputationEntries, selectRandomReputation, saveReputationEntries } from "../scripts/reputation.js";
import { initializeWalletOperations } from "../scripts/wallet.js";
import { executeAsActiveGM } from "../scripts/integration/socket-api.js";
import { registerNewDayProvider, initializeNewDayProviderBridge } from "../scripts/integration/new-day-providers.js";
import { enqueueActorMutationOperation, enqueueCurrencyOperation, withWalletLocks } from "../scripts/operation-queue.js";
import { scheduleStatSync, cleanupStatSync } from "../scripts/conditions/stat-sync.js";
import { refreshConditionsRows } from "../scripts/conditions/render/refresh-rows.js";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";
import { getFoundryPath as get, setFoundryPath } from "./helpers/foundry-documents.mjs";
import { exposeModule as expose } from "./helpers/expose-module.mjs";

const scope = "fbl-quick-access";
// Several cases deliberately simulate failed writes/notifications. Keep their
// expected diagnostics from flooding TAP with data-URL module stack traces.
const originalError = console.error;
console.error = () => {};
after(() => { console.error = originalError; });
let nextId = 0;
const set = (target, path, value) => setFoundryPath(target, path, value, { replace: true });
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

reset();
const calendar = await expose("scripts/state-progression.js", [
  "buildPlayerResultContent", "handleCalendariaMultiDayJump", "processActorAutomaticDays", "recordCalendarFailures",
  "resetAllFromGMSummary", "rewindAllFromGMSummary", "applyCalendarDay", "handleCalendariaApplyRequest",
  "enqueueStateProgressionOperation", "resetActorFromGMSummary"
]);
const rest = await expose("scripts/rest.js", ["applyRest"]);
const money = await expose("scripts/money-transfer.js", ["executeMoneyTransfer", "processTransferDecision"]);
const start = { year: 1, month: 1, day: 1 };
const context = { calendarId: "audit", date: { ...start, day: 3 } };

function captureCalendarDialogs() {
  const dialogs = [];
  class RewindForm extends HTMLElement {
    constructor(value) { super(); this.value = value; }
    matches(selector) { return selector === "form"; }
    querySelector() { return { value: this.value }; }
  }
  foundry.applications = { api: { DialogV2: class {
    constructor(config) { this.config = config; dialogs.push(this); }
    addEventListener(type, listener) { if (type === "close") this.onClose = listener; }
    close() { this.closed = true; this.onClose?.(); }
    render() {}
    submit(action, days = "1") { return this.config.buttons.find(button => button.action === action).callback({}, { form: new RewindForm(days) }, this); }
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

test("GM can release an abandoned lock after confirmation but cannot release a live one", async () => {
  reset();
  const holder = user("holder");
  game.users.push(holder);
  const id = "fblqaActorLock01";
  const server = new Map([[id, { id, flags: { [scope]: { mutationLock: "interrupted", mutationLockOwner: holder.id } } }]]);
  const character = withEffectStore(actor(), server);
  window.confirm = () => assert.fail("an online owner's lock should not be offered for recovery");
  await assert.rejects(recoverActorMutationLock(character), { code: "actor-mutation-busy" });
  holder.active = false;
  window.confirm = () => false;
  assert.equal(await recoverActorMutationLock(character), false);
  assert.equal(server.size, 1);
  window.confirm = () => true;
  assert.equal(await recoverActorMutationLock(character), true);

  await enqueueActorMutationOperation(character, async () => {
    await assert.rejects(recoverActorMutationLock(character), { code: "actor-mutation-busy" });
    assert.equal(server.size, 1);
  });
  assert.equal(server.size, 0);
});

test("lock recovery leaves a new lock intact even when the local Actor still shows the abandoned one", async () => {
  reset();
  const id = "fblqaActorLock01";
  const makeLock = token => ({ id, flags: { [scope]: { mutationLock: token } } });
  const server = new Map([[id, makeLock("abandoned")]]);
  const character = withEffectStore(actor(), server);
  const previous = globalThis.CONFIG;
  const documentClass = { database: { get: async () => [...server.values()] } };
  globalThis.CONFIG = { ActiveEffect: { documentClass } };
  window.confirm = () => {
    server.set(id, makeLock("new-operation"));
    return true;
  };
  try {
    await assert.rejects(recoverActorMutationLock(character), { code: "actor-mutation-busy" });
    assert.deepEqual([...server.values()], [makeLock("new-operation")]);
  } finally {
    globalThis.CONFIG = previous;
  }
});

test("pending Heat and Mor both apply damage through the shared actor queue", async () => {
  reset();
  const heat = item("heat", { rollModifiers: {} }, "Heat");
  const mor = item("mor", { healingTime: "1/0" }, "Mor");
  const character = actor([heat, mor]);
  character.system.attribute.strength.value = 4;
  set(heat.flags, scope + ".conditions.heatValue", 2);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const write = heat.update;
  heat.update = async patch => {
    if (patch[flagUpdatePath("conditions.heatPendingChange")]) {
      entered.resolve();
      await release.promise;
    }
    return write(patch);
  };
  globalThis.Roll = class {
    async evaluate() { this.terms = [{ results: [{ result: 1 }] }]; return this; }
  };
  const heating = applyHeatFailure(character, heat);
  await entered.promise;
  const morGain = applyMorGain(character, mor);
  release.resolve();
  await Promise.all([heating, morGain]);
  assert.equal(character.system.attribute.strength.value, 2);
  assert.equal(parseHeatValue(heat), 3);
  assert.equal(getMorState(mor).current, 2);
});

test("retrying Heat finalization preserves a later edit of the damaged attribute", async () => {
  reset();
  const heat = item("heat", { rollModifiers: {} }, "Heat");
  const character = actor([heat]);
  character.system.attribute.strength.value = 5;
  await heat.update({ [flagUpdatePath(FLAGS.HEAT_VALUE)]: 2 });
  const write = heat.update;
  heat.update = patch => patch[flagUpdatePath(FLAGS.HEAT_VALUE)] === 3 ? undefined : write(patch);
  await assert.rejects(applyHeatFailure(character, heat), { code: "write-not-persisted" });
  assert.equal(character.system.attribute.strength.value, 4);
  await character.update({ "system.attribute.strength.value": 5 });
  heat.update = write;
  await applyHeatFailure(character, heat);
  assert.equal(character.system.attribute.strength.value, 5);
  assert.equal(parseHeatValue(heat), 3);
});

test("an unverified Heat write can be confirmed without undoing a later recovery", async () => {
  reset();
  const heat = item("heat", { rollModifiers: {} }, "Heat");
  const character = actor([heat]);
  character.system.attribute.strength.value = 5;
  await heat.update({ [flagUpdatePath(FLAGS.HEAT_VALUE)]: 2 });
  const write = heat.update;
  const checkpoint = flagUpdatePath("conditions.==heatPendingChange");
  heat.update = patch => patch[checkpoint]?.damageInFlight === false ? undefined : write(patch);
  await assert.rejects(applyHeatFailure(character, heat), { code: "write-not-persisted" });
  assert.equal(character.system.attribute.strength.value, 4);

  await character.update({ "system.attribute.strength.value": 5 });
  heat.update = write;
  const pending = heat.getFlag(scope, "conditions.heatPendingChange");
  await assert.rejects(applyHeatFailure(character, heat), { code: "damage-recovery-required", damageId: pending.id });
  assert.equal(character.system.attribute.strength.value, 5);
  await acknowledgeCounterDamage(character, heat, pending.id);
  await applyHeatFailure(character, heat);
  assert.equal(character.system.attribute.strength.value, 5);
  assert.equal(parseHeatValue(heat), 3);
});

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

test("wallet and STAT writes share the local queue and the same lock across clients", async () => {
  reset();
  const server = new Map();
  const character = withEffectStore({ id: "shared" }, server);
  const otherClient = withEffectStore({ id: character.id }, server);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const wallet = withWalletLocks([character], async () => {
    started.resolve();
    await release.promise;
    calls.push("wallet");
  });
  await started.promise;
  const localEdit = enqueueActorMutationOperation(character, () => calls.push("STAT"));
  try {
    await assert.rejects(enqueueActorMutationOperation(otherClient, () => assert.fail("overlapping write")), { code: "actor-mutation-busy" });
    assert.deepEqual(calls, []);
  } finally { release.resolve(); }
  await Promise.all([wallet, localEdit]);
  assert.deepEqual(calls, ["wallet", "STAT"]);
  assert.equal(server.size, 0);
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
  const editing = enqueueActorMutationOperation(editor, async () => {
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

test("an unattended calendar calculation uses its default day limit", async () => {
  reset();
  const character = actor();
  const today = { ...context, date: { ...start, day: 101 } };
  CALENDARIA.api.getCurrentDateTime = () => today.date;
  await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: today.calendarId, date: start });

  const result = await calendar.processActorAutomaticDays(character, start, today, 100);

  assert.equal(result.processedDays, 90);
  assert.equal(result.limitedDays, 10);
  assert.equal(result.days.length, 1);
  assert.equal(getActorCalendarMarker(character).date.day, 91);
});

test("an approved calendar skip with a backlog stops at the hard limit", async () => {
  reset();
  const dialogs = captureCalendarDialogs();
  const character = assignedActor();
  const today = { ...context, date: { ...start, day: 401 }, api: CALENDARIA.api };
  CALENDARIA.api.getCurrentDateTime = () => today.date;
  await character.setFlag(scope, "stateProgressionCalendaria", { calendarId: today.calendarId, date: start });

  const manager = await calendar.openStateProgressionManager();
  const applying = calendar.handleCalendariaMultiDayJump({ ...start, day: 101 }, today, 300);
  await delay(0);
  const confirmation = dialogs.at(-1);
  assert.match(confirmation.config.window.title, /time skip/i);
  await confirmation.submit("yes");
  await applying;

  const { state, days, result } = manager.statuses.get(character.id);
  assert.equal(state, "blocked");
  assert.equal(days, 35);
  assert.equal(result.processedDays, 365);
  assert.equal(result.days.length, 1);
  assert.equal(getActorCalendarMarker(character).date.day, 366);
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
  await dialogs.at(-1).submit("rewind", "");
  assert.deepEqual(calendar.getActorCalendarMarker(eligible).date, context.date);
  await dialogs.at(-1).submit("rewind");
  await rewinding;
  assert.equal(manager.statuses.get(character.id).state, "recovery");
  assert.equal(manager.statuses.get(character.id).canAcknowledge, true);
  assert.deepEqual(character.getFlag(scope, "stateProgressionOperation"), unfinished);
  assert.deepEqual(calendar.getActorCalendarMarker(character).date, start);
  assert.equal(calendar.getActorCalendarMarker(eligible).date.day, 2);
});

test("the manager refreshes assignments and replaces the summary when the date changes", async () => {
  reset();
  captureCalendarDialogs();
  const original = assignedActor();
  const player = game.users.at(-1);
  const state = await calendar.openStateProgressionManager();
  assert.ok(state.entries.has(original.id));
  player.character = actor();
  const updated = await calendar.openStateProgressionManager();
  assert.equal(updated, state);
  assert.deepEqual([...updated.entries.keys()], [player.character.id]);
  assert.equal(updated.statuses.has(original.id), false);

  const staleDialog = state.dialog;
  CALENDARIA.api.getCurrentDateTime = () => ({ ...context.date, day: 4 });
  const next = await calendar.openStateProgressionManager();
  assert.notEqual(next, state);
  assert.equal(staleDialog.closed, true);
  assert.equal(await calendar.openStateProgressionManager(), next);
  CALENDARIA.api.getCurrentDateTime = () => context.date;
  assert.notEqual(await calendar.openStateProgressionManager(), state);
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

for (const [change, code] of [["mode", "wrong-progression-mode"], ["date", "stale-calendar-day"],
  ["date and cleanup", "stale-calendar-day"], ["timer", "stale-plan"]]) {
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
      if (change === "date and cleanup" && patch[`flags.${scope}.stateProgressionOperation`] === null) return;
      await write(patch);
      if (patch[`flags.${scope}.==stateProgressionOperation`]?.phase !== "applying") return;
      if (change === "mode") game.settings.get = (scope, key) => key === "stateProgressionMode" ? "long-rest" : settings(scope, key);
      else if (change.startsWith("date")) CALENDARIA.api.getCurrentDateTime = () => start;
      else wound.system.healingTime = "9 days";
    };
    await assert.rejects(calendar.applyCalendarDay(character, live, start, date, date, plan, ["injury:wound:healing"]), { code });
    const journal = character.getFlag(scope, "stateProgressionOperation");
    if (change === "date and cleanup") assert.equal(journal.phase, "applying");
    else assert.equal(journal, null);
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

test("Heat retries only the part of threshold damage omitted by the first write", async () => {
  reset();
  const heat = item("heat", { rollModifiers: {} }, "Heat");
  const character = actor([heat]);
  character.system.attribute.strength.value = character.system.attribute.wits.value = 5;
  set(heat.flags, `${scope}.conditions.heatValue`, 3);
  const write = character.update;
  const wits = "system.attribute.wits.value";
  character.update = async patch => {
    const filtered = { ...patch };
    delete filtered[wits];
    return write(filtered);
  };
  await assert.rejects(applyHeatFailure(character, heat), { code: "write-not-persisted" });
  assert.equal(character.system.attribute.strength.value, 4);
  assert.equal(character.system.attribute.wits.value, 5);
  assert.equal(parseHeatValue(heat), 3);

  character.update = write;
  const retryStart = character.updates.length;
  await applyHeatFailure(character, heat);
  assert.deepEqual(character.updates.slice(retryStart).filter(patch => Object.keys(patch).some(key => key.startsWith("system.attribute."))), [{ [wits]: 4 }]);
  assert.equal(character.system.attribute.strength.value, 4);
  assert.equal(character.system.attribute.wits.value, 4);
  assert.equal(parseHeatValue(heat), 4);
});

test("an interrupted legacy Heat receipt can supply the original damage target", async () => {
  reset();
  const heat = item("heat", { rollModifiers: {} }, "Heat");
  const character = actor([heat]);
  character.system.attribute.strength.value = 5;
  set(heat.flags, `${scope}.conditions.heatValue`, 2);
  set(heat.flags, `${scope}.conditions.heatPendingChange`, {
    id: "old-heat", previousValue: 2, value: 3, damage: { strength: 1 }, overcap: false
  });
  await character.setFlag(scope, "conditions.heatReceipts.heat", {
    id: "old-heat", appliedDamage: [{ attribute: "strength", path: "system.attribute.strength.value", previous: 5, value: 4, amount: 1 }]
  });
  await applyHeatFailure(character, heat);
  assert.equal(character.system.attribute.strength.value, 4);
  assert.equal(parseHeatValue(heat), 3);
});
test("A06: Addiction phase and modifiers are one Item update", async () => {
  reset(); const dependency = item("dependency", { rollModifiers: {} }, "Addiction"); actor([dependency]);
  await saveAddictionState(dependency, { phase: "down", die: 8, daysLeft: 0, severity: 5 });
  assert.equal(dependency.updates.length, 1); assert.equal(dependency.getFlag(scope, "conditions.addictionState").die, 8);
  assert.equal(dependency.system.rollModifiers.fblecAddictionStrength.value, "-1");
});

test("a delayed request for an older Addiction day cannot overwrite the newer morning", async () => {
  reset();
  game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "long-rest" : true;
  const addiction = item("addiction", { rollModifiers: {} }, "Addiction");
  const character = actor([addiction]);
  await saveAddictionState(addiction, { phase: "down", die: 12, daysLeft: 0, severity: 5 });
  await character.setFlag(scope, FLAGS.ADDICTION_DAY, 2);
  await addiction.update({ [flagUpdatePath(FLAGS.ADDICTION_MORNING)]: { id: "old-morning", dayKey: "manual:1", status: "resolved" } });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let rolls = 0;
  globalThis.Roll = class {
    async evaluate() {
      rolls++;
      if (rolls === 1) {
        entered.resolve();
        await release.promise;
      }
      this.total = 4;
      return this;
    }
  };
  const newer = performAddictionMorning(character, addiction, { dayKey: "manual:3", newDay: true, postChat: false });
  await entered.promise;
  const older = assert.rejects(handleAddictionOperation({
    actorId: character.id, itemId: addiction.id, kind: "morning",
    options: { dayKey: "manual:2", newDay: true, postChat: false }
  }, { requestUser: game.user }), { code: "stale-addiction-day" });
  release.resolve();
  await Promise.all([newer, older]);
  assert.equal(rolls, 1);
  assert.equal(getAddictionMorning(addiction).dayKey, "manual:3");
});

for (const path of [flagUpdatePath(FLAGS.ADDICTION_STATE), "system.rollModifiers.fblecAddictionStrength"]) {
  test(`Addiction resumes the saved outcome when ${path} was omitted`, async () => {
    reset();
    game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "long-rest" : true;
    const addiction = item("addiction", { rollModifiers: {} }, "Addiction");
    const character = actor([addiction]);
    await character.setFlag(scope, FLAGS.ADDICTION_DAY, 1);
    await saveAddictionState(addiction, { phase: "down", die: 6, daysLeft: 0, severity: 5 });
    let rolls = 0;
    globalThis.Roll = class { async evaluate() { rolls++; this.total = 4; return this; } };
    const write = addiction.update;
    addiction.update = patch => write(Object.fromEntries(Object.entries(patch).filter(([key]) => key !== path)));
    await assert.rejects(performAddictionMorning(character, addiction, { dayKey: "manual:2", newDay: true, postChat: false }), { code: "write-not-persisted" });
    assert.equal(getAddictionMorning(addiction), null);
    const saved = getPendingAddictionTransition(addiction);
    assert.equal(saved.nextState.phase, "flat");
    assert.equal(saved.nextState.daysLeft, 5);

    addiction.update = write;
    await performAddictionMorning(character, addiction, { postChat: false });
    assert.equal(rolls, 1);
    assert.equal(getAddictionDayKey(character, { newDay: true }), "manual:3");
    assert.equal(getAddictionMorning(addiction).id, saved.id);
    assert.deepEqual(getAddictionState(addiction), saved.nextState);
    assert.equal(addiction.system.rollModifiers.fblecAddictionStrength.value, "-2");
    assert.equal(getPendingAddictionTransition(addiction), null);
  });
}

test("Addiction keeps the staged cure until the manual day is verified", async () => {
  reset();
  game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "long-rest" : true;
  const addiction = item("addiction", { rollModifiers: {} }, "Addiction");
  const character = actor([addiction]);
  await character.setFlag(scope, FLAGS.ADDICTION_DAY, 1);
  await saveAddictionState(addiction, { phase: "up", die: 12, daysLeft: 0, severity: 5 });
  let rolls = 0;
  globalThis.Roll = class { async evaluate() { rolls++; this.total = 4; return this; } };
  const write = character.update;
  character.update = patch => Object.hasOwn(patch, flagUpdatePath(FLAGS.ADDICTION_DAY)) ? undefined : write(patch);
  const options = { postChat: false, documentOptions: { render: false } };
  await assert.rejects(performAddictionMorning(character, addiction, { ...options, dayKey: "manual:2", newDay: true }), { code: "write-not-persisted" });
  assert.equal(character.items.get(addiction.id), addiction);
  assert.equal(getPendingAddictionTransition(addiction).cured, true);

  character.update = write;
  const resumed = await performAddictionMorning(character, addiction, options);
  assert.equal(resumed.cured, true);
  assert.equal(rolls, 1);
  assert.equal(character.items.get(addiction.id), undefined);
  assert.equal(getAddictionDayKey(character, { newDay: true }), "manual:3");
});

for (const omitted of ["actor list", "item notes", "counter flag", "counter cleanup"]) {
  test(`legacy migration retains its source and retries when ${omitted} is omitted`, async () => {
    reset();
    const heat = item("heat", { healingTime: "4", rollModifiers: {} }, "Heat");
    await heat.update({ [flagUpdatePath(FLAGS.HEAT_VALUE)]: null });
    const wound = item("wound", { healingTime: "3 days" });
    const character = actor([heat, wound]);
    const conditions = [{ id: "cold", name: "Cold", time: "3 days", order: 10 }];
    set(character.flags, `${LEGACY_MODULE_ID}.${LEGACY_FLAGS.LIST}`, conditions);
    set(wound.flags, `${LEGACY_MODULE_ID}.${LEGACY_FLAGS.NOTES}`, "Treat tomorrow");
    const write = character.update;
    const writeItems = character.updateEmbeddedDocuments;
    const filter = (patch, path) => Object.fromEntries(Object.entries(patch).filter(([key]) => key !== path));
    character.update = patch => write(omitted === "actor list" ? filter(patch, flagUpdatePath(FLAGS.LIST)) : patch);
    const paths = { "item notes": flagUpdatePath(FLAGS.NOTES), "counter flag": flagUpdatePath(FLAGS.HEAT_VALUE),
      "counter cleanup": "system.healingTime" };
    character.updateEmbeddedDocuments = (type, patches) => writeItems(type, patches.map(patch => filter(patch, paths[omitted])));
    await assert.rejects(migrateActorData(character), { code: "migration-write-not-persisted" });
    if (omitted === "actor list") assert.deepEqual(character.getFlag(LEGACY_MODULE_ID, LEGACY_FLAGS.LIST), conditions);
    if (omitted === "item notes") assert.equal(wound.getFlag(LEGACY_MODULE_ID, LEGACY_FLAGS.NOTES), "Treat tomorrow");
    assert.equal(parseHeatValue(heat), 4);
    assert.equal(heat.system.healingTime, "4");

    character.update = write;
    character.updateEmbeddedDocuments = writeItems;
    assert.equal(await migrateActorData(character), true);
    assert.equal(character.getFlag(scope, FLAGS.LIST)[0].id, "cold");
    assert.equal(wound.getFlag(scope, FLAGS.NOTES), "Treat tomorrow");
    assert.equal(character.getFlag(LEGACY_MODULE_ID, LEGACY_FLAGS.LIST), undefined);
    assert.equal(wound.getFlag(LEGACY_MODULE_ID, LEGACY_FLAGS.NOTES), undefined);
    assert.equal(heat.getFlag(scope, FLAGS.HEAT_VALUE), 4);
    assert.equal(heat.system.healingTime, "");
  });
}
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

test("a Calendaria day finishes its selected provider and rest actions before pausing for Addiction", async () => {
  reset();
  initializeNewDayProviderBridge();
  const addiction = item("addiction", { rollModifiers: {} }, "Addiction");
  const wound = item("wound", { healingTime: "3 days" });
  const character = actor([addiction, wound]);
  await saveAddictionState(addiction, { phase: "flat", die: 6, daysLeft: 1, severity: 1 });
  await setActorCalendarMarker(character, { ...context, date: start });
  await character.setFlag(scope, "shortRestRecovery", { quarterKey: "current", attribute: "strength" });
  let advances = 0;
  const unregister = registerNewDayProvider({
    id: "audit.endurance-day", category: "audit-timer",
    buildActions: () => [{ id: "tick" }],
    applyAction: () => { advances++; return { changed: true }; },
    describeAction: () => "",
    icon: () => "fa-clock"
  });
  try {
    const result = await calendar.processActorAutomaticDays(character, start, context, 2);
    assert.equal(result.processedDays, 1);
    assert.equal(result.limitedDays, 1);
    assert.equal(result.failedActions, 0);
    assert.equal(result.pendingManual, 1);
    assert.equal(advances, 1);
    assert.equal(wound.system.healingTime, "2 days");
    assert.equal(character.getFlag(scope, "shortRestRecovery"), null);
    assert.equal(getActorCalendarMarker(character).date.day, 2);
  } finally {
    unregister();
  }
});

for (const change of ["changed action", "removed provider"]) {
  test(`${change} leaves the day pending when no action was attempted`, async () => {
    reset();
    initializeNewDayProviderBridge();
    const character = actor();
    const date = { ...start, day: 2 };
    await setActorCalendarMarker(character, { ...context, date: start });
    let revision = 1;
    let builds = 0;
    const unregister = registerNewDayProvider({
      id: "audit.only-stale", category: "audit-timer",
      buildActions: () => {
        if (++builds === 2 && change === "removed provider") unregister();
        return [{ id: "tick", revision }];
      },
      applyAction: () => assert.fail("the stale action must not run"),
      describeAction: () => "", icon: () => "fa-clock"
    });
    try {
      const plan = await buildNewDayPlanWithProviders(character);
      revision++;
      const [id] = plan.actions.filter(action => action.providerId).map(action => action.id);
      await assert.rejects(calendar.applyCalendarDay(character, context, start, date, date, plan, [id]), { code: "stale-plan" });
      assert.deepEqual(getActorCalendarMarker(character).date, start);
      assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
    } finally {
      unregister();
    }
  });
}

test("Calendaria retains failed-action IDs until their history is persisted", async () => {
  reset();
  const date = { ...start, day: 2 };
  const wound = item("wound", { healingTime: "5 days" });
  const refused = item("refused", { healingTime: "5 days" });
  refused.update = async () => {};
  const character = actor([wound, refused]);
  await setActorCalendarMarker(character, { ...context, date: start });
  const plan = buildNewDayPlan(character);
  const ids = ["injury:wound:healing", "injury:refused:healing"];
  const write = character.update;
  character.update = patch => write(Object.fromEntries(Object.entries(patch).filter(([key]) => !key.endsWith("stateProgressionFailures"))));
  await assert.rejects(calendar.applyCalendarDay(character, context, start, date, date, plan, ids), { code: "write-not-persisted" });
  assert.deepEqual(getActorCalendarMarker(character).date, start);
  assert.equal(character.getFlag(scope, "stateProgressionOperation").phase, "applied");
  assert.deepEqual(character.getFlag(scope, "stateProgressionOperation").failures, [{ id: ids[1], kind: "action-apply" }]);
  assert.equal(wound.system.healingTime, "4 days");

  character.update = write;
  const recovered = await calendar.processActorAutomaticDays(character, start, context, 1);
  assert.equal(recovered.processedDays, 1);
  assert.deepEqual(getActorCalendarMarker(character).date, date);
  assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
  assert.deepEqual(character.getFlag(scope, "stateProgressionFailures")[0].failures, [{ id: ids[1], kind: "action-apply" }]);
  assert.equal(wound.system.healingTime, "4 days");
});

test("Calendaria rejects missing preview data and rechecks assignment after a queue wait", async () => {
  reset();
  const wound = item("wound", { healingTime: "5 days" });
  const character = assignedActor([wound]);
  const player = game.users.find(user => user.character === character);
  const previous = { ...start, day: 2 };
  await setActorCalendarMarker(character, { ...context, date: previous });
  const actionId = "injury:wound:healing";
  const payload = { actorId: character.id, calendarId: context.calendarId, targetDate: context.date, selectedIds: [actionId] };
  await assert.rejects(calendar.handleCalendariaApplyRequest(payload, { requestUser: player }), { code: "stale-plan" });
  const selection = { ...payload, selectedPreconditions: { [actionId]: buildNewDayPlan(character).preconditions[actionId] } };

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = calendar.enqueueStateProgressionOperation(character, () => {
    entered.resolve();
    return release.promise;
  });
  await entered.promise;
  const request = assert.rejects(calendar.handleCalendariaApplyRequest(selection, { requestUser: player }), { code: "actor-not-assigned" });
  player.character = actor();
  release.resolve();
  await Promise.all([request, blocker]);
  assert.deepEqual(getActorCalendarMarker(character).date, previous);
  assert.equal(wound.system.healingTime, "5 days");
});

test("a reset click from the previous calendar date refreshes the summary without moving the marker", async () => {
  reset();
  const character = assignedActor([]);
  await setActorCalendarMarker(character, { ...context, date: start });
  const shown = { context, entries: new Map([[character.id, { actor: character }]]) };
  CALENDARIA.api.getCurrentDateTime = () => ({ ...start, day: 2 });
  await calendar.resetActorFromGMSummary(shown, character.id);
  assert.deepEqual(getActorCalendarMarker(character).date, start);
});

test("an automatic day rechecks character assignment after saving its journal", async () => {
  reset();
  const wound = item("wound", { healingTime: "5 days" });
  const character = assignedActor([wound]);
  const owner = game.users.find(user => user.character === character);
  await setActorCalendarMarker(character, { ...context, date: start });
  const write = character.update;
  character.update = async patch => {
    await write(patch);
    if (patch[`flags.${scope}.==stateProgressionOperation`]?.phase === "applying") owner.character = actor();
  };
  await assert.rejects(calendar.processActorAutomaticDays(character, start, context, 1, { requireAssignment: true }),
    { code: "actor-not-assigned" });
  assert.equal(wound.system.healingTime, "5 days");
  assert.deepEqual(getActorCalendarMarker(character).date, start);
  assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
});

test("Calendaria rejects incomplete years and fractional rewinds without moving the marker", async () => {
  reset();
  const character = assignedActor();
  await setActorCalendarMarker(character, context);
  assert.equal(calendar.normalizeCalendariaDate({ ...start, year: null }), null);
  assert.equal(calendar.normalizeCalendariaDate({ ...start, year: 0 }).year, 0);
  await assert.rejects(calendar.rewindActorCalendarMarker(character, 1.9, { ...context, api: CALENDARIA.api }), RangeError);
  await assert.rejects(calendar.rewindAllCalendarMarkers(365.9, { ...context, api: CALENDARIA.api }), RangeError);
  assert.deepEqual(getActorCalendarMarker(character).date, context.date);
});

for (const interactive of [false, true]) {
  test(`Calendaria preserves the ${interactive ? "interactive" : "automatic"} day if Endurance starts while saving its journal`, async () => {
    reset();
    const addiction = item("addiction", { rollModifiers: {} }, "Addiction");
    const wound = item("wound", { healingTime: "3 days" });
    const character = assignedActor([addiction, wound]);
    await saveAddictionState(addiction, { phase: "flat", die: 6, daysLeft: 1, severity: 1 });
    const prior = { ...start, day: 2 };
    await setActorCalendarMarker(character, { ...context, date: prior });
    const write = character.update;
    character.update = async patch => {
      await write(patch);
      if (patch[`flags.${scope}.==stateProgressionOperation`]?.phase === "applying") {
        await performAddictionMorning(character, addiction, { postChat: false });
      }
    };

    if (interactive) {
      const actionId = "injury:wound:healing";
      const result = await calendar.handleCalendariaApplyRequest({
        actorId: character.id, calendarId: context.calendarId, targetDate: context.date, selectedIds: [actionId],
        selectedPreconditions: { [actionId]: buildNewDayPlan(character).preconditions[actionId] }
      }, { requestUser: game.user, requesterId: game.user.id });
      assert.equal(result.status, "awaiting-endurance");
      assert.equal(result.calendarResult.processedDays, 0);
      assert.equal(result.calendarResult.pendingManual, 1);
    } else {
      const result = await calendar.processActorAutomaticDays(character, prior, context, 1);
      assert.equal(result.processedDays, 0);
      assert.equal(result.failedDays, 0);
      assert.equal(result.pendingManual, 1);
    }
    assert.equal(getAddictionMorning(addiction).status, "pending");
    assert.equal(wound.system.healingTime, "3 days");
    assert.deepEqual(getActorCalendarMarker(character).date, prior);
    assert.equal(character.getFlag(scope, "stateProgressionOperation"), null);
  });
}
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

for (const reason of ["offer expires", "recipient loses ownership"]) {
  test(`accepted transfer leaves both wallets untouched if ${reason} while waiting for a character lock`, async () => {
    reset();
    const source = actor();
    const target = actor();
    source.system.currency.copper.value = 100;
    const sender = user("sender");
    const recipient = user("recipient");
    game.users.push(sender, recipient);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const blocker = enqueueActorMutationOperation(source, () => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const offer = {
        requestId: "audit-transfer", requesterId: sender.id, recipientUserId: recipient.id, primaryGmId: game.user.id,
        sourceActorId: source.id, targetActorId: target.id, amounts: { copper: 20 }, createdAt: now
      };
      const acceptance = money.processTransferDecision(offer, { ...offer, accepted: true });
      await delay(0);
      if (reason === "offer expires") now += 96_000;
      else target.testUserPermission = () => false;
      release.resolve();
      await blocker;
      await acceptance;
    } finally {
      Date.now = realNow;
    }
    assert.equal(source.system.currency.copper.value, 100);
    assert.equal(target.system.currency.copper.value, 0);
    assert.equal(source.updates.length + target.updates.length, 0);
  });
}
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

for (const blocked of ["counter write", "pending roll cleanup"]) {
  test(`Mor gain resumes after a vetoed ${blocked} without repeating damage or the roll`, async () => {
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
    mor.update = async patch => {
      if (blocked === "counter write" && Object.hasOwn(patch, `flags.${scope}.conditions.morState`)) return;
      if (blocked === "pending roll cleanup" && patch[`flags.${scope}.conditions.morPendingGain`] === null) return;
      return write(patch);
    };
    await assert.rejects(applyMorGain(character, mor), { code: "write-not-persisted" });
    assert.equal(character.system.attribute.strength.value, 3);
    assert.equal(getMorState(mor).current, blocked === "counter write" ? 1 : 2);

    const reloadedMor = item(mor.id, structuredClone(mor.system), "Mor");
    reloadedMor.flags = structuredClone(mor.flags);
    const reloadedActor = actor([reloadedMor]);
    reloadedActor.system = structuredClone(character.system);
    const result = await applyMorGain(reloadedActor, reloadedMor);
    assert.equal(result.state.current, 2);
    assert.equal(rolls, 1);
    assert.equal(reloadedActor.system.attribute.strength.value, 3);
    assert.equal(reloadedMor.getFlag(scope, "conditions.morPendingGain"), null);
  });
}

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
    if (Object.hasOwn(patch, "system.attribute.strength.value")) {
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

test("BIO uses the normalized shape of an unsaved whole-profile replacement", async () => {
  reset();
  const bio = await expose("scripts/biography.js", ["getBiographyDraft"]);
  const character = actor();
  bio.queueProfileSave(character, { background: "Notes" }, null, 10_000);
  bio.queueProfileSave(character, { family: "Family" }, null, 10_000, "family");
  try {
    const draft = bio.getBiographyDraft(character);
    assert.equal(draft.background, "Notes");
    assert.equal(draft.family, "Family");
    assert.ok(draft.questions && draft.identity && draft.legacy);
  } finally {
    await bio.flushBiographySaves(character);
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
  const edit = enqueueActorMutationOperation(character, async () => {
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

  const reloaded = actor();
  reloaded.flags = structuredClone(character.flags);
  reloaded.system = structuredClone(character.system);
  const resumed = await rest.applyRest(null, reloaded, { type: "short" });
  assert.equal(resumed.failed, undefined);
  assert.equal(reloaded.system.attribute.agility.value, 2);
  assert.equal(reloaded.getFlag(scope, "shortRestRecovery").attribute, "agility");
  assert.equal(reloaded.getFlag(scope, "pendingShortRest"), null);
});

test("Short Rest can finish an omitted attribute write when the quarter is already marked", async () => {
  reset();
  const character = actor();
  const write = character.update;
  const strength = "system.attribute.strength.value";
  character.update = async patch => {
    const filtered = { ...patch };
    delete filtered[strength];
    return write(filtered);
  };
  const first = await rest.applyRest(null, character, { type: "short", useShortRecovery: true, shortAttribute: "strength" });
  assert.equal(first.error?.code, "write-not-persisted");
  assert.equal(character.system.attribute.strength.value, 1);
  const used = structuredClone(character.getFlag(scope, "shortRestRecovery"));
  assert.equal(used.attribute, "strength");

  character.update = write;
  const retry = await rest.applyRest(null, character, { type: "short" });
  assert.equal(retry.failed, undefined);
  assert.equal(character.system.attribute.strength.value, 2);
  assert.deepEqual(character.getFlag(scope, "shortRestRecovery"), used);
  assert.equal(character.getFlag(scope, "pendingShortRest"), null);
});

test("Short Rest leaves the attribute untouched when its recovery plan cannot be saved", async () => {
  reset();
  const character = actor();
  const write = character.update;
  character.update = async patch => {
    if (Object.keys(patch).some(path => path.endsWith("pendingShortRest"))) return;
    return write(patch);
  };
  const result = await rest.applyRest(null, character, { type: "short", useShortRecovery: true, shortAttribute: "strength" });
  assert.equal(result.error?.code, "write-not-persisted");
  assert.equal(character.system.attribute.strength.value, 1);
  assert.equal(character.getFlag(scope, "shortRestRecovery"), undefined);
});

test("Long Rest records its recovery before changing any attribute", async () => {
  reset();
  const character = actor();
  const write = character.update;
  character.update = patch => write(Object.fromEntries(Object.entries(patch).filter(([key]) => !key.endsWith("pendingRestCleanup"))));
  const result = await rest.applyRest(null, character, { type: "long" });
  assert.equal(result.error?.code, "write-not-persisted");
  assert.equal(character.system.attribute.strength.value, 1);
  character.update = write;
  const retry = await rest.applyRest(null, character, { type: "long" });
  assert.equal(retry.failed, undefined);
  assert.equal(character.system.attribute.strength.value, 2);
});

test("Long Rest completes when cleanup saved successfully but its response rejected", async () => {
  reset();
  const character = actor();
  const write = character.update;
  character.update = async patch => {
    await write(patch);
    if (patch[`flags.${scope}.pendingRestCleanup`] === null) throw new Error("Late cleanup error");
  };
  assert.equal((await rest.applyRest(null, character, { type: "long" })).failed, undefined);
  assert.equal(character.system.attribute.strength.value, 2);
  assert.equal(character.getFlag(scope, "pendingRestCleanup"), null);
});

for (const type of ["short", "long"]) {
  test(`an interrupted ${type} rest must finish before a different rest starts`, async () => {
    reset();
    const character = actor();
    const flag = type === "short" ? "pendingShortRest" : "pendingRestCleanup";
    const write = character.update;
    character.update = patch => patch[`flags.${scope}.${flag}`] === null ? undefined : write(patch);
    const options = { type, useShortRecovery: type === "short", shortAttribute: "strength" };
    assert.equal((await rest.applyRest(null, character, options)).error?.code, "write-not-persisted");
    assert.equal(character.system.attribute.strength.value, 2);

    character.update = write;
    const blocked = await rest.applyRest(null, character, { type: type === "short" ? "long" : "short" });
    assert.equal(blocked.error?.code, "rest-pending");
    assert.equal(character.system.attribute.strength.value, 2);
    assert.equal((await rest.applyRest(null, character, options)).failed, undefined);
    assert.equal(character.system.attribute.strength.value, 2);
    assert.equal(character.getFlag(scope, flag), null);
  });
}

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
    character.name = `Character ${index + 1}`;
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
  assert.equal(getBiographyProfile(a).physical.hair, "red");
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
