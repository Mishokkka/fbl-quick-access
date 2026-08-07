import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    getFlag: () => stored,
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
    getFlag: () => stored,
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
    getFlag: () => structuredClone(stored),
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

test("Calendaria readiness does not misreport an enabled module as unavailable", () => {
  assert.match(source, /Hooks\?\.on\?\.\("calendaria\.ready", \(data\)/);
  assert.match(source, /calendariaReadyApi = data\?\.api/);
  assert.match(source, /if \(!isCalendariaModuleActive\(\)\) warnCalendariaUnavailable\(\)/);
  assert.match(source, /function warnCalendariaUnavailable\([\s\S]*?if \(isCalendariaModuleActive\(\)\) return;/);
  assert.match(source, /globalThis\.CALENDARIA\?\.api \?\? calendariaReadyApi/);
});

test("PR11: automatic multi-day work has a low default cap and a hard ceiling", () => {
  assert.match(source, /DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT\s*=\s*90/);
  assert.match(source, /MAX_AUTOMATIC_CALENDAR_DAYS\s*=\s*365/);
  assert.match(source, /const effectiveLimit = Math\.min\(configuredLimit, MAX_AUTOMATIC_CALENDAR_DAYS\)/);
  assert.match(source, /let remaining = Math\.min\(requested, effectiveLimit\)/);
  assert.match(source, /maxDays:\s*days > DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT \? days : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT/);
});

test("PR11: a newer GM progression summary closes and evicts stale summary windows", () => {
  assert.match(source, /for \(const \[existingKey, existingState\] of gmSummaryWindows\)/);
  assert.match(source, /if \(existingKey === key\) continue/);
  assert.match(source, /gmSummaryWindows\.delete\(existingKey\)/);
  assert.match(source, /existingState\.dialog\?\.close\?\.\(\)/);
});

test("PR11: Calendaria public current date is not double-converted", () => {
  const contextSection = source.slice(source.indexOf("function getCalendariaContext"), source.indexOf("function isCalendariaModuleActive"));
  assert.match(contextSection, /normalizeCalendariaDate\(dateOverride \?\? api\.getCurrentDateTime\(\)\)/);
  assert.doesNotMatch(contextSection, /calendariaHookComponentToPublicDate\(.*getCurrentDateTime/);
});

test("PR11 follow-up: automatic progression reports logical marker advancement and never marks limited work done", () => {
  assert.match(source, /const markerAdvance = Number\(api\?\.daysBetween\?\.\(normalizeCalendariaDate\(startDate\), cursor\)\)/);
  assert.match(source, /processedDays = Math\.max\(0, Math\.min\(requested, Math\.floor\(markerAdvance\)\)\)/);
  assert.match(source, /limitedDays:\s*Math\.max\(0, requested - processedDays\)/);
  assert.match(source, /result\.limitedDays > 0[\s\S]*?state:\s*"blocked"[\s\S]*?days:\s*result\.limitedDays/);
  assert.doesNotMatch(source, /processedDays:\s*dayResults\.length/);
  assert.doesNotMatch(source, /limitedDays:\s*Math\.max\(0, requested - dayResults\.length\)/);
});
