import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getAddictionMorning, getAddictionDayKey, performAddictionMorning,
  processAddictionNewDay, processAddictionNewDayInternal, resolveAddictionMorning, relapseAddiction, handleAddictionOperation, correctAddictionState
} from "../scripts/conditions/services/addiction-service.js";
import { applyHeatFailure, changeMor, getAddictionState, getMorState, parseHeatValue, saveAddictionState, updateHeatItem } from "../scripts/conditions/features/special-counters.js";
import { transitionWashLevel } from "../scripts/conditions/features/wash.js";
import { applyStatOperation, runStatOperation } from "../scripts/conditions/services/stat-operations.js";
import { enqueueActorMutation } from "../scripts/operation-queue.js";
import { LEGACY_MODULE_ID, MIGRATION_VERSION } from "../scripts/conditions/constants.js";
import { applyNewDayPlan, buildNewDayPlan, decrementFirstInteger, serializeNewDayResult } from "../scripts/new-day.js";
import { migrateActorData, runWorldMigration } from "../scripts/conditions/migrations.js";
import { renderConditionItemRow } from "../scripts/conditions/render/stat-tab-renderer.js";

const scope = "fbl-quick-access";
let id = 0;
const get = (object, path) => path.split(".").reduce((entry, key) => entry?.[key], object);
function set(object, path, value) {
  const keys = path.split(".");
  const leaf = keys.pop();
  const parent = keys.reduce((entry, key) => entry[key] ??= {}, object);
  if (leaf.startsWith("-=")) delete parent[leaf.slice(2)];
  else parent[leaf] = structuredClone(value);
}

function setup(totals = []) {
  const rolls = [];
  globalThis.foundry = { utils: { getProperty: get, deepClone: structuredClone,
    mergeObject: (base, patch) => ({ ...base, ...patch }), randomID: () => `workflow${String(++id).padStart(20, "0")}` } };
  globalThis.game = { user: { id: "gm", isGM: true }, modules: new Map(),
    settings: { get: (_scope, key) => key === "stateProgressionMode" ? "long-rest" : true },
    i18n: { localize: key => key, format: key => key } };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => null };
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; rolls.push(formula); }
    async evaluate() { assert.ok(totals.length, "Unexpected automatic roll"); this.total = totals.shift(); return this; }
    async toMessage() { return null; }
  };
  delete globalThis.CALENDARIA;
  return rolls;
}

function item(name, state = null) {
  const result = { id: `item${++id}`, type: "criticalInjury", name, flags: {}, system: { healingTime: "", rollModifiers: {} }, updates: [],
    getFlag(module, key) { return get(this.flags[module], key); },
    async update(data) { this.updates.push(data); for (const [path, value] of Object.entries(data)) set(this, path, value); },
    async delete() { this.parent.items.delete(this.id); } };
  if (state) set(result, `flags.${scope}.conditions.addictionState`, state);
  return result;
}

function actor(...items) {
  const result = { id: `actor${++id}`, name: "Tester", type: "character", documentName: "Actor", flags: {}, items: new Map(items.map(entry => [entry.id, entry])),
    system: { attribute: Object.fromEntries(["strength", "agility", "wits", "empathy"].map(key => [key, { value: 6, max: 6 }])) },
    getFlag(module, key) { return get(this.flags[module], key); },
    async setFlag(module, key, value) { set(this, `flags.${module}.${key}`, value); },
    async update(data) { for (const [path, value] of Object.entries(data)) set(this, path, value); },
    async updateEmbeddedDocuments(_type, updates) { for (const data of updates) await this.items.get(data._id).update(data); } };
  result.testUserPermission = user => user.id === "owner";
  for (const entry of items) entry.parent = result;
  return result;
}
const decline = () => ({ phase: "down", die: 12, daysLeft: 0, severity: 5 });
const quiet = { postChat: false, notify: false };

test("manual Addiction +/- can move both ways across decline, withdrawal and recovery without rolls", async () => {
  const rolls = setup(); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  for (const die of [10, 8, 6]) {
    await correctAddictionState(owner, dependency, { delta: 1 });
    assert.equal(getAddictionState(dependency).die, die);
  }
  await correctAddictionState(owner, dependency, { delta: 1 });
  assert.equal(getAddictionState(dependency).phase, "flat");
  assert.equal(getAddictionState(dependency).daysLeft, 5);
  for (let day = 0; day < 5; day++) await correctAddictionState(owner, dependency, { delta: 1 });
  assert.equal(getAddictionState(dependency).phase, "up");
  await correctAddictionState(owner, dependency, { delta: -1 });
  assert.equal(getAddictionState(dependency).daysLeft, 1);
  for (let day = 0; day < 5; day++) await correctAddictionState(owner, dependency, { delta: -1 });
  assert.equal(getAddictionState(dependency).phase, "down");
  assert.equal(getAddictionState(dependency).die, 6);
  await correctAddictionState(owner, dependency, { delta: -1 });
  assert.equal(getAddictionState(dependency).die, 8);
  assert.deepEqual(rolls, []);
});

test("manual Addiction correction resolves a pending morning and synchronizes modifiers atomically", async () => {
  setup([1]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  await performAddictionMorning(owner, dependency, quiet);
  const pending = getAddictionMorning(dependency);
  const state = { phase: "flat", die: 6, daysLeft: 3, severity: 10 };
  const result = await correctAddictionState(owner, dependency, { state });
  assert.equal(result.changed, true); assert.deepEqual(getAddictionState(dependency), state);
  assert.equal(getAddictionMorning(dependency).id, pending.id);
  assert.equal(getAddictionMorning(dependency).status, "resolved");
  assert.equal(getAddictionMorning(dependency).outcome, "manual");
  assert.equal(dependency.system.rollModifiers.fblecAddictionStrength.value, "-3");
  const duplicate = await resolveAddictionMorning(owner, dependency, "success", quiet);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(getAddictionState(dependency), state);
});

test("changing Addiction severity from 5 to 10 preserves elapsed withdrawal days", async () => {
  setup();
  const dependency = item("Addiction", { phase: "flat", die: 6, daysLeft: 3, severity: 5 });
  const owner = actor(dependency);
  assert.equal((await correctAddictionState(owner, dependency, { severity: 10 })).changed, true);
  assert.deepEqual(getAddictionState(dependency), { phase: "flat", die: 6, daysLeft: 8, severity: 10 });
  assert.equal(dependency.updates.length, 1);
});

test("manual Addiction corrections clamp cycle endpoints without deleting the Item", async () => {
  setup(); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  assert.equal((await correctAddictionState(owner, dependency, { delta: -1 })).changed, false);
  await correctAddictionState(owner, dependency, { state: { ...decline(), phase: "up" } });
  assert.equal((await correctAddictionState(owner, dependency, { delta: 1 })).changed, false);
  assert.equal(owner.items.get(dependency.id), dependency);
});

test("manual Addiction editor rejects invalid states before any document writes", async () => {
  setup(); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  for (const patch of [{ phase: "unknown" }, { die: 20 }, { severity: 20 }, { phase: "flat", daysLeft: 0 }, { phase: "flat", daysLeft: -1 }]) {
    await assert.rejects(correctAddictionState(owner, dependency, { state: { ...decline(), ...patch } }), TypeError);
  }
  assert.equal(dependency.updates.length, 0);
});

test("GM-authoritative manual Addiction corrections require ownership and editable STAT", async () => {
  setup(); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  game.actors = new Map([[owner.id, owner]]);
  const payload = { actorId: owner.id, itemId: dependency.id, kind: "adjust", options: { delta: 1 } };
  await assert.rejects(handleAddictionOperation(payload, { requestUser: { id: "outsider" } }), /ownership/);
  await handleAddictionOperation(payload, { requestUser: { id: "owner" } });
  assert.equal(getAddictionState(dependency).die, 10);
  game.settings.get = (_scope, key) => key !== "playersCanEdit";
  await assert.rejects(handleAddictionOperation(payload, { requestUser: { id: "owner" } }), /disabled/);
  assert.equal(getAddictionState(dependency).die, 10);
});

test("STAT and New Day share one controlled morning even when world time does not move", async () => {
  const rolls = setup([4]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  const stat = await performAddictionMorning(owner, dependency, quiet);
  assert.equal(stat.advanced, true);
  const plan = buildNewDayPlan(owner);
  const applied = await applyNewDayPlan(owner, plan, [plan.actions.find(entry => entry.kind === "addiction-day").id], quiet);
  assert.equal(applied.failed.length, 0);
  assert.match(applied.succeeded[0].summary, /already processed/);
  assert.equal(getAddictionState(dependency).die, 10);
  assert.deepEqual(rolls, ["1d12"]);
  assert.equal(owner.getFlag(scope, "conditions.addictionDay"), 1);
  assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
  const next = buildNewDayPlan(owner).actions.find(entry => entry.kind === "addiction-day");
  assert.equal(next.dayKey, "manual:2");
});

for (const total of [1, 2]) test(`craving ${total} remains pending after retries and across a later day`, async () => {
  const rolls = setup([total]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  let day = 2;
  game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "calendaria" : true;
  globalThis.CALENDARIA = { api: { getCurrentDateTime: () => ({ year: 1, month: 1, day }), getActiveCalendar: () => ({ id: "test" }) } };
  const first = await processAddictionNewDay(owner, dependency, { ...quiet, dayKey: "calendar:test:1:1:2" });
  day = 3;
  const again = await processAddictionNewDay(owner, dependency, { ...quiet, dayKey: "calendar:test:1:1:3" });
  assert.equal(first.pending, true); assert.equal(first.advanced, false);
  assert.equal(again.reused, true); assert.equal(again.dayKey, first.dayKey);
  assert.deepEqual(getAddictionState(dependency), decline());
  assert.deepEqual(rolls, ["1d12"]);
});

test("simultaneous morning requests roll once and retain the pending result", async () => {
  const rolls = setup([2]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  const results = await Promise.all([performAddictionMorning(owner, dependency, quiet), processAddictionNewDay(owner, dependency, quiet)]);
  assert.deepEqual(rolls, ["1d12"]); assert.equal(results.filter(result => result.reused).length, 1);
  assert.equal(getAddictionMorning(dependency).status, "pending");
});

test("a committed New Day survives failure of the Actor's day counter", async () => {
  const rolls = setup([4]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  owner.update = async () => { throw new Error("Actor unavailable"); };
  await assert.rejects(processAddictionNewDay(owner, dependency, quiet), {
    code: "condition-partial-failure", message: /morning was saved on the Item.*Actor day 1 is unconfirmed/
  });
  assert.equal(getAddictionState(dependency).die, 10);
  assert.equal(getAddictionDayKey(owner), "manual:1");
  assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
  assert.equal(buildNewDayPlan(owner).actions.find(entry => entry.kind === "addiction-day").dayKey, "manual:2");
  assert.equal(rolls.length, 1);
});

for (const cured of [false, true]) test(`New Day stops if the Actor's day fails after Addiction ${cured ? "cure" : "update"}`, async t => {
  const rolls = setup([4]);
  t.mock.method(console, "error", () => {});
  const first = item("Addiction A", { ...decline(), phase: cured ? "up" : "down" });
  const second = item("Addiction B", decline());
  const owner = actor(first, second);
  await owner.setFlag(scope, "shortRestRecovery", { quarterKey: "manual" });
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  owner.update = async data => {
    assert.deepEqual(Object.keys(data), [`flags.${scope}.conditions.addictionDay`]);
    throw new Error("Actor day vetoed");
  };
  const plan = buildNewDayPlan(owner);
  const result = await applyNewDayPlan(owner, plan, plan.actions.map(action => action.id), { postChat: false });
  assert.equal(result.partiallyApplied, true);
  assert.equal(result.failed[0].code, "condition-partial-failure");
  assert.equal(owner.items.has(first.id), !cured);
  if (!cured) assert.equal(getAddictionMorning(first).dayKey, "manual:1");
  assert.ok(owner.getFlag(scope, "shortRestRecovery"));
  assert.equal(second.updates.length, 0);
  assert.equal(rolls.length, 1);
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /Addiction A.*Actor day 1 is unconfirmed/);
  assert.match(messages[0].content, cured ? /recovery removed the Item/ : /morning was saved on the Item/);
});

test("an offline-GM Addiction operation rejects a stale explicit day before rolling or writing", async () => {
  const rolls = setup();
  const dependency = item("Addiction", decline());
  const owner = actor(dependency);
  owner.isOwner = true;
  game.user = { id: "owner", active: true };
  game.users = [game.user];
  await owner.setFlag(scope, "conditions.addictionDay", 2);
  await assert.rejects(processAddictionNewDay(owner, dependency, { ...quiet, dayKey: "manual:1" }), { code: "stale-plan" });
  assert.deepEqual(rolls, []);
  assert.deepEqual(dependency.updates, []);
});

test("the final withdrawal day keeps its severe modifiers until manual success", async () => {
  const rolls = setup(); const state = { phase: "flat", die: 6, daysLeft: 1, severity: 10 };
  const dependency = item("Зависимость", state); const owner = actor(dependency);
  await saveAddictionState(dependency, state);
  const morning = await processAddictionNewDay(owner, dependency, quiet);
  assert.equal(morning.pending, true); assert.deepEqual(rolls, []);
  assert.equal(getAddictionState(dependency).daysLeft, 1);
  assert.equal(dependency.system.rollModifiers.fblecAddictionStrength.value, "-4");
  assert.equal(dependency.system.rollModifiers.fblecAddictionWits.value, "-4");
  globalThis.TextEditor = { enrichHTML: async text => text }; globalThis.renderTemplate = async (_path, data) => data;
  const displayed = await renderConditionItemRow(dependency, true);
  assert.match(displayed.modifierText, /Strength: -4/); assert.match(displayed.modifierText, /Wits: -4/);
  delete globalThis.TextEditor; delete globalThis.renderTemplate;
  await resolveAddictionMorning(owner, dependency, "success", { ...quiet, morningId: morning.morningId });
  assert.equal(getAddictionState(dependency).phase, "up");
  assert.equal(dependency.system.rollModifiers.fblecAddictionStrength.value, "-1");
  assert.equal(dependency.system.rollModifiers.fblecAddictionWits, undefined);
});

for (const [outcome, expected] of [["success", 8], ["failure-no-dose", 8], ["failure-dose", 12]]) {
  test(`${outcome} applies the agreed cycle rule once`, async () => {
    setup([2]); const dependency = item("Зависимость", { ...decline(), die: 10 }); const owner = actor(dependency);
    const morning = await performAddictionMorning(owner, dependency, quiet);
    const stale = await resolveAddictionMorning(owner, dependency, outcome, { ...quiet, morningId: "old-morning" });
    assert.equal(stale.changed, false);
    const done = await resolveAddictionMorning(owner, dependency, outcome, { ...quiet, morningId: morning.morningId });
    assert.equal(done.changed, true); assert.equal(getAddictionState(dependency).die, expected);
    assert.equal(getAddictionMorning(dependency).status, "resolved");
    assert.equal((await resolveAddictionMorning(owner, dependency, outcome, quiet)).changed, false);
    assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
    const update = dependency.updates.at(-1);
    assert.ok(update[`flags.${scope}.conditions.addictionState`]);
    assert.equal(update[`flags.${scope}.conditions.addictionMorning`].outcome, outcome);
  });
}

test("failure without a dose can cure the final recovery step", async () => {
  setup([1]); const dependency = item("Зависимость", { ...decline(), phase: "up" }); const owner = actor(dependency);
  await performAddictionMorning(owner, dependency, quiet);
  const result = await resolveAddictionMorning(owner, dependency, "failure-no-dose", quiet);
  assert.equal(result.cured, true); assert.equal(owner.items.has(dependency.id), false);
});

test("simultaneous controlled mornings stop after the first cures and deletes the Item", async () => {
  const rolls = setup([4]); const dependency = item("Зависимость", { ...decline(), phase: "up" }); const owner = actor(dependency);
  const results = await Promise.all([performAddictionMorning(owner, dependency, quiet), performAddictionMorning(owner, dependency, quiet)]);
  assert.equal(results.filter(result => result.cured).length, 1);
  assert.equal(results.filter(result => result.skipped).length, 1);
  assert.equal(owner.items.has(dependency.id), false); assert.equal(rolls.length, 1);
});

test("simultaneous manual outcomes cannot resolve a cured Item twice", async () => {
  setup([1]); const dependency = item("Зависимость", { ...decline(), phase: "up" }); const owner = actor(dependency);
  await performAddictionMorning(owner, dependency, quiet);
  const results = await Promise.all([resolveAddictionMorning(owner, dependency, "success", quiet), resolveAddictionMorning(owner, dependency, "success", quiet)]);
  assert.equal(results.filter(result => result.cured).length, 1);
  assert.equal(results.filter(result => result.skipped).length, 1);
});

test("taking a dose outside a pending check resets the cycle without allowing another morning", async () => {
  const rolls = setup([4]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  await performAddictionMorning(owner, dependency, quiet);
  await relapseAddiction(owner, dependency, quiet);
  assert.equal(getAddictionState(dependency).die, 12);
  assert.equal(getAddictionMorning(dependency).outcome, "dose");
  assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
  assert.equal(rolls.length, 1);
});

test("a failed chat message cannot reroll or advance a committed morning again", async () => {
  const rolls = setup([4]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  globalThis.Roll.prototype.toMessage = async () => { throw new Error("chat offline"); };
  const original = console.error; console.error = () => {};
  try { await performAddictionMorning(owner, dependency); } finally { console.error = original; }
  assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
  assert.equal(rolls.length, 1); assert.equal(getAddictionState(dependency).die, 10);
});

test("a pending morning blocks other daily timers and stays visible in the serialized result", async () => {
  setup([2]); const dependency = item("Зависимость", decline()); const wound = item("Wound"); wound.system.healingTime = "3 days";
  const owner = actor(dependency, wound); const plan = buildNewDayPlan(owner);
  const first = await applyNewDayPlan(owner, plan, plan.actions.map(entry => entry.id), quiet);
  assert.equal(wound.system.healingTime, "2 days");
  assert.equal(first.pending.length, 1);
  const serialized = serializeNewDayResult(first);
  assert.equal(serialized.pendingCount, 1);
  assert.match(serialized.entries.find(entry => entry.pending).detail, /Endurance/);
  const blocked = buildNewDayPlan(owner);
  assert.equal(blocked.blockedByAddiction, true);
  assert.deepEqual(blocked.actions.map(entry => entry.kind), ["addiction-day"]);
  await applyNewDayPlan(owner, blocked, blocked.actions.map(entry => entry.id), quiet);
  assert.equal(wound.system.healingTime, "2 days");
  await resolveAddictionMorning(owner, dependency, "failure-no-dose", quiet);
  assert.equal(buildNewDayPlan(owner).blockedByAddiction, false);
});

let progression;
async function calendarWorker() {
  if (!progression) {
    const url = new URL("../scripts/state-progression.js", import.meta.url);
    let source = await readFile(url, "utf8");
    source = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
    source += "\nexport { processActorAutomaticDays };\n";
    progression = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }
  return progression;
}

test("a calendar skip consumes only the started day and resumes after its manual outcome", async () => {
  const rolls = setup();
  const start = { year: 1, month: 1, day: 1 }; const context = { calendarId: "test", date: { ...start, day: 4 } };
  globalThis.CALENDARIA = { api: { daysBetween: (from, to) => to.day - from.day, addDays: (date, n) => ({ ...date, day: date.day + n }),
    getCurrentDateTime: () => context.date, getActiveCalendar: () => ({ id: context.calendarId }) } };
  const dependency = item("Зависимость", { phase: "flat", die: 6, daysLeft: 3, severity: 5 });
  const wound = item("Wound"); wound.system.healingTime = "6 days";
  const owner = actor(dependency, wound); const worker = await calendarWorker();
  game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "calendaria" : true;
  game.user.active = true;
  game.users = [game.user, { id: "owner", active: true, character: owner }];
  game.actors = new Map([[owner.id, owner]]);
  await owner.setFlag(scope, "stateProgressionCalendaria", { calendarId: "test", date: start });
  const first = await worker.processActorAutomaticDays(owner.id, context, 3);
  assert.equal(first.processedDays, 1); assert.equal(first.limitedDays, 2); assert.equal(first.pendingManual, 1);
  assert.equal(getAddictionState(dependency).daysLeft, 3); assert.equal(wound.system.healingTime, "5 days");
  assert.equal(getAddictionMorning(dependency).dayKey, "calendar:test:1:1:2");
  const retry = await worker.processActorAutomaticDays(owner.id, context, 3);
  assert.equal(retry.processedDays, 0); assert.equal(wound.system.healingTime, "5 days");
  await resolveAddictionMorning(owner, dependency, "failure-no-dose", quiet);
  const resumed = await worker.processActorAutomaticDays(owner.id, context, 3);
  assert.equal(resumed.processedDays, 1); assert.equal(resumed.limitedDays, 1);
  assert.equal(wound.system.healingTime, "4 days"); assert.equal(getAddictionState(dependency).daysLeft, 2);
  assert.equal(getAddictionMorning(dependency).dayKey, "calendar:test:1:1:3");
  assert.deepEqual(rolls, []);
});

test("calendar STAT uses the same public day key as the daily plan", () => {
  setup(); game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "calendaria" : true;
  globalThis.CALENDARIA = { api: { getCurrentDateTime: () => ({ year: 2, month: 3, day: 4 }), getActiveCalendar: () => ({ metadata: { id: "test" } }) } };
  assert.equal(getAddictionDayKey(actor()), "calendar:test:2:3:4");
});

test("GM authority rejects another player's Actor and a fabricated morning date", async () => {
  const rolls = setup([2]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  game.actors = new Map([[owner.id, owner]]);
  const payload = { actorId: owner.id, itemId: dependency.id, kind: "morning", options: { postChat: false, notify: false } };
  await assert.rejects(handleAddictionOperation(payload, { requestUser: { id: "stranger", active: true } }), /ownership/);
  await assert.rejects(handleAddictionOperation({ ...payload, options: { ...payload.options, dayKey: "manual:999" } }, { requestUser: { id: "owner", active: true } }), /day changed/);
  assert.deepEqual(rolls, []); assert.equal(dependency.updates.length, 0);
  const result = await handleAddictionOperation(payload, { requestUser: { id: "owner", active: true } });
  assert.equal(result.pending, true); assert.equal(result.roll, null);
});

test("a remote final outcome cannot bypass disabled STAT editing with a New Day flag", async () => {
  setup([2]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  await performAddictionMorning(owner, dependency, quiet);
  game.actors = new Map([[owner.id, owner]]);
  game.settings.get = (_scope, key) => key === "playersCanEdit" ? false : key === "stateProgressionMode" ? "long-rest" : true;
  const payload = { actorId: owner.id, itemId: dependency.id, kind: "resolve", outcome: "success", options: { newDay: true } };
  await assert.rejects(handleAddictionOperation(payload, { requestUser: { id: "owner", active: true } }), /disabled/);
  assert.equal(getAddictionMorning(dependency).status, "pending");
});

test("two separate GM Addiction actions can use the same manual morning", async () => {
  const rolls = setup([3, 4]);
  const first = item("Addiction A", decline()), second = item("Addiction B", decline());
  const owner = actor(first, second);
  game.actors = new Map([[owner.id, owner]]);
  const options = { ...quiet, newDay: true, dayKey: getAddictionDayKey(owner, { newDay: true }) };
  const context = { requestUser: { id: "owner", active: true } };
  const results = await Promise.all([first, second].map(entry => handleAddictionOperation({
    actorId: owner.id, itemId: entry.id, kind: "morning", options
  }, context)));
  assert.deepEqual(results.map(result => result.dayKey), [options.dayKey, options.dayKey]);
  assert.deepEqual([first, second].map(entry => getAddictionState(entry).die), [10, 10]);
  assert.equal(owner.getFlag(scope, "conditions.addictionDay"), 1);
  assert.deepEqual(rolls, ["1d12", "1d12"]);
});

test("Calendaria addiction refuses manual:1 fallback while keeping STAT row rendering safe", async () => {
  const rolls = setup([4]);
  const dependency = item("Зависимость", decline());
  const owner = actor(dependency);
  game.settings.get = (_scope, key) => key === "stateProgressionMode" ? "calendaria" : true;
  globalThis.CALENDARIA = { api: { getCurrentDateTime: () => ({ year: 2, month: 3, day: 4 }), getActiveCalendar: () => ({ id: "test" }) } };
  await performAddictionMorning(owner, dependency, quiet);
  CALENDARIA.api.getCurrentDateTime = () => { throw new Error("calendar unavailable"); };

  await assert.rejects(performAddictionMorning(owner, dependency, quiet), { code: "calendaria-date-unavailable" });
  assert.deepEqual(rolls, ["1d12"]);
  assert.equal(getAddictionDayKey(owner, { allowMissingCalendar: true }), null);

  globalThis.TextEditor = { enrichHTML: async text => text };
  globalThis.renderTemplate = async (_path, data) => data;
  try {
    const row = await renderConditionItemRow(dependency, true);
    assert.equal(row.morningDisabled, true);
  } finally {
    delete globalThis.renderTemplate;
    delete globalThis.TextEditor;
  }
});

test("reusing a STAT morning in New Day reports changed when persisting startedByNewDay or day counter", async t => {
  setup([4, 4]);
  t.mock.method(console, "error", () => {});
  const first = item("Addiction A", decline());
  const second = item("Addiction B", decline());
  const owner = actor(first, second);
  await performAddictionMorning(owner, first, quiet);

  const originalUpdate = second.update.bind(second);
  second.update = async (data, opts) => {
    if (data[`flags.${scope}.conditions.addictionMorning`]) throw new Error("second failed");
    return originalUpdate(data, opts);
  };

  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  const plan = buildNewDayPlan(owner);
  const selected = plan.actions.filter(action => action.kind === "addiction-day").map(action => action.id);
  const partial = await applyNewDayPlan(owner, plan, selected, { postChat: false, notify: false });
  assert.equal(partial.partiallyApplied, true);
  assert.deepEqual(partial.succeeded.map(entry => entry.action.itemId), [first.id]);
  assert.deepEqual(partial.failed.map(entry => entry.action.itemId), [second.id]);
  assert.match(messages[0]?.content ?? "", /Addiction A/);

  const noop = await processAddictionNewDayInternal(owner, first, { ...quiet, dayKey: "manual:1" });
  assert.equal(noop.reused, true);
  assert.equal(noop.changed, false);
});

for (const [level, expected] of [[0, {}], [1, {}], [2, { strength: 1 }], [3, { strength: 1, wits: 1 }], [4, { strength: 1, wits: 1, agility: 1 }]]) {
  test(`final Endurance failure at Heat ${level} applies the correct level and damage`, async () => {
    setup(); const heat = item("Жара"); set(heat, `flags.${scope}.conditions.heatValue`, level); const owner = actor(heat);
    const result = await applyHeatFailure(owner, heat);
    assert.equal(parseHeatValue(heat), Math.min(4, level + 1));
    assert.deepEqual(Object.fromEntries(result.appliedDamage.map(entry => [entry.attribute, entry.amount])), expected);
    assert.equal(Boolean(heat.system.rollModifiers.fblecHeatEndurance), level >= 3);
    assert.equal(Boolean(heat.system.rollModifiers.fblecHeatMove), level >= 3);
    if (level >= 3) assert.deepEqual(heat.system.rollModifiers.fblecHeatEndurance, { name: "SKILL.ENDURANCE", value: "-1" });
  });
}

test("manual Heat correction and cooling never damage or heal attributes, and preserve other modifiers", async () => {
  setup(); const heat = item("Жара"); heat.system.rollModifiers.custom = { name: "SKILL.MOVE", value: "2" }; const owner = actor(heat);
  await updateHeatItem(owner, heat, 4, "manual");
  assert.equal(owner.system.attribute.strength.value, 6);
  assert.equal(heat.system.rollModifiers.fblecHeatEndurance.value, "-1");
  await updateHeatItem(owner, heat, 3, "rest");
  assert.equal(heat.system.rollModifiers.fblecHeatEndurance, undefined);
  assert.equal(heat.system.rollModifiers.fblecHeatMove, undefined);
  assert.equal(heat.system.rollModifiers.custom.value, "2");
  assert.equal(owner.system.attribute.strength.value, 6);
  await updateHeatItem(owner, heat, 4, "manual");
  const maximumCorrection = await updateHeatItem(owner, heat, 5, "manual");
  assert.equal(maximumCorrection.changed, false);
  await applyHeatFailure(owner, heat);
  const values = structuredClone(owner.system.attribute);
  await updateHeatItem(owner, heat, 0, "rest");
  assert.deepEqual(owner.system.attribute, values);
});

test("a partial Heat failure returns the committed damage and whispers to an offline GM", async () => {
  setup();
  game.user = { id: "owner", isGM: false, active: true };
  game.users = [game.user, { id: "gm", isGM: true, active: false }];
  game.socket = { connected: true };
  const heat = item("Heat"), owner = actor(heat);
  owner.isOwner = true;
  set(heat, `flags.${scope}.conditions.heatValue`, 3);
  heat.update = async () => { throw new Error("Heat write failed"); };
  const whispers = [];
  ChatMessage.create = async data => { whispers.push(data); };

  await assert.rejects(applyHeatFailure(owner, heat, { render: false }), error => {
    assert.equal(error.code, "condition-partial-failure");
    assert.deepEqual(error.appliedDamage.map(({ path, value }) => [path, value]), [
      ["system.attribute.strength.value", 5], ["system.attribute.wits.value", 5]
    ]);
    return true;
  });
  assert.equal(owner.system.attribute.strength.value, 5);
  assert.equal(owner.system.attribute.wits.value, 5);
  assert.equal(parseHeatValue(heat), 3);
  assert.deepEqual(whispers.map(({ whisper }) => whisper), [["gm"]]);
});

for (const failure of ["chat", "Mor write"]) {
  test(`Mor applies damage and writes the counter before chat even when ${failure} fails`, { timeout: 1_000 }, async t => {
    setup();
    t.mock.method(console, "error", () => {});
    const mor = item("Mor");
    const owner = actor(mor);
    const steps = [], whispers = [], notices = [];
    let releaseChat;
    const chat = new Promise(resolve => { releaseChat = resolve; });
    const updateActor = owner.update.bind(owner), updateItem = mor.update.bind(mor);
    owner.update = async patch => { steps.push("damage"); await updateActor(patch); };
    mor.update = async patch => {
      steps.push("Mor");
      if (failure !== "Mor write") await updateItem(patch);
    };
    ui.notifications.error = message => notices.push(message);
    ChatMessage.create = async message => { steps.push("whisper"); whispers.push(message); };
    globalThis.Roll = class {
      async evaluate() { this.terms = [{ results: [{ result: 1 }] }]; return this; }
      async toMessage() { steps.push("roll chat"); await chat; throw new Error("chat is unavailable"); }
    };

    const change = changeMor(owner, mor, "current", 1);
    if (failure === "Mor write") {
      await assert.rejects(change, { code: "condition-partial-failure" });
      assert.deepEqual(steps, ["damage", "Mor", "whisper"]);
      assert.equal(getMorState(mor).current, 0);
      assert.deepEqual(whispers[0].whisper, [game.user.id]);
      assert.match(notices[0], /Tester.*Mor.*strength 6 → 5.*check the sheet manually/i);
    } else {
      assert.equal((await change).changed, true);
      assert.deepEqual(steps, ["damage", "Mor", "roll chat"]);
      assert.equal(getMorState(mor).current, 1);
      assert.equal(await enqueueActorMutation(owner, () => "ready"), "ready");
    }
    assert.equal(owner.system.attribute.strength.value, 5);
    releaseChat();
    await new Promise(resolve => setImmediate(resolve));
  });
}

test("Mor reports an unknown outcome if the socket drops after verified damage", { timeout: 1_000 }, async () => {
  setup();
  const mor = item("Mor"), owner = actor(mor);
  const listeners = new Set(), notices = [];
  game.socket = { connected: true,
    on(_event, handle) { listeners.add(handle); }, off(_event, handle) { listeners.delete(handle); }
  };
  ui.notifications.error = text => notices.push(text);
  globalThis.Roll = class { async evaluate() { this.terms = [{ results: [{ result: 1 }] }]; return this; } };
  let start;
  const started = new Promise(resolve => { start = resolve; });
  mor.update = () => { start(); return new Promise(() => {}); };
  const result = assert.rejects(changeMor(owner, mor, "current", 1), { code: "condition-outcome-unknown" });
  await started;
  game.socket.connected = false;
  for (const disconnect of listeners) disconnect();
  await result;
  assert.equal(listeners.size, 0);
  assert.equal(owner.system.attribute.strength.value, 5);
  assert.match(notices[0], /strength 6 → 5.*unconfirmed.*check the sheet manually/i);
  assert.equal(await enqueueActorMutation(owner, () => "ready"), "ready");
});

test("an owner can edit STAT locally when no GM is active", async () => {
  setup();
  const owner = actor();
  owner.isOwner = true;
  game.user = { id: "owner", active: true };
  game.users = [game.user];
  assert.equal((await runStatOperation(owner, { kind: "layout", columns: 2 })).changed, true);
  assert.equal(owner.getFlag(scope, "conditions.layoutColumns"), 2);
  owner.isOwner = false;
  await assert.rejects(runStatOperation(owner, { kind: "layout", columns: 1 }), { code: "no-actor-permission" });
  assert.equal(owner.getFlag(scope, "conditions.layoutColumns"), 2);
});

test("migration adds level-4 penalties without damage and is idempotent", async () => {
  setup(); const heat = item("Жара"); set(heat, `flags.${scope}.conditions.heatValue`, 4); const owner = actor(heat);
  const items = [heat]; items.get = key => items.find(entry => entry.id === key); owner.items = items;
  assert.equal(await migrateActorData(owner), true);
  assert.equal(heat.system.rollModifiers.fblecHeatEndurance.value, "-1");
  assert.equal(owner.system.attribute.strength.value, 6);
  assert.equal(await migrateActorData(owner), false);
});

test("upgrading migration 7 preserves current world preferences", async () => {
  setup(); game.user.active = true; game.users = [game.user]; game.actors = [];
  const writes = [];
  game.settings.get = (_scope, key) => key === "expandedConditionsMigrationVersion" ? 7 : true;
  game.settings.storage = new Map([["world", new Map([["forbidden-lands-expanded-conditions.featureHeat", { value: false }]])]]);
  game.settings.set = async (_scope, key, value) => { writes.push({ key, value }); };
  await runWorldMigration();
  assert.deepEqual(writes, [{ key: "expandedConditionsMigrationVersion", value: MIGRATION_VERSION }]);
});

test("migration keeps legacy Actor flags and version after a veto and retries on the next pass", async t => {
  setup(); t.mock.method(console, "warn", () => {});
  const owner = actor();
  const legacy = [{ id: "old", name: "Legacy", time: "2 days", notes: "", desc: "", order: 0 }];
  owner.flags[LEGACY_MODULE_ID] = { list: legacy };
  game.user.active = true; game.users = [game.user]; game.actors = [owner];
  let version = MIGRATION_VERSION - 1;
  game.settings.get = () => version;
  game.settings.set = async (_scope, _key, value) => { version = value; };
  const update = owner.update;
  owner.update = async () => undefined;
  await runWorldMigration();
  assert.equal(version, MIGRATION_VERSION - 1);
  assert.deepEqual(owner.flags[LEGACY_MODULE_ID].list, legacy);
  owner.update = update;
  await runWorldMigration();
  assert.equal(version, MIGRATION_VERSION);
  assert.deepEqual(owner.getFlag(scope, "conditions.list"), legacy);
  assert.equal(owner.flags[LEGACY_MODULE_ID], undefined);
});

test("migration retains a current flag that differs from its legacy value", async () => {
  setup();
  const owner = actor();
  const list = [{ id: "old", name: "Legacy", time: "2 days", notes: "", desc: "", order: 0 }];
  owner.flags[LEGACY_MODULE_ID] = { list, layoutColumns: 1 };
  set(owner, `flags.${scope}.conditions.layoutColumns`, 2);

  assert.equal(await migrateActorData(owner), true);
  assert.equal(owner.getFlag(scope, "conditions.layoutColumns"), 2);
  assert.deepEqual(owner.getFlag(scope, "conditions.list"), list);
  assert.equal(owner.flags[LEGACY_MODULE_ID], undefined);
});

test("legacy Item migration checks the actual copied value before removing its source", async () => {
  setup();
  const injury = item("Injury"), owner = actor(injury);
  injury.flags[LEGACY_MODULE_ID] = { notes: "original" };
  const update = injury.update.bind(injury);
  const path = `flags.${scope}.conditions.notes`;
  injury.update = async patch => update(Object.hasOwn(patch, path) ? { [path]: "altered" } : patch);
  await assert.rejects(migrateActorData(owner), /conditions\.notes/);
  assert.equal(injury.flags[LEGACY_MODULE_ID].notes, "original");
  assert.equal(injury.getFlag(scope, "conditions.notes"), "altered");
});

for (const [name, oldValue, key, expected] of [
  ["Heat", "3/4", "heatValue", 3], ["Mor", "2/3", "morState", { current: 2, permanent: 3 }]
]) {
  test(`${name} migration verifies its flags while keeping the source timer until cleanup`, async () => {
    setup();
    const counter = item(name), owner = actor(counter);
    counter.system.healingTime = oldValue;
    const path = `flags.${scope}.conditions.${key}`;
    const update = counter.update.bind(counter);
    counter.update = async patch => { if (!Object.hasOwn(patch, path)) await update(patch); };
    await assert.rejects(migrateActorData(owner), /Condition write was not persisted/);
    assert.equal(counter.system.healingTime, oldValue);
    counter.update = update;
    assert.equal(await migrateActorData(owner), true);
    const steps = counter.updates.slice(1, 3);
    assert.deepEqual(steps, [{ [path]: expected }, { "system.healingTime": "" }]);
    assert.deepEqual(counter.getFlag(scope, `conditions.${key}`), expected);
    assert.equal(counter.system.healingTime, "");
  });
}

test("migrating Heat and Mor clears stale timers without recopying existing flags", async () => {
  setup();
  for (const [name, timer, key, current] of [
    ["Heat", "2", "heatValue", 4], ["Mor", "1/2", "morState", { current: 2, permanent: 3 }]
  ]) {
    const counter = item(name), owner = actor(counter);
    const path = `flags.${scope}.conditions.${key}`;
    counter.system.healingTime = timer;
    set(counter, path, current);

    assert.equal(await migrateActorData(owner), true);
    assert.equal(counter.system.healingTime, "");
    assert.deepEqual(counter.getFlag(scope, `conditions.${key}`), current);
    assert.ok(counter.updates.every(update => !Object.hasOwn(update, path)));
  }
});

function washActor(...extraItems) {
  const old = item("Помытый");
  old.system.healingTime = "1 day";
  const owner = actor(old, ...extraItems);
  const create = async (_type, [data]) => {
    const created = item(data.name);
    created.flags = structuredClone(data.flags);
    created.parent = owner;
    owner.items.set(created.id, created);
    return [created];
  };
  owner.createEmbeddedDocuments = create;
  owner.deleteEmbeddedDocuments = async (_type, ids) => { for (const id of ids) owner.items.delete(id); };
  game.items = [{ name: "Немытый", type: "criticalInjury", toObject: () => ({ name: "Немытый", type: "criticalInjury" }) }];
  game.packs = [];
  return { owner, old, create };
}

for (const failure of ["missing", "missing flags", "incorrect stage"]) {
  test(`Wash leaves the old stage when the replacement has ${failure}`, async () => {
    setup();
    const { owner, old, create } = washActor();
    owner.createEmbeddedDocuments = async (...args) => {
      const [replacement] = await create(...args);
      if (failure === "missing") owner.items.delete(replacement.id);
      if (failure === "missing flags") replacement.flags = {};
      if (failure === "incorrect stage") replacement.flags[scope].conditions.washStage = "Вонючка";
      return [replacement];
    };
    const result = await transitionWashLevel(owner, old.name);
    assert.equal(result.reason, failure === "missing" ? "create-failed" : "replacement-invalid");
    assert.equal(result.partiallyApplied, failure !== "missing");
    assert.equal(owner.items.get(old.id), old);
  });
}

for (const changed of ["itemId", "healingTime"]) test(`queued Wash rejects a changed ${changed} from the New Day plan`, async () => {
  setup();
  const { owner, old } = washActor();
  const expected = { itemId: old.id, healingTime: old.system.healingTime };
  const prior = enqueueActorMutation(owner, () => {
    if (changed === "healingTime") old.system.healingTime = "2 days";
    else {
      owner.items.delete(old.id);
      const replacement = item(old.name);
      replacement.system.healingTime = expected.healingTime;
      owner.items.set(replacement.id, replacement);
    }
  });
  const transition = transitionWashLevel(owner, old.name, {}, expected);
  await prior;
  assert.equal((await transition).reason, "stale-stage");
  assert.deepEqual([...owner.items.values()].map(entry => entry.name), [old.name]);
});

test("a confirmed Wash cleanup failure whispers to the GM even with suppressed notifications", async t => {
  setup();
  t.mock.method(console, "error", () => {});
  const { owner, old } = washActor();
  owner.deleteEmbeddedDocuments = async () => [];
  const messages = [];
  ChatMessage.create = async message => messages.push(message);
  ui.notifications.warn = () => assert.fail("Notifications were suppressed");
  const result = await transitionWashLevel(owner, old.name, { fblqaSuppressNotifications: true });
  assert.equal(result.code, "condition-partial-failure");
  assert.equal(result.reason, "cleanup-failed");
  assert.equal(owner.items.size, 2);
  assert.deepEqual(messages.map(message => message.whisper), [[game.user.id]]);
  assert.match(messages[0].content, /Немытый.*is on the sheet/);
});

test("STAT can call Wash and Addiction directly inside an Actor operation", { timeout: 1_000 }, async () => {
  setup([4]);
  const dependency = item("Addiction", decline());
  const { owner, old } = washActor(dependency);
  await enqueueActorMutation(owner, async () => {
    const wash = await applyStatOperation(owner, { kind: "healing-time", itemId: old.id, delta: -1 });
    assert.equal(wash.changed, true);
    const addiction = await processAddictionNewDayInternal(owner, dependency, quiet);
    assert.equal(addiction.advanced, true);
  });
  assert.equal(owner.items.has(old.id), false);
  assert.ok([...owner.items.values()].some(entry => entry.getFlag(scope, "conditions.washStage") === "Немытый"));
  assert.equal(getAddictionState(dependency).die, 10);
});

test("queued STAT edits use live fields and leave unresolved durations for manual resolution", async () => {
  setup();
  const injury = item("Injury"), owner = actor(injury);
  const range = "2 to 4 days";
  injury.system.healingTime = range;
  injury.system.limit = range;
  set(owner, `flags.${scope}.conditions.list`, [{ id: "custom", name: "Condition", time: range, order: 0 }]);
  await Promise.all([
    runStatOperation(owner, { kind: "custom-edit", id: "custom", field: "name", value: "Changed" }),
    runStatOperation(owner, { kind: "custom-edit", id: "custom", field: "notes", value: "Kept" })
  ]);
  for (const command of [{ kind: "healing-time", itemId: injury.id }, { kind: "lethal-limit", itemId: injury.id }, { kind: "custom-time", id: "custom" }]) {
    assert.equal((await runStatOperation(owner, { ...command, delta: -1 })).reason, "unresolved-duration");
  }
  const [condition] = owner.getFlag(scope, "conditions.list");
  assert.deepEqual([condition.name, condition.notes, condition.time], ["Changed", "Kept", range]);
  assert.deepEqual([injury.system.healingTime, injury.system.limit], [range, range]);
  assert.equal(injury.updates.length, 0);
});

test("STAT can manually advance a lethal limit in hours", async () => {
  setup();
  const injury = item("Injury"), owner = actor(injury);
  injury.system.lethal = "yes";
  injury.system.limit = "2 hours";
  globalThis.TextEditor = { enrichHTML: async text => text };
  globalThis.renderTemplate = async (_path, data) => data;
  const row = await renderConditionItemRow(injury, true);
  assert.match(row.lethalHtml, /lethal-limit-minus/);
  assert.match(row.lethalHtml, /lethal-limit-plus/);
  assert.equal(decrementFirstInteger(injury.system.limit), null);

  const operation = { kind: "lethal-limit", itemId: injury.id };
  assert.equal((await runStatOperation(owner, { ...operation, delta: 1 })).changed, true);
  assert.equal(injury.system.limit, "3 hours");
  await runStatOperation(owner, { ...operation, delta: -1 });
  assert.equal(injury.system.limit, "2 hours");
  injury.system.limit = "[[1d6]] hours";
  assert.equal((await runStatOperation(owner, { ...operation, delta: -1 })).reason, "unresolved-duration");
  assert.equal(injury.system.limit, "[[1d6]] hours");
});

test("STAT handlers keep numeric-looking condition IDs as strings for all three row actions", async () => {
  const source = await readFile(new URL("../scripts/conditions/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.data\(["']condition-id["']\)/);
  assert.equal([...source.matchAll(/const id = .*\.dataset\.conditionId;/g)].length, 3);

  setup();
  const owner = actor();
  const { conditionId: id } = { conditionId: "123" };
  set(owner, `flags.${scope}.conditions.list`, [{ id, time: "2 hours", order: 0 }]);
  const list = () => owner.getFlag(scope, "conditions.list");
  await runStatOperation(owner, { kind: "custom-edit", id, field: "name", value: "Renamed" });
  await runStatOperation(owner, { kind: "custom-time", id, delta: 1 });
  assert.deepEqual([list()[0].id, list()[0].name, list()[0].time], ["123", "Renamed", "3 hours"]);
  await runStatOperation(owner, { kind: "custom-remove", id });
  assert.deepEqual(list(), []);
});

test("STAT renders the phase, pending result and disabled morning until resolution", async () => {
  setup([2]); const dependency = item("Зависимость", decline()); const owner = actor(dependency);
  globalThis.TextEditor = { enrichHTML: async text => text };
  globalThis.renderTemplate = async (_path, data) => data;
  const ready = await renderConditionItemRow(dependency, true);
  assert.match(ready.statusText, /Decline d12/); assert.equal(ready.morningDisabled, false);
  await processAddictionNewDay(owner, dependency, quiet);
  const pending = await renderConditionItemRow(dependency, true);
  assert.equal(pending.pending, true); assert.equal(pending.morningDisabled, true);
  assert.match(pending.morningText, /Endurance/); assert.match(pending.rollText, /2/);
  await resolveAddictionMorning(owner, dependency, "failure-no-dose", quiet);
  const resolved = await renderConditionItemRow(dependency, true);
  assert.equal(resolved.pending, false); assert.equal(resolved.morningDisabled, true);
  assert.match(resolved.statusText, /d10/);
  delete globalThis.renderTemplate; delete globalThis.TextEditor;
});

test("the native dose dialog distinguishes dose, no-dose, cancel and closing the window", async () => {
  setup(); const url = new URL("../scripts/conditions/main.js", import.meta.url);
  let source = await readFile(url, "utf8");
  source = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
  source += "\nexport { askAddictionDose };\n";
  const controller = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  let current;
  foundry.applications = { api: { DialogV2: class {
    constructor(config) { this.config = config; this.events = {}; current = this; }
    addEventListener(name, callback) { this.events[name] = callback; }
    render() { return this; }
  } } };
  for (const [action, expected] of [["dose", true], ["none", false], ["cancel", null], ["close", null]]) {
    const answer = controller.askAddictionDose();
    if (action === "close") current.events.close();
    else current.config.buttons.find(button => button.action === action).callback(null, null, { element: null });
    assert.equal(await answer, expected);
  }
});
