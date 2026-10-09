import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildNewDayPlan, applyNewDayPlan, decrementFirstInteger } from "../scripts/new-day.js";
import { queueProfileSave, flushBiographySaves, releaseBiographyState, getBiographyProfile, biographyDisplayHtml } from "../scripts/biography.js";
import { updateHeatItem, parseHeatValue, saveAddictionState } from "../scripts/conditions/features/special-counters.js";
import { transitionWashLevel } from "../scripts/conditions/features/wash.js";
import { getConditionKind, getWashStage } from "../scripts/conditions/condition-kind.js";
import { normalizeReputationEntries, selectRandomReputation, saveReputationEntries } from "../scripts/reputation.js";
import { initializeWalletOperations } from "../scripts/wallet.js";
import { executeAsActiveGM } from "../scripts/integration/socket-api.js";
import { registerNewDayProvider, initializeNewDayProviderBridge } from "../scripts/integration/new-day-providers.js";
import { enqueueCurrencyOperation } from "../scripts/operation-queue.js";
import { scheduleStatSync, cleanupStatSync } from "../scripts/conditions/stat-sync.js";
import { refreshConditionsRows } from "../scripts/conditions/render/refresh-rows.js";

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
const calendar = await expose("scripts/state-progression.js", ["processActorAutomaticDays", "recordCalendarFailures"]);
const rest = await expose("scripts/rest.js", ["applyRest"]);
const money = await expose("scripts/money-transfer.js", ["executeMoneyTransfer", "processTransferDecision"]);
const start = { year: 1, month: 1, day: 1 };
const context = { calendarId: "audit", date: { ...start, day: 3 } };

test("A01: overlapping calendar requests read the live marker inside the queue", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  await a.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: start });
  const results = await Promise.all([calendar.processActorAutomaticDays(a, start, context, 2), calendar.processActorAutomaticDays(a, start, context, 2)]);
  assert.equal(a.items[0].system.healingTime, "8 days");
  assert.equal(results.reduce((sum, result) => sum + result.processedDays, 0), 2);
});
test("A01: a later overlapping target processes only remaining dates", async () => {
  reset(); const a = actor([item("timer", { healingTime: "10 days" })]);
  await a.setFlag(scope, "stateProgressionCalendaria", { calendarId: "audit", date: start });
  await Promise.all([calendar.processActorAutomaticDays(a, start, context, 2), calendar.processActorAutomaticDays(a, start, { ...context, date: { ...start, day: 4 } }, 3)]);
  assert.equal(a.items[0].system.healingTime, "7 days");
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
  await assert.rejects(updateHeatItem(a, h, 3)); assert.equal(parseHeatValue(h), 2); assert.ok(h.getFlag(scope, "conditions.heatPendingChange"));
  a.update = update; await updateHeatItem(a, h, 3); assert.equal(parseHeatValue(h), 3); assert.equal(a.system.attribute.strength.value, 4);
});
test("A06: retry after failed Heat finalization does not apply damage twice", async () => {
  reset(); const h = item("heat", { healingTime: "" }, "Heat"); const a = actor([h]); a.system.attribute.strength.value = 5;
  set(h.flags, `${scope}.conditions.heatValue`, 2); const update = h.update;
  h.update = async data => { if (data[`flags.${scope}.conditions.heatPendingChange`] === null) throw new Error("finalize failure"); return update(data); };
  await assert.rejects(updateHeatItem(a, h, 3)); assert.equal(a.system.attribute.strength.value, 4);
  h.update = update; await updateHeatItem(a, h, 3); assert.equal(a.system.attribute.strength.value, 4); assert.equal(parseHeatValue(h), 3);
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
