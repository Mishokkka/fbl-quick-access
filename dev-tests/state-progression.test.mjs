import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as settle } from "node:timers/promises";
import { getCalendariaContext, getCalendariaQuarterInfo } from "../scripts/integration/calendaria-adapter.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts/state-progression.js"), "utf8");

const mod = await import(pathToFileURL(join(root, "scripts/state-progression.js")).href);
const markerFlag = "stateProgressionCalendaria";
const hooks = new Map();

function setupWorld(actors, context) {
  const gm = { id: "gm", isGM: true, active: true };
  const warnings = [];
  globalThis.game = {
    user: gm,
    users: [gm, ...actors.map(actor => ({ id: `owner-${actor.id}`, active: true, character: actor }))],
    actors: new Map(actors.map(actor => [actor.id, actor])),
    settings: { get: () => "calendaria" },
    modules: new Map([["calendaria", { active: true }]])
  };
  globalThis.CALENDARIA = { api: {
    getCurrentDateTime: () => context.date, getActiveCalendar: () => ({ id: context.calendarId }), ...context.api
  } };
  globalThis.ui = { notifications: { warn: message => warnings.push(message), error: message => warnings.push(message), info() {} } };
  return warnings;
}

function setupActor(id, marker) {
  return {
    id, name: id, documentName: "Actor", type: "character", items: [], marker,
    getFlag(_scope, key) { return key === markerFlag ? structuredClone(this.marker) : undefined; },
    async setFlag(_scope, key, value) {
      assert.equal(key, markerFlag);
      // Foundry merges nested flag objects instead of replacing missing fields.
      this.marker = { ...this.marker, ...structuredClone(value) };
    }
  };
}

function captureDialogs(t) {
  const { foundry, HTMLElement } = globalThis;
  t.after(() => Object.assign(globalThis, { foundry, HTMLElement }));
  const dialogs = [];
  class Element {
    constructor(rewindDays) {
      this.rewindDays = rewindDays;
      this.dataset = {};
      this.classList = { add() {} };
      this.listeners = new Map();
      this.rows = { innerHTML: "" };
    }
    matches(selector) { return selector === "form"; }
    querySelector(selector) {
      if (selector === ".fblqa-progression-summary-rows") return this.rows;
      if (selector === 'input[name="rewindDays"]') return { value: this.rewindDays };
      return null;
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    contains() { return true; }
  }
  class Dialog {
    constructor(config) { this.config = config; this.element = new Element(); this.listeners = new Map(); dialogs.push(this); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    render() { this.listeners.get("render")?.(); return this; }
    close() { this.listeners.get("close")?.(); }
    submit(action, form) { return this.config.buttons.find(button => button.action === action).callback({}, { form }, this); }
    click(action, actorId) {
      const button = { dataset: { action }, closest: () => actorId ? { dataset: { actorId } } : null };
      return this.element.listeners.get("click")({ target: { closest: () => button }, preventDefault() {} });
    }
  }
  globalThis.HTMLElement = Element;
  globalThis.foundry = { applications: { api: { DialogV2: Dialog } } };
  return { dialogs, Element };
}

test("Calendaria hook dates are converted from internal zero-based components", () => {
  assert.deepEqual(
    mod.calendariaHookComponentToPublicDate({ year: 882, month: 3, dayOfMonth: 9 }),
    { year: 882, month: 4, day: 10 }
  );
});

test("assigned player actors include only unique characters assigned to non-GM users", () => {
  const actorA = { id: "a", name: "A", type: "character", documentName: "Actor" };
  const actorB = { id: "b", name: "B", type: "character", documentName: "Actor" };
  const npc = { id: "npc", name: "NPC", type: "npc", documentName: "Actor" };
  const actors = new Map([["a", actorA], ["b", actorB], ["npc", npc]]);
  const users = [
    { id: "u1", name: "One", isGM: false, active: true, character: actorA },
    { id: "u2", name: "Two", isGM: false, active: false, character: "a" },
    { id: "u3", name: "Three", isGM: false, active: true, character: actorB },
    { id: "u4", name: "Four", isGM: false, active: true, character: npc },
    { id: "gm", name: "GM", isGM: true, active: true, character: actorB }
  ];

  const result = mod.getAssignedPlayerActors(users, actors);
  assert.deepEqual(result.map((entry) => entry.actor.id), ["a", "b"]);
  assert.deepEqual(result[0].users.map((user) => user.id), ["u1", "u2"]);
  assert.equal(result[0].primaryUser.id, "u1");
});

test("assigned player actors prefer the canonical world Actor over user.character references", () => {
  const stale = { id: "a", name: "Stale", type: "character", documentName: "Actor", parent: { documentName: "Actor" } };
  const canonical = { id: "a", name: "Canonical", type: "character", documentName: "Actor", parent: null };
  const actors = new Map([["a", canonical]]);
  const users = [{ id: "u1", isGM: false, active: true, character: stale }];

  const result = mod.getAssignedPlayerActors(users, actors);
  assert.equal(result.length, 1);
  assert.equal(result[0].actor, canonical);
});


test("calendar status distinguishes current, one-day and multi-day pending progression", () => {
  const ordinal = (date) => date.year * 360 + (date.month - 1) * 30 + date.day;
  const api = { daysBetween: (start, end) => ordinal(end) - ordinal(start) };
  const context = { calendarId: "air-islands", date: { year: 882, month: 4, day: 12 } };

  assert.deepEqual(
    mod.calculateActorCalendarStatus({ calendarId: "air-islands", date: { year: 882, month: 4, day: 12 } }, context, api),
    { status: "current", days: 0 }
  );
  assert.deepEqual(
    mod.calculateActorCalendarStatus({ calendarId: "air-islands", date: { year: 882, month: 4, day: 11 } }, context, api),
    { status: "pending", days: 1 }
  );
  assert.deepEqual(
    mod.calculateActorCalendarStatus({ calendarId: "air-islands", date: { year: 882, month: 4, day: 8 } }, context, api),
    { status: "pending-multiple", days: 4 }
  );
  assert.equal(
    mod.calculateActorCalendarStatus({ calendarId: "other", date: { year: 882, month: 4, day: 8 } }, context, api).status,
    "baseline"
  );
});

test("Calendaria integration is hook-driven and contains no polling loop", () => {
  assert.match(source, /calendaria\.dayChange/);
  assert.match(source, /calendaria\.calendarSwitched/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /requestAnimationFrame\s*\(/);
});

test("Calendaria startup preserves pending days and waits for its active API without a warning", async () => {
  const actor = setupActor("Player character", { calendarId: "test", date: { year: 1, month: 1, day: 1 } });
  const context = { calendarId: "test", date: { year: 1, month: 1, day: 3 } };
  const warnings = setupWorld([actor], context);
  globalThis.Hooks = { on: (name, handler) => hooks.set(name, handler) };
  mod.initializeStateProgression();
  await hooks.get("calendaria.calendarSwitched")();
  assert.equal(actor.marker.date.day, 1);
  const { api } = CALENDARIA;
  delete globalThis.CALENDARIA;
  await mod.readyStateProgression();
  assert.deepEqual(warnings, []);
  await hooks.get("calendaria.ready")({ api });
  assert.equal(actor.marker.date.day, 1);
  context.calendarId = "switched";
  await hooks.get("calendaria.calendarSwitched")();
  assert.equal(actor.marker.calendarId, "switched");
  assert.equal(actor.marker.date.day, 3);
});

test("calendar application suppresses new-day chat output", () => {
  assert.match(source, /postChat:\s*false/);
  assert.match(source, /suppressNotifications:\s*true/);
});

test("state progression is a world setting and Long Rest is explicitly gated by the selected mode", () => {
  const settingsSource = readFileSync(join(root, "scripts/settings.js"), "utf8");
  const restSource = readFileSync(join(root, "scripts/rest.js"), "utf8");
  assert.match(settingsSource, /SETTINGS\.STATE_PROGRESSION_MODE/);
  assert.match(settingsSource, /scope:\s*"world"/);
  assert.match(settingsSource, /"long-rest"/);
  assert.match(settingsSource, /calendaria/);
  assert.match(restSource, /options\.startsNewDay\s*&&\s*!usesCalendariaStateProgression\(\)/);
  assert.match(restSource, /Rest\.StateProgressionCalendaria/);
});

test("GM can mark a pending Calendaria batch absent without advancing state documents", async () => {
  const ordinal = (date) => date.year * 360 + (date.month - 1) * 30 + date.day;
  const api = { daysBetween: (start, end) => ordinal(end) - ordinal(start) };
  const actor = setupActor("Absent", { calendarId: "air-islands", date: { year: 882, month: 4, day: 8 } });
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  setupWorld([actor], context);
  const result = await mod.markActorCalendariaAbsent(actor, context);
  assert.equal(result.changed, true);
  assert.equal(result.skippedDays, 4);
  assert.deepEqual(actor.marker, {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    resolution: "absent",
    skippedDays: 4,
    previousDate: { year: 882, month: 4, day: 8 }
  });
  assert.equal(mod.calculateActorCalendarStatus(mod.getActorCalendarMarker(actor), context, api).status, "current");
});

test("Absent undo restores the previous marker and makes the skipped batch pending again", async () => {
  const ordinal = (date) => date.year * 360 + (date.month - 1) * 30 + date.day;
  const api = { daysBetween: (start, end) => ordinal(end) - ordinal(start) };
  const actor = setupActor("Absent", {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    resolution: "absent",
    skippedDays: 4,
    previousDate: { year: 882, month: 4, day: 8 }
  });
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  setupWorld([actor], context);
  const result = await mod.undoActorCalendariaAbsent(actor, context);
  assert.equal(result.changed, true);
  assert.deepEqual(mod.getActorCalendarMarker(actor), {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 8 }
  });
  assert.deepEqual(mod.calculateActorCalendarStatus(mod.getActorCalendarMarker(actor), context, api), {
    status: "pending-multiple",
    days: 4
  });
});

test("GM summary exposes Resolve, Absent and Undo actions and time skips leave offline players pending", () => {
  assert.match(source, /data-action="absent"/);
  assert.match(source, /data-action="undo-absent"/);
  assert.match(source, /state:\s*"absent"/);
  assert.match(source, /if \(!entry\.primaryUser\?\.active\)/);
  assert.match(source, /OfflineTimeSkipPending/);
});

test("Absent and Undo are serialized per Actor so near-simultaneous GM actions cannot race", async () => {
  const ordinal = (date) => date.year * 360 + (date.month - 1) * 30 + date.day;
  const api = { daysBetween: (start, end) => ordinal(end) - ordinal(start) };
  const actor = setupActor("Concurrent", { calendarId: "air-islands", date: { year: 882, month: 4, day: 11 } });
  const setFlag = actor.setFlag.bind(actor);
  actor.setFlag = async (...args) => { await new Promise(resolve => setTimeout(resolve, 5)); await setFlag(...args); };
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  setupWorld([actor], context);
  const markPromise = mod.markActorCalendariaAbsent(actor, context);
  const undoPromise = mod.undoActorCalendariaAbsent(actor, context);
  const [marked, undone] = await Promise.all([markPromise, undoPromise]);

  assert.equal(marked.changed, true);
  assert.equal(undone.changed, true);
  assert.deepEqual(mod.getActorCalendarMarker(actor), {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 11 }
  });
});

test("PR11: a newer GM progression summary closes and evicts stale summary windows", () => {
  assert.match(source, /for \(const \[existingKey, existingState\] of gmSummaryWindows\)/);
  assert.match(source, /if \(existingKey === key\) continue/);
  assert.match(source, /gmSummaryWindows\.delete\(existingKey\)/);
  assert.match(source, /existingState\.dialog\?\.close\?\.\(\)/);
});

test("the Calendaria adapter keeps public dates and uses the active calendar's clock units", () => {
  const context = { calendarId: "other", date: { year: 1, month: 1, day: 4, hour: 2, minute: 20 } };
  setupWorld([], context);
  CALENDARIA.api.getActiveCalendar = () => ({ metadata: { id: "other" }, days: { hoursPerDay: 10, minutesPerHour: 40, secondsPerMinute: 50 } });
  assert.deepEqual(getCalendariaContext().date, { year: 1, month: 1, day: 4 });
  assert.equal(getCalendariaQuarterInfo().key, "calendaria:other:1:1:4:q1");
  assert.equal(getCalendariaQuarterInfo().legacyKey, "calendaria:1:1:4:q1");
  assert.equal(mod.normalizeCalendariaDate({ year: null, month: 1, day: 4 }), null);
  assert.equal(mod.calendariaHookComponentToPublicDate({ year: 1, month: -1, dayOfMonth: 0 }), null);
});

test("the GM manager resets an ahead marker and rewinds from DialogV2 button.form", async t => {
  const day = { year: 1, month: 1, day: 5 };
  const actor = setupActor("Explorer", { calendarId: "manager", date: { ...day, day: 9 } });
  const api = { daysBetween: (from, to) => to.day - from.day, addDays: (date, amount) => ({ ...date, day: date.day + amount }) };
  setupWorld([actor], { calendarId: "manager", date: day, api });
  const { dialogs, Element } = captureDialogs(t);
  const state = await mod.openStateProgressionManager();
  t.after(() => state.dialog.close());
  const manager = dialogs[0];
  assert.match(manager.config.content, /data-action="reset-all-current".*data-action="rewind-all"/s);
  assert.match(manager.element.rows.innerHTML, /Marker ahead/);
  await manager.click("reset-current", actor.id);
  assert.equal(actor.marker.date.day, 5);
  assert.match(manager.element.rows.innerHTML, /Marker reset to the current date/);

  const rewind = manager.click("rewind", actor.id);
  const prompt = dialogs.at(-1);
  assert.notEqual(prompt, manager);
  await prompt.submit("rewind", new Element("2"));
  await rewind;
  assert.equal(actor.marker.date.day, 3);
  assert.match(manager.element.rows.innerHTML, /2 day\(s\).*pending again/);
});

test("a bulk marker reset does not extend to a later date while its confirmation is open", async t => {
  const day = { year: 1, month: 1, day: 5 };
  const actor = setupActor("Explorer", { calendarId: "bulk", date: { ...day, day: 2 } });
  const api = { daysBetween: (from, to) => to.day - from.day };
  const warnings = setupWorld([actor], { calendarId: "bulk", date: day, api });
  const { dialogs } = captureDialogs(t);
  const state = await mod.openStateProgressionManager();
  t.after(() => dialogs.forEach(dialog => dialog.close()));
  t.mock.method(console, "error", () => {});
  const resetting = state.dialog.click("reset-all-current");
  const confirmation = dialogs.at(-1);
  assert.match(confirmation.config.content, /5\.1\.1/);
  CALENDARIA.api.getCurrentDateTime = () => ({ ...day, day: 6 });
  await confirmation.submit("yes");
  await resetting;
  assert.equal(actor.marker.date.day, 2);
  assert.ok(warnings.some(message => /calendar date or pending days changed/i.test(message)));
});

test("a time skip shows the approved backlog, preserves deferred days and excludes offline Actors", async t => {
  const date = { year: 1, month: 1, day: 6 };
  const actor = setupActor("Online", { calendarId: "skip", date: { ...date, day: 2 } });
  const offline = setupActor("Offline", { calendarId: "skip", date: { ...date, day: 1 } });
  const api = { daysBetween: (from, to) => to.day - from.day, addDays: (day, amount) => ({ ...day, day: day.day + amount }) };
  const warnings = setupWorld([actor, offline], { calendarId: "skip", date, api });
  game.users.find(user => user.character === offline).active = false;
  const { dialogs } = captureDialogs(t);
  t.after(() => dialogs.forEach(dialog => dialog.close()));
  t.mock.method(console, "error", () => {});
  const skip = () => hooks.get("calendaria.dayChange")({
    previous: { year: 1, month: 0, dayOfMonth: 3 }, current: { year: 1, month: 0, dayOfMonth: 5 }
  });
  const deferred = skip();
  await settle();
  const first = dialogs.at(-1);
  assert.match(first.config.content, /Online: up to 4 of 4 pending days/);
  assert.doesNotMatch(first.config.content, /Offline: up to/);
  await first.submit("no");
  await deferred;
  assert.equal(actor.marker.date.day, 2);

  const stale = skip();
  await settle();
  assert.match(dialogs.at(-1).config.content, /Online: up to 4 of 4 pending days/);
  actor.marker.date.day = 1;
  await dialogs.at(-1).submit("yes");
  await stale;
  assert.equal(actor.marker.date.day, 1);
  assert.ok(warnings.some(message => /pending days changed/i.test(message)));

  const approved = skip();
  await settle();
  assert.match(dialogs.at(-1).config.content, /Online: up to 5 of 5 pending days/);
  await dialogs.at(-1).submit("yes");
  await approved;
  assert.equal(actor.marker.date.day, 6);
  assert.equal(offline.marker.date.day, 1);
});

test("a confirmed time skip stops the remaining actors after one actor fails a day write", async t => {
  const date = { year: 1, month: 1, day: 6 };
  const first = setupActor("skip-fail-first", { calendarId: "skip-fail", date: { ...date, day: 4 } });
  const second = setupActor("skip-fail-second", { calendarId: "skip-fail", date: { ...date, day: 4 } });
  let secondWrites = 0;
  first.setFlag = async () => { throw new Error("marker write rejected"); };
  const origSecondSetFlag = second.setFlag.bind(second);
  second.setFlag = async (...args) => { secondWrites += 1; return origSecondSetFlag(...args); };

  const api = { daysBetween: (from, to) => to.day - from.day, addDays: (day, amount) => ({ ...day, day: day.day + amount }) };
  setupWorld([first, second], { calendarId: "skip-fail", date, api });
  const { dialogs } = captureDialogs(t);
  t.after(() => dialogs.forEach(dialog => dialog.close()));
  t.mock.method(console, "error", () => {});

  const running = hooks.get("calendaria.dayChange")({
    previous: { year: 1, month: 0, dayOfMonth: 3 }, current: { year: 1, month: 0, dayOfMonth: 5 }
  });
  await settle();
  await dialogs.at(-1).submit("yes");
  await running;

  assert.equal(first.marker.date.day, 4);
  assert.equal(second.marker.date.day, 4);
  assert.equal(secondWrites, 0);
});
