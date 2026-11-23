import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getCalendariaContext, getCalendariaQuarterInfo } from "../scripts/integration/calendaria-adapter.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts/state-progression.js"), "utf8");

const mod = await import(pathToFileURL(join(root, "scripts/state-progression.js")).href);

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

test("Calendaria startup waits for the ready hook without warning or rebaselining", async testContext => {
  const descriptors = ["game", "Hooks", "ui", "CALENDARIA"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  testContext.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const previousDate = { year: 882, month: 4, day: 11 };
  const date = { ...previousDate, day: 12 };
  let currentDate = date;
  let marker = { calendarId: "air-islands", date: previousDate };
  const actor = {
    id: "pc", type: "character", documentName: "Actor",
    getFlag: (_scope, key) => key === "stateProgressionCalendaria" ? marker : undefined,
    async setFlag(_scope, key, value) { assert.equal(key, "stateProgressionCalendaria"); marker = value; }
  };
  let missingMarker;
  const uninitialized = {
    id: "uninitialized", type: "character", documentName: "Actor",
    getFlag: (_scope, key) => key === "stateProgressionCalendaria" ? missingMarker : undefined,
    async setFlag(_scope, key, value) { assert.equal(key, "stateProgressionCalendaria"); missingMarker = value; }
  };
  const gm = { id: "gm", isGM: true, active: true };
  const hooks = new Map();
  const warnings = [];
  globalThis.game = {
    user: gm, users: [gm, { id: "player", character: actor, active: true }, { id: "second", character: uninitialized, active: true }],
    actors: new Map([[actor.id, actor], [uninitialized.id, uninitialized]]), modules: new Map([["calendaria", { active: true }]]),
    settings: { get: () => "calendaria" }
  };
  globalThis.Hooks = { on(event, callback) { hooks.set(event, [...(hooks.get(event) ?? []), callback]); } };
  globalThis.ui = { notifications: { warn: warning => warnings.push(warning) } };
  delete globalThis.CALENDARIA;
  mod.initializeStateProgression();
  await mod.readyStateProgression();
  assert.deepEqual(warnings, []);

  const api = {
    getCurrentDateTime: () => currentDate, getActiveCalendar: () => ({ id: "air-islands" }),
    daysBetween: (start, end) => end.day - start.day, addDays: (value, days) => ({ ...value, day: value.day + days })
  };
  game.modules.get("calendaria").api = api;
  for (const callback of hooks.get("calendaria.calendarSwitched")) callback();
  await nextTurn();
  assert.deepEqual(marker.date, previousDate);
  assert.equal(missingMarker, undefined);
  delete game.modules.get("calendaria").api;
  for (const callback of hooks.get("calendaria.ready")) callback({ api });
  await nextTurn();
  assert.equal(getCalendariaContext().api, api);
  assert.deepEqual(marker.date, previousDate);
  assert.deepEqual(missingMarker, { calendarId: "air-islands", date });
  currentDate = { ...date, day: 13 };
  for (const callback of hooks.get("calendaria.calendarSwitched")) callback();
  await nextTurn();
  assert.deepEqual(marker.date, currentDate);
  assert.deepEqual(missingMarker.date, currentDate);
});

test("Short Rest quarters respect Calendaria's minutes and seconds as well as hours", testContext => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "CALENDARIA");
  testContext.after(() => {
    if (original) Object.defineProperty(globalThis, "CALENDARIA", original);
    else delete globalThis.CALENDARIA;
  });
  let time;
  globalThis.CALENDARIA = { api: {
    getActiveCalendar: () => ({ id: "custom", days: { hoursPerDay: 25, minutesPerHour: 41, secondsPerMinute: 20 } }),
    getCurrentDateTime: () => ({ year: 12, month: 1, day: 2, ...time })
  } };
  time = { hour: 6, minute: 10, second: 4 };
  assert.equal(getCalendariaQuarterInfo()?.key, "calendaria:custom:12:1:2:q0");
  time.second = 5;
  assert.equal(getCalendariaQuarterInfo()?.key, "calendaria:custom:12:1:2:q1");
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
  let stored = { calendarId: "air-islands", date: { year: 882, month: 4, day: 8 } };
  const actor = {
    getFlag: (_scope, key) => key === "stateProgressionCalendaria" ? stored : undefined,
    setFlag: async (_moduleId, _key, value) => { stored = structuredClone(value); }
  };
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  const result = await mod.markActorCalendariaAbsent(actor, context, api);
  assert.equal(result.changed, true);
  assert.equal(result.skippedDays, 4);
  assert.deepEqual(stored, {
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
  let stored = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    resolution: "absent",
    skippedDays: 4,
    previousDate: { year: 882, month: 4, day: 8 }
  };
  const actor = {
    getFlag: (_scope, key) => key === "stateProgressionCalendaria" ? stored : undefined,
    setFlag: async (_moduleId, _key, value) => { stored = structuredClone(value); }
  };
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  const result = await mod.undoActorCalendariaAbsent(actor, context);
  assert.equal(result.changed, true);
  assert.deepEqual(stored, {
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
  let stored = { calendarId: "air-islands", date: { year: 882, month: 4, day: 11 } };
  const actor = {
    getFlag: (_scope, key) => key === "stateProgressionCalendaria" ? structuredClone(stored) : undefined,
    setFlag: async (_moduleId, _key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = structuredClone(value);
    }
  };
  const context = {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 12 },
    api
  };

  const markPromise = mod.markActorCalendariaAbsent(actor, context, api);
  const undoPromise = mod.undoActorCalendariaAbsent(actor, context);
  const [marked, undone] = await Promise.all([markPromise, undoPromise]);

  assert.equal(marked.changed, true);
  assert.equal(undone.changed, true);
  assert.deepEqual(stored, {
    calendarId: "air-islands",
    date: { year: 882, month: 4, day: 11 }
  });
});

test("PR11: Calendaria public current date is not double-converted", testContext => {
  const previousGame = globalThis.game;
  const previousCalendaria = globalThis.CALENDARIA;
  testContext.after(() => { globalThis.game = previousGame; globalThis.CALENDARIA = previousCalendaria; });
  const date = { year: 882, month: 1, day: 1 };
  globalThis.game = { modules: new Map([["calendaria", { active: true }]]) };
  globalThis.CALENDARIA = { api: {
    getCurrentDateTime: () => ({ ...date, hour: 6 }), getActiveCalendar: () => ({ metadata: { id: "air-islands" } }),
    daysBetween: () => 0, addDays: () => date
  } };
  assert.deepEqual(getCalendariaContext().date, date);
});
