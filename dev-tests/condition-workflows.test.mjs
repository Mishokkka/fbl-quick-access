import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getAddictionMorning, getAddictionDayKey, performAddictionMorning,
  processAddictionNewDay, resolveAddictionMorning, relapseAddiction, handleAddictionOperation, correctAddictionState
} from "../scripts/conditions/services/addiction-service.js";
import { applyHeatFailure, getAddictionState, parseHeatValue, saveAddictionState, updateHeatItem } from "../scripts/conditions/features/special-counters.js";
import { applyNewDayPlan, buildNewDayPlan, serializeNewDayResult } from "../scripts/new-day.js";
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
  globalThis.ui = { notifications: { info() {}, warn() {} } };
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
  const first = await processAddictionNewDay(owner, dependency, { ...quiet, dayKey: "calendar:test:1:1:2" });
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
  await assert.rejects(processAddictionNewDay(owner, dependency, quiet), /Actor unavailable/);
  assert.equal(getAddictionState(dependency).die, 10);
  assert.equal(getAddictionDayKey(owner), "manual:1");
  assert.equal((await performAddictionMorning(owner, dependency, quiet)).reused, true);
  assert.equal(buildNewDayPlan(owner).actions.find(entry => entry.kind === "addiction-day").dayKey, "manual:2");
  assert.equal(rolls.length, 1);
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
  const rolls = setup(); globalThis.CALENDARIA = { api: { daysBetween: (from, to) => to.day - from.day, addDays: (date, n) => ({ ...date, day: date.day + n }) } };
  const dependency = item("Зависимость", { phase: "flat", die: 6, daysLeft: 3, severity: 5 });
  const wound = item("Wound"); wound.system.healingTime = "6 days";
  const owner = actor(dependency, wound); const worker = await calendarWorker();
  const start = { year: 1, month: 1, day: 1 }; const context = { calendarId: "test", date: { ...start, day: 4 } };
  const first = await worker.processActorAutomaticDays(owner, start, context, 3);
  assert.equal(first.processedDays, 1); assert.equal(first.limitedDays, 2); assert.equal(first.pendingManual, 1);
  assert.equal(getAddictionState(dependency).daysLeft, 3); assert.equal(wound.system.healingTime, "5 days");
  assert.equal(getAddictionMorning(dependency).dayKey, "calendar:test:1:1:2");
  const retry = await worker.processActorAutomaticDays(owner, start, context, 3);
  assert.equal(retry.processedDays, 0); assert.equal(wound.system.healingTime, "5 days");
  await resolveAddictionMorning(owner, dependency, "failure-no-dose", quiet);
  const resumed = await worker.processActorAutomaticDays(owner, start, context, 3);
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

test("retrying failed Heat finalization does not repeat damage or omit the level-4 penalties", async () => {
  setup(); const heat = item("Жара"); const owner = actor(heat); set(heat, `flags.${scope}.conditions.heatValue`, 3);
  const update = heat.update.bind(heat); let fail = true;
  heat.update = async data => { if (fail && data[`flags.${scope}.conditions.heatPendingChange`] === null) throw new Error("finalize failed"); return update(data); };
  await assert.rejects(applyHeatFailure(owner, heat), /finalize failed/);
  assert.equal(owner.system.attribute.strength.value, 5);
  assert.equal(parseHeatValue(heat), 3);
  await assert.rejects(updateHeatItem(owner, heat, 2, "rest"));
  fail = false; await applyHeatFailure(owner, heat);
  assert.equal(owner.system.attribute.strength.value, 5); assert.equal(parseHeatValue(heat), 4);
  assert.equal(heat.system.rollModifiers.fblecHeatMove.value, "-1");
});

test("migration adds level-4 penalties without damage and is idempotent", async () => {
  setup(); const heat = item("Жара"); set(heat, `flags.${scope}.conditions.heatValue`, 4); const owner = actor(heat);
  const items = [heat]; items.get = key => items.find(entry => entry.id === key); owner.items = items;
  assert.equal(await migrateActorData(owner), true);
  assert.equal(heat.system.rollModifiers.fblecHeatEndurance.value, "-1");
  assert.equal(owner.system.attribute.strength.value, 6);
  assert.equal(await migrateActorData(owner), false);
});

test("upgrading migration 7 to 8 preserves current world preferences", async () => {
  setup(); game.user.active = true; game.users = [game.user]; game.actors = [];
  const writes = [];
  game.settings.get = (_scope, key) => key === "expandedConditionsMigrationVersion" ? 7 : true;
  game.settings.storage = new Map([["world", new Map([["forbidden-lands-expanded-conditions.featureHeat", { value: false }]])]]);
  game.settings.set = async (_scope, key, value) => { writes.push({ key, value }); };
  await runWorldMigration();
  assert.deepEqual(writes, [{ key: "expandedConditionsMigrationVersion", value: 8 }]);
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
