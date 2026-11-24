import {
  FLAG_STATE_PROGRESSION_CALENDAR,
  MODULE_ID,
  SETTINGS
} from "./constants.js";
import { qaLocalize } from "./i18n.js";
import {
  applyNewDayPlanInternal,
  buildNewDayPlanWithProviders,
  getStaleNewDayActions,
  openNewDayDialog,
  readNewDaySelection,
  serializeNewDayResult
} from "./new-day.js";
import {
  confirmDangerAction,
  createFoundryDialog,
  extractDialogElement,
  findDialogForm,
  hasFoundryDialogApi
} from "./dialogs.js";
import { escapeHtml } from "./utils.js";
import {
  executeAsActiveGM,
  getActiveGM,
  registerSocketHandler
} from "./integration/socket-api.js";
import { consumeSocketProof } from "./socket-auth.js";
import { makeSocketRequestId, isValidSocketRequestId } from "./socket-utils.js";
import { enqueueActorMutation } from "./operation-queue.js";
import { documentValuesEqual, isUnknownWriteOutcome, readActorFlag, runDocumentWrite, whisperToGM } from "./document-writes.js";
import {
  calendariaDateKey,
  calendariaHookComponentToPublicDate,
  formatCalendariaDate,
  getCalendariaApi,
  getCalendariaContext,
  hasCalendariaReadyFired,
  isCalendariaModuleActive,
  markCalendariaReady,
  normalizeCalendariaDate,
  sameCalendariaDay
} from "./integration/calendaria-adapter.js";
import { getNewDayProviders } from "./integration/new-day-providers.js";
import { addictionCalendarDayKey, getPendingAddictions } from "./conditions/services/addiction-service.js";

export { calendariaDateKey, calendariaHookComponentToPublicDate, normalizeCalendariaDate };

export const STATE_PROGRESSION_MODES = Object.freeze({
  LONG_REST: "long-rest",
  CALENDARIA: "calendaria"
});

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const APPLY_OPERATION = "state-progression.apply-calendaria-day";
const REPORT_OPERATION = "state-progression.report-calendaria-pending";
const PLAYER_RESULT_TYPE = "state-progression-player-result";
const PLAYER_RESULT_PROOF_KIND = "stateProgressionResult";
const DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT = 90;
const MAX_AUTOMATIC_CALENDAR_DAYS = 365;

let initialized = false;
let resultSocketRegistered = false;
let observedMode = null;
let revertingMode = false;
let calendariaUnavailableWarned = false;
let lastAheadWarningKey = "";

const activePlayerPrompts = new Set();
const gmSummaryWindows = new Map();
// A failed day stays pending. Suppress reapplying it from another prompt in
// this GM session until the GM reviews the sheet and adjusts its marker.
const actorsNeedingReview = new Map();

export function handleStateProgressionActorDeleted(actor) {
  const actorId = String(actor?.id ?? "");
  if (!actorId) return;
  actorsNeedingReview.delete(actorId);
  for (const state of gmSummaryWindows.values()) {
    if (!state.entries.has(actorId)) continue;
    state.entries.delete(actorId);
    state.statuses.delete(actorId);
    refreshGMSummaryDom(state);
  }
}

export function initializeStateProgression() {
  if (initialized) return;
  registerSocketHandler(APPLY_OPERATION, handleCalendariaApplyRequest, { addressed: true });
  registerSocketHandler(REPORT_OPERATION, handleCalendariaPendingReport, { addressed: true });

  globalThis.Hooks?.on?.("calendaria.dayChange", data => handleCalendariaDayChange(data).catch(showCalendarError));
  globalThis.Hooks?.on?.("calendaria.calendarSwitched", () => handleCalendariaCalendarSwitch().catch(showCalendarError));
  globalThis.Hooks?.on?.("calendaria.ready", data => handleCalendariaReady(data).catch(showCalendarError));
  globalThis.Hooks?.on?.("fblQuickAccess.stateProgressionModeChanged", mode => handleProgressionModeChanged(mode).catch(showCalendarError));
  const refreshMorningSummary = item => {
    const actor = item?.parent;
    if (!actor || !isActiveQuickAccessGM()) return;
    for (const state of gmSummaryWindows.values()) {
      if (!state.entries.has(actor.id)) continue;
      const old = state.statuses.get(actor.id);
      if (old?.state === "processing") continue;
      const pendingManual = getPendingAddictions(actor).length;
      if (pendingManual || old?.pendingManual) updateGMSummaryStatus(state, actor.id, {
        ...summaryStatusForActor(state.entries.get(actor.id), state.context), pendingManual
      });
    }
  };
  globalThis.Hooks?.on?.("updateItem", refreshMorningSummary);
  globalThis.Hooks?.on?.("deleteItem", refreshMorningSummary);
  initialized = true;
}

export async function readyStateProgression() {
  observedMode = getStateProgressionMode();
  registerResultSocket();

  if (!usesCalendariaStateProgression()) return;
  const context = getCalendariaContext();
  if (!context) {
    // Calendaria builds its active CalendarManager during its own `ready`
    // callback, then emits `calendaria.ready`. Foundry does not guarantee that
    // our ready callback runs after Calendaria's. If the module is active, an
    // empty context here is an initialization-order condition, not evidence
    // that Calendaria is unavailable. The custom ready hook will finish setup.
    if (!isCalendariaModuleActive()) warnCalendariaUnavailable();
    return;
  }

  if (isActiveQuickAccessGM()) {
    try { await ensureMissingPlayerBaselines(context); }
    catch (error) { showCalendarError(error); }
    warnIfAnyMarkersAhead(context);
  }
  if (!game.user?.isGM) await checkCurrentPlayerPending();
}

export function getStateProgressionMode() {
  try {
    const mode = String(game.settings.get(MODULE_ID, SETTINGS.STATE_PROGRESSION_MODE) ?? "");
    if (Object.values(STATE_PROGRESSION_MODES).includes(mode)) return mode;
  } catch (_error) {
    // Settings may be queried during tests or before init.
  }
  return STATE_PROGRESSION_MODES.LONG_REST;
}

export function usesCalendariaStateProgression() {
  return getStateProgressionMode() === STATE_PROGRESSION_MODES.CALENDARIA;
}

export function usesLongRestStateProgression() {
  return !usesCalendariaStateProgression();
}

export function getAssignedPlayerActors(users = globalThis.game?.users, actors = globalThis.game?.actors) {
  const byActor = new Map();
  for (const user of Array.from(users ?? [])) {
    if (!user || user.isGM) continue;
    const actor = resolveUserCharacter(user, actors);
    if (!actor || actor.documentName !== "Actor" || actor.type !== "character" || actor.pack || actor.isToken) continue;

    let entry = byActor.get(actor.id);
    if (!entry) {
      entry = { actor, users: [] };
      byActor.set(actor.id, entry);
    }
    entry.users.push(user);
  }

  return Array.from(byActor.values())
    .map((entry) => {
      entry.users.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const activeUsers = entry.users.filter((user) => user.active);
      return {
        ...entry,
        primaryUser: activeUsers[0] ?? entry.users[0] ?? null
      };
    })
    .sort((a, b) => String(a.actor?.name ?? "").localeCompare(String(b.actor?.name ?? "")) || String(a.actor?.id).localeCompare(String(b.actor?.id)));
}

export function calculateActorCalendarStatus(marker, context, api = context?.api ?? getCalendariaApi()) {
  if (!context?.date || !context?.calendarId || !api?.daysBetween) {
    return { status: "unavailable", days: null };
  }
  if (!marker?.date || marker.calendarId !== context.calendarId) {
    return { status: "baseline", days: null };
  }

  let days;
  try {
    days = api.daysBetween(marker.date, context.date);
  } catch (_error) {
    return { status: "unavailable", days: null };
  }
  if (!Number.isSafeInteger(days) || (days === 0 && !sameCalendariaDay(marker.date, context.date))) {
    return { status: "unavailable", days: null };
  }
  if (days < 0) return { status: "ahead", days };
  if (days === 0) return { status: "current", days: 0 };
  if (days === 1) return { status: "pending", days: 1 };
  return { status: "pending-multiple", days };
}

async function handleProgressionModeChanged(mode) {
  const nextMode = Object.values(STATE_PROGRESSION_MODES).includes(String(mode))
    ? String(mode)
    : STATE_PROGRESSION_MODES.LONG_REST;
  const previousMode = observedMode ?? getStateProgressionMode();
  observedMode = nextMode;

  if (revertingMode || previousMode === nextMode) return;
  if (!isActiveQuickAccessGM()) return;

  const confirmed = await confirmProgressionModeChange(previousMode, nextMode);
  if (getStateProgressionMode() !== nextMode || !isActiveQuickAccessGM()) return;
  if (!confirmed) {
    revertingMode = true;
    try {
      await game.settings.set(MODULE_ID, SETTINGS.STATE_PROGRESSION_MODE, previousMode);
      observedMode = previousMode;
    } finally {
      revertingMode = false;
    }
    return;
  }

  if (nextMode !== STATE_PROGRESSION_MODES.CALENDARIA) return;
  const context = getCalendariaContext();
  if (!context) {
    warnCalendariaUnavailable();
    return;
  }

  // Switching from Long Rest to Calendaria starts from "now". Old calendar
  // history must never be interpreted as overdue progression.
  await baselinePlayerActors(context, { force: true });
}

async function confirmProgressionModeChange(previousMode, nextMode) {
  if (!hasFoundryDialogApi()) return true;
  const nextLabel = progressionModeLabel(nextMode);
  const message = nextMode === STATE_PROGRESSION_MODES.CALENDARIA
    ? qaLocalize(
        "StateProgression.ModeConfirmCalendaria",
        "State progression will be triggered by Calendaria. The current date becomes the starting point; earlier calendar days will not be processed.")
    : qaLocalize(
        "StateProgression.ModeConfirmLongRest",
        "State progression will be triggered only by Long Rest. Calendaria day changes will no longer advance player states.");

  return confirmDangerAction({
    title: qaLocalize("StateProgression.ModeConfirmTitle", "Change state progression"),
    heading: qaLocalize("StateProgression.ModeConfirmHeading", "Use {mode}?", { mode: nextLabel }),
    message,
    warning: qaLocalize("StateProgression.ModeConfirmWarning", "The two progression modes are mutually exclusive."),
    confirmLabel: qaLocalize("StateProgression.ModeConfirmApply", "Change mode"),
    cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
    icon: nextMode === STATE_PROGRESSION_MODES.CALENDARIA ? "fas fa-calendar-day" : "fas fa-campground",
    width: 470
  });
}

async function handleCalendariaReady(data = null) {
  // Calendaria emits `calendarSwitched` once during CalendarManager.initialize()
  // before it emits `calendaria.ready`. That startup event only announces the
  // persisted active calendar and must not be treated as a user-initiated switch.
  markCalendariaReady(data);
  if (!usesCalendariaStateProgression()) return;
  calendariaUnavailableWarned = false;
  const context = getCalendariaContext();
  if (!context) {
    // The ready hook itself proves Calendaria is present. A missing context at
    // this point means no active calendar/API context, not a disabled module.
    console.warn(`${MODULE_ID} | Calendaria ready fired without an active calendar context`);
    return;
  }

  if (isActiveQuickAccessGM()) {
    await ensureMissingPlayerBaselines(context);
    warnIfAnyMarkersAhead(context);
  }
  if (!game.user?.isGM) await checkCurrentPlayerPending();
}

async function handleCalendariaCalendarSwitch() {
  // Calendaria deliberately fires calendarSwitched during its own world startup,
  // before calendaria.ready. Ignore that initialization signal. The ready handler
  // establishes any missing baselines against the final persisted calendar.
  if (!hasCalendariaReadyFired()) return;
  if (!usesCalendariaStateProgression() || !isActiveQuickAccessGM()) return;
  const context = getCalendariaContext();
  if (!context) return;

  await baselinePlayerActors(context, { force: true });
  ui.notifications?.info?.(qaLocalize(
    "StateProgression.CalendarChanged",
    "Calendaria changed its active calendar. Player state progression was re-baselined to the current date; no states were advanced."));
}

async function handleCalendariaDayChange(data) {
  if (!usesCalendariaStateProgression()) return;
  const api = getCalendariaApi();
  if (!api?.daysBetween) return;

  const previous = calendariaHookComponentToPublicDate(data?.previous);
  const current = calendariaHookComponentToPublicDate(data?.current);
  if (!previous || !current) return;

  let delta;
  try {
    delta = Number(api.daysBetween(previous, current));
  } catch (error) {
    console.error(`${MODULE_ID} | could not calculate Calendaria day change`, error);
    return;
  }
  if (!Number.isSafeInteger(delta) || delta === 0) return;

  if (delta < 0) {
    if (isActiveQuickAccessGM()) {
      ui.notifications?.info?.(qaLocalize(
        "StateProgression.RewindIgnored",
        "Calendaria moved backwards. Player states were not reversed and already processed days will not be processed again."));
    }
    return;
  }

  const context = getCalendariaContext();
  const hookCalendarId = data?.calendar?.metadata?.id ?? data?.calendar?.id;
  if (!context || !sameCalendariaDay(context.date, current) || (hookCalendarId && hookCalendarId !== context.calendarId)) return;

  if (delta > 1) {
    if (isActiveQuickAccessGM()) await handleCalendariaMultiDayJump(previous, context, delta);
    return;
  }

  if (isActiveQuickAccessGM()) {
    await prepareGMSummary(context, { reason: "day-change" });
    warnIfAnyMarkersAhead(context);
  }
  if (!game.user?.isGM) await checkCurrentPlayerPending({ context });
}

async function handleCalendariaMultiDayJump(previousDate, context, delta) {
  const summary = await prepareGMSummary(context, { reason: "time-skip", skipBaselineMutation: true });
  if (!summary?.entries.size) return;
  if (delta > MAX_AUTOMATIC_CALENDAR_DAYS) {
    ui.notifications?.warn?.(tooManyDaysDetail(delta));
    return;
  }

  const approvals = [];
  for (const entry of summary.entries.values()) {
    const actor = entry.actor;
    const marker = getActorCalendarMarker(actor);
    const pending = pendingDaysForActor(actor, context);
    if (!marker || marker.calendarId !== context.calendarId) {
      await baselineActor(actor.id, context);
      updateGMSummaryStatus(summary, actor.id, summaryStatusForActor(entry, context));
      continue;
    }
    if (!entry.primaryUser?.active) {
      if (pending > 0 && !needsCalendarReview(actor, context)) updateGMSummaryStatus(summary, actor.id, {
        state: "offline", days: pending, detail: qaLocalize("StateProgression.OfflineTimeSkipPending",
          "Player is offline. The time skip remains pending for the GM.")
      });
      continue;
    }
    if (pending && !getPendingAddictions(actor).length && !needsCalendarReview(actor, context)) {
      approvals.push({ entry, marker, pending, days: Math.min(pending, MAX_AUTOMATIC_CALENDAR_DAYS) });
    }
  }
  if (!approvals.length || !isLiveCalendarDay(context)) return;

  const message = qaLocalize("StateProgression.TimeSkipMessage", "Calendaria moved from {from} to {to}.", {
    from: formatCalendariaDate(previousDate), to: formatCalendariaDate(context.date)
  });
  const backlog = approvals.map(({ entry, days, pending }) => qaLocalize("StateProgression.TimeSkipBacklog",
    "{actor}: up to {process} of {pending} pending days", { actor: entry.actor.name, process: days, pending }));
  const confirmed = await confirmDangerAction({
    title: qaLocalize("StateProgression.TimeSkipTitle", "Calendaria time skip"),
    heading: qaLocalize("StateProgression.TimeSkipHeading", "Process pending days after the calendar jump?"),
    message: [message, ...backlog].join("\n"),
    messageHtml: [message, ...backlog].map(escapeHtml).join("<br>"),
    warning: timeSkipWarning(),
    confirmLabel: qaLocalize("StateProgression.TimeSkipApply", "Process time skip"),
    cancelLabel: qaLocalize("StateProgression.TimeSkipLater", "Leave pending"),
    icon: "fas fa-calendar-plus",
    width: 500
  });
  if (!confirmed) return;
  for (const { entry, marker, days } of approvals) {
    const proceed = await applyAutomaticDaysFromSummary(summary, entry, context, days, { marker, requireOnline: true });
    if (!proceed) break;
  }
}

async function applyAutomaticDaysFromSummary(state, entry, context, days, { marker, requireOnline = false }) {
  const actorId = entry.actor.id;
  if (state.statuses.get(actorId)?.state === "processing") return true;
  updateGMSummaryStatus(state, actorId, { state: "processing", days });
  try {
    const result = await processActorAutomaticDays(actorId, context, days, {
      approvedMarker: marker, requireOnline, maxDays: days
    });
    const live = resolveAssignedActorEntry(actorId);
    const detail = result.detail || (result.pendingManual ? manualEnduranceDetail()
      : result.limitedDays > 0
        ? qaLocalize("StateProgression.AutomaticDaysLimited", "Processed {processed} calendar days. {remaining} days remain pending.", {
          processed: result.processedDays, remaining: result.limitedDays
        })
        : qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: result.processedDays }));
    updateGMSummaryStatus(state, actorId, {
      ...summaryStatusForActor(live, context), days: result.limitedDays, result, detail,
      state: result.failedDays ? "error" : result.limitedDays > 0 || result.pendingManual ? "blocked" : "done"
    });
    await sendPlayerResults(live, context, result);
    return !result.failedDays;
  } catch (error) {
    showCalendarError(error);
    updateGMSummaryStatus(state, actorId, {
      ...summaryStatusForActor(entry, context), detail: error.message
    });
    return !["invalid-calendar-date", "stale-calendar-day", "no-active-gm"].includes(error.code);
  }
}

async function processActorAutomaticDays(actorId, context, requestedDays, options = {}) {
  return enqueueCalendarActor(actorId, context, async (entry, liveContext) => {
    const { actor } = entry;
    const marker = getActorCalendarMarker(actor);
    assertCalendarReviewClear(actor, liveContext);
    if (Object.hasOwn(options, "approvedMarker") && !documentValuesEqual(marker, options.approvedMarker)) {
      throw progressionError("stale-calendar-marker", pendingChangedDetail());
    }
    const status = calculateActorCalendarStatus(marker, liveContext);
    if (status.status === "unavailable") throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, liveContext));
    const pending = Math.max(0, status.days ?? 0);
    const requested = Math.min(pending, Math.max(0, Math.floor(requestedDays) || 0));
    const limit = Math.min(options.maxDays ?? DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT, MAX_AUTOMATIC_CALENDAR_DAYS);
    const count = Math.min(requested, limit);
    const result = {
      mode: "automatic", requestedDays: requested, processedDays: 0, limitedDays: pending,
      failedDays: 0, failedActions: 0, pendingManual: getPendingAddictions(actor).length, days: []
    };
    if (count <= 0 || result.pendingManual || (options.requireOnline && !entry.primaryUser?.active)) return result;

    // Check the whole approved range before any write, including the endpoint
    // used by the shortcut for days with only Short Rest bookkeeping.
    const endDate = checkedAddDays(actor, liveContext, marker.date, count);
    const dates = [];
    let cursor = marker.date;
    for (let index = 0; index < count; index += 1) {
      const next = count === 1 ? endDate : checkedAddDays(actor, liveContext, cursor, 1);
      dates.push(next);
      cursor = next;
    }
    if (!sameCalendariaDay(cursor, endDate)) {
      throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, liveContext));
    }

    let expectedMarker = marker;
    for (const [index, date] of dates.entries()) {
      if (index > 0 && !isLiveCalendarDay(liveContext)) break;
      const day = { ...liveContext, date };
      let applied;
      try {
        resolveAssignedActorEntry(actorId);
        const plan = await buildCalendarPlan(actor, day);
        if (!isLiveCalendarDay(liveContext)) {
          if (!index) throw progressionError("stale-calendar-day", pendingChangedDetail());
          break;
        }
        resolveAssignedActorEntry(actorId);
        if (!documentValuesEqual(getActorCalendarMarker(actor), expectedMarker)) {
          throw progressionError("stale-calendar-marker", pendingChangedDetail());
        }
        result.pendingManual = getPendingAddictions(actor).length;
        if (result.pendingManual) break;
        const selected = plan.actions.filter(action => action.checked);
        const empty = !getNewDayProviders().length && plan.actions.every(action => action.kind === "short-rest-reset");
        applied = await applyCalendarPlan(actor, day, plan, selected.map(action => action.id));
        result.days.push({ date, result: serializeNewDayResult(applied) });
        if (applied.failed.length) {
          result.failedDays = 1;
          result.failedActions = applied.failed.length;
          result.detail = applied.outcomeUnknown || applied.partiallyApplied ? calendarReviewDetail()
            : qaLocalize("StateProgression.DayStopped", "The day stopped. Its marker remains pending.");
          break;
        }
        const markerContext = empty ? { ...day, date: endDate } : day;
        expectedMarker = await commitCalendarDay(actor, markerContext, applied, expectedMarker,
          empty || index === dates.length - 1 ? {} : { render: false });
        result.processedDays = empty ? count : result.processedDays + 1;
        if (empty) break;
      } catch (error) {
        if (error.code === "stale-calendar-day" && !result.processedDays) throw error;
        result.failedDays = 1;
        result.failedActions = error.failedActions ?? 1;
        if (isUnknownWriteOutcome(error)) result.outcomeUnknown = true;
        result.detail = error.message;
        if (needsCalendarReview(actor, day)) result.detail = calendarReviewDetail();
        if (error.code === "provider-build-failed") showCalendarError(error);
        break;
      }
      result.pendingManual = getPendingAddictions(actor).length;
      if (result.pendingManual) break;
    }
    result.pendingManual = getPendingAddictions(actor).length;
    result.limitedDays = pending - result.processedDays;
    return result;
  });
}

function checkedAddDays(actor, context, from, amount) {
  try {
    const date = normalizeCalendariaDate(context.api.addDays({ ...from }, amount));
    if (date && context.api.daysBetween(from, date) === amount) return date;
  } catch (error) {
    console.error(`${MODULE_ID} | Calendaria addDays failed`, error);
  }
  throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, context));
}

function invalidCalendarDateDetail(actor, context) {
  return qaLocalize("StateProgression.InvalidDateCalculation",
    "Calendaria could not calculate a valid date for {actor} in calendar {calendar}. The operation stopped.", {
      actor: actor?.name, calendar: context?.calendarId
    });
}

function timeSkipWarning() {
  return qaLocalize("StateProgression.TimeSkipWarning",
    "This can resolve injuries, wash states, addictions and other daily conditions. Moving the calendar backwards will not undo these changes.");
}

function tooManyDaysDetail(days) {
  return qaLocalize("StateProgression.TooManyDaysWarning",
    "Calendaria advanced by {days} days. Quick Access will not automatically simulate more than {max} days at once.", {
      days, max: MAX_AUTOMATIC_CALENDAR_DAYS
    });
}

async function checkCurrentPlayerPending({ context = null } = {}) {
  if (game.user?.isGM || !usesCalendariaStateProgression()) return null;
  const actor = resolveUserCharacter(game.user, game.actors);
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return null;

  context ??= getCalendariaContext();
  if (!context) return null;
  const marker = getActorCalendarMarker(actor);

  if (!marker || marker.calendarId !== context.calendarId) {
    try {
      await executeAsActiveGM(REPORT_OPERATION, { actorId: actor.id, targetDate: context.date, calendarId: context.calendarId });
    } catch (error) {
      console.error(`${MODULE_ID} | could not establish Calendaria progression baseline`, error);
    }
    return null;
  }

  const status = calculateActorCalendarStatus(marker, context);
  if (status.status === "current" || status.status === "ahead") return null;
  if (status.status === "pending-multiple") {
    try {
      await executeAsActiveGM(REPORT_OPERATION, { actorId: actor.id, targetDate: context.date, calendarId: context.calendarId });
      ui.notifications?.info?.(qaLocalize(
        "StateProgression.MultiplePendingPlayer",
        "Several Calendaria days are pending for {actor}. The GM summary can resolve the accumulated progression.",
        { actor: actor.name ?? "" }
      ));
    } catch (error) {
      console.error(`${MODULE_ID} | could not report pending Calendaria progression`, error);
    }
    return null;
  }
  if (status.status !== "pending") return null;

  const promptKey = `${actor.id}:${context.calendarId}:${calendariaDateKey(context.date)}`;
  if (activePlayerPrompts.has(promptKey)) return null;
  activePlayerPrompts.add(promptKey);

  try {
    const result = await openNewDayDialog(null, actor, {
      source: "calendaria",
      allowDelegatedApply: true,
      targetDate: context.date,
      dayKey: addictionCalendarDayKey(context.calendarId, context.date),
      applyHandler: async ({ selectedIds, selectedPreconditions }) => executeAsActiveGM(APPLY_OPERATION, {
        actorId: actor.id,
        targetDate: context.date,
        calendarId: context.calendarId,
        selectedIds,
        selectedPreconditions
      })
    });

    if (result?.calendarResult) await showPlayerResult(actor, context, result.calendarResult);
    else if (!result) {
      try {
        await executeAsActiveGM(REPORT_OPERATION, { actorId: actor.id, targetDate: context.date, calendarId: context.calendarId });
      } catch (_error) {
        // Closing the player window simply leaves the day pending.
      }
    }
    return result;
  } catch (error) {
    const code = String(error?.code ?? "");
    if (code === "multi-day-pending" || code === "stale-calendar-day") {
      ui.notifications?.warn?.(qaLocalize("StateProgression.StalePlayerDialog", "The calendar changed while this window was open. The GM summary now holds the pending progression."));
    } else {
      console.error(`${MODULE_ID} | Calendaria player progression failed`, error);
      ui.notifications?.error?.(qaLocalize("StateProgression.ApplyFailed", "Could not apply Calendaria state progression."));
    }
    return null;
  } finally {
    activePlayerPrompts.delete(promptKey);
  }
}

async function handleCalendariaApplyRequest(payload, context) {
  const target = { calendarId: payload?.calendarId, date: normalizeCalendariaDate(payload?.targetDate) };
  const selected = readNewDaySelection(payload);
  return enqueueCalendarActor(payload?.actorId, target, async (entry, live) => {
    assertRequesterAssignedToActor(entry, context.requestUser);
    const { actor } = entry;
    assertCalendarReviewClear(actor, live);
    const marker = getActorCalendarMarker(actor);
    const status = calculateActorCalendarStatus(marker, live);
    const pendingManual = getPendingAddictions(actor).length;
    if (pendingManual) {
      updateCurrentGMSummary(actor.id, live, summaryStatusForActor(entry, live));
      return { status: "awaiting-endurance", calendarResult: { ...emptyCalendarResult(live.date), pendingManual } };
    }
    if (status.status === "baseline") {
      await setActorCalendarMarker(actor, live);
      updateCurrentGMSummary(actor.id, live, summaryStatusForActor(entry, live));
      return { status: "baseline", calendarResult: emptyCalendarResult(live.date) };
    }
    if (status.status === "current") {
      return { status: isAbsentMarkerForContext(marker, live) ? "already-skipped" : "already-processed", calendarResult: emptyCalendarResult(live.date) };
    }
    if (status.status === "ahead") throw progressionError("stale-calendar-day", pendingChangedDetail());
    if (status.status === "unavailable") throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, live));
    if (status.days !== 1) throw progressionError("multi-day-pending", "Multiple Calendaria days are pending");

    const plan = await buildCalendarPlan(actor, live);
    requireLiveCalendarDay(live);
    assertRequesterAssignedToActor(resolveAssignedActorEntry(actor.id), context.requestUser);
    if (getPendingAddictions(actor).length || !documentValuesEqual(getActorCalendarMarker(actor), marker)
      || getStaleNewDayActions(plan, selected, payload.selectedPreconditions).length) {
      throw progressionError("stale-plan", qaLocalize("NewDay.StalePlan", "The preview is out of date. Open a new preview."));
    }

    updateCurrentGMSummary(actor.id, live, { state: "processing", days: 1 });
    const applied = await applyCalendarPlan(actor, live, plan, selected);
    const calendarResult = {
      mode: "interactive", processedDays: 0, failedDays: 0, failedActions: 0,
      pendingManual: getPendingAddictions(actor).length,
      days: [{ date: live.date, result: serializeNewDayResult(applied) }]
    };
    let detail = "";
    if (applied.failed.length) {
      calendarResult.failedDays = 1;
      calendarResult.failedActions = applied.failed.length;
      detail = needsCalendarReview(actor, live) ? calendarReviewDetail()
        : qaLocalize("StateProgression.DayStopped", "The day stopped. Its marker remains pending.");
    } else {
      try {
        await commitCalendarDay(actor, live, applied, marker);
        calendarResult.processedDays = 1;
      } catch (error) {
        calendarResult.failedDays = 1;
        calendarResult.failedActions = 1;
        if (isUnknownWriteOutcome(error)) calendarResult.outcomeUnknown = true;
        detail = needsCalendarReview(actor, live) ? calendarReviewDetail() : error.message;
      }
    }
    if (detail) calendarResult.detail = detail;
    updateCurrentGMSummary(actor.id, live, {
      ...summaryStatusForActor(entry, live), ...(detail && { state: "error", detail }), result: calendarResult
    });
    return { status: calendarResult.failedDays ? "stopped" : "processed", calendarResult };
  });
}

async function buildCalendarPlan(actor, day) {
  const plan = await buildNewDayPlanWithProviders(actor, {
    dayKey: addictionCalendarDayKey(day.calendarId, day.date), authority: calendarAuthority()
  });
  if (!plan.providerErrors.length) return plan;
  const providers = plan.providerErrors.map(error => error.providerId).join(", ");
  const message = qaLocalize("StateProgression.ProviderBuildFailed",
    "{actor} ({date}): could not build New Day actions for {providers}. The date remains pending.", {
      actor: actor.name, date: formatCalendariaDate(day.date), providers
    });
  whisperToGM(message);
  throw Object.assign(progressionError("provider-build-failed", message), { failedActions: plan.providerErrors.length });
}

async function applyCalendarPlan(actor, day, plan, selected) {
  const applied = await applyNewDayPlanInternal(actor, plan, selected, {
    postChat: false, suppressNotifications: true, authority: calendarAuthority(), dateLabel: formatCalendariaDate(day.date)
  });
  if (applied.failed.length && (applied.partiallyApplied || applied.outcomeUnknown)) actorsNeedingReview.set(actor.id, day.calendarId);
  return applied;
}

function calendarAuthority() {
  const user = game.user;
  return { requestUser: user, requesterId: user.id, activeGM: user, isRemote: false };
}

async function commitCalendarDay(actor, day, applied, expectedMarker, documentOptions) {
  const completed = applied.succeeded.filter(entry => entry.changed);
  if (!documentValuesEqual(getActorCalendarMarker(actor), expectedMarker)) {
    if (!completed.length) throw progressionError("stale-calendar-marker", pendingChangedDetail());
    const error = progressionError("stale-calendar-marker", qaLocalize("StateProgression.MarkerChangedDuringDay",
      "{actor} ({date}): the Calendaria marker changed during New Day. Confirmed actions: {completed}. Check the sheet before trying again.", {
        actor: actor.name, date: formatCalendariaDate(day.date), completed: completed.map(entry => entry.action.itemName).join(", ")
      }));
    actorsNeedingReview.set(actor.id, day.calendarId);
    whisperToGM(error.message);
    showCalendarError(error);
    throw error;
  }
  return setActorCalendarMarker(actor, day, {}, documentOptions, completed);
}

async function handleCalendariaPendingReport(payload, context) {
  const target = { calendarId: payload?.calendarId, date: normalizeCalendariaDate(payload?.targetDate) };
  return enqueueCalendarActor(payload?.actorId, target, async (entry, live) => {
    assertRequesterAssignedToActor(entry, context.requestUser);
    const { actor } = entry;
    const marker = getActorCalendarMarker(actor);
    if ((!marker || marker.calendarId !== live.calendarId) && !needsCalendarReview(actor, live)) {
      await setActorCalendarMarker(actor, live);
    }
    await prepareGMSummary(live, { reason: "player-report", skipBaselineMutation: true });
    const status = calculateActorCalendarStatus(getActorCalendarMarker(actor), live);
    return { status: status.status, days: status.days ?? 0 };
  });
}

async function prepareGMSummary(context, { reason = "day-change", skipBaselineMutation = false } = {}) {
  if (!isActiveQuickAccessGM()) return null;
  const entries = getAssignedPlayerActors();
  const summary = openOrRefreshGMSummary(context, entries, reason);
  for (const entry of entries) {
    if (summary.statuses.get(entry.actor.id)?.state === "processing") continue;
    if (!skipBaselineMutation && calculateActorCalendarStatus(getActorCalendarMarker(entry.actor), context).status === "baseline") {
      try { await baselineActor(entry.actor.id, context); }
      catch (error) {
        showCalendarError(error);
        updateGMSummaryStatus(summary, entry.actor.id, { state: "error", days: 0, detail: error.message });
        continue;
      }
    }
    const result = summary.statuses.get(entry.actor.id)?.result;
    updateGMSummaryStatus(summary, entry.actor.id, { ...summaryStatusForActor(entry, context), result });
  }
  return summary;
}

function summaryStatusForActor(entry, context) {
  const { actor } = entry;
  const marker = getActorCalendarMarker(actor);
  const status = calculateActorCalendarStatus(marker, context);
  const days = Math.max(0, status.days ?? 0);
  if (needsCalendarReview(actor, context)) return { state: "error", days, detail: calendarReviewDetail(), review: true };
  if (status.status === "current") return { detail: "", ...summaryStatusForCurrentMarker(marker, context), review: false };
  if (status.status === "ahead") return { ...summaryStatusForAheadMarker(marker, status.days), review: false };
  if (status.status === "baseline") return { state: "baseline", days: 0, detail: "", review: false };
  if (status.status === "unavailable") return { state: "error", days: 0, detail: invalidCalendarDateDetail(actor, context), review: false };
  return { state: entry.primaryUser?.active ? "pending" : "offline", days, review: false,
    detail: days > 1 ? qaLocalize("StateProgression.MultiplePendingGM", "Multiple calendar days are pending; GM resolution is required.") : "" };
}

function needsCalendarReview(actor, context) {
  return actorsNeedingReview.get(actor.id) === context.calendarId;
}

function assertCalendarReviewClear(actor, context) {
  if (needsCalendarReview(actor, context)) throw progressionError("calendar-needs-review", calendarReviewDetail());
}

function calendarReviewDetail() {
  return qaLocalize("StateProgression.ReviewBeforeRetry",
    "Check the sheet and the GM whisper, then adjust the marker in Manage Calendaria days before trying again.");
}

function openOrRefreshGMSummary(context, entries, reason) {
  const key = summaryKey(context);

  // Only one calendar-progression summary is useful at a time. Close and drop
  // older dates before opening a newer one, including stale map entries from
  // environments where the Foundry dialog API was unavailable.
  for (const [existingKey, existingState] of gmSummaryWindows) {
    if (existingKey === key) continue;
    gmSummaryWindows.delete(existingKey);
    try {
      existingState.dialog?.close?.();
    } catch (error) {
      console.warn(`${MODULE_ID} | could not close stale state progression summary`, error);
    }
  }

  let state = gmSummaryWindows.get(key);
  if (!state) {
    state = {
      key,
      context,
      entries: new Map(entries.map((entry) => [entry.actor.id, entry])),
      statuses: new Map(),
      dialog: null,
      root: null,
      reason
    };
    gmSummaryWindows.set(key, state);
  } else {
    state.entries = new Map(entries.map(entry => [entry.actor.id, entry]));
    for (const id of state.statuses.keys()) if (!state.entries.has(id)) state.statuses.delete(id);
    state.context = context;
  }

  if (!hasFoundryDialogApi() || state.dialog) {
    state.dialog?.bringToFront?.();
    state.dialog?.bringToTop?.();
    return state;
  }

  state.dialog = createFoundryDialog({
    title: qaLocalize("StateProgression.GMSummaryTitle", "Player state progression — {date}", { date: formatCalendariaDate(context.date) }),
    content: buildGMSummaryContent(state),
    buttons: {},
    render: (html, renderedDialog) => {
      const root = extractDialogElement(renderedDialog ?? html);
      const shell = root?.closest?.(".app, .application") ?? root;
      shell?.classList?.add("fblqa-state-progression-summary");
      state.root = root;
      bindGMSummaryActions(state);
      refreshGMSummaryDom(state);
    },
    close: () => {
      if (gmSummaryWindows.get(key) === state) gmSummaryWindows.delete(key);
    }
  }, {
    classes: ["fblqa-rest-dialog", "fblqa-state-progression-summary"],
    width: 720,
    resizable: true,
    buttonless: true
  });
  state.dialog?.render?.(true);
  return state;
}

function buildGMSummaryContent(state) {
  const hasActors = state.entries.size > 0;
  const rowsHtml = hasActors
    ? Array.from(state.entries.values()).map((entry) => renderGMSummaryRow(state, entry)).join("")
    : `<p class="fblqa-progression-empty">${escapeHtml(qaLocalize("StateProgression.NoAssignedActors", "No characters assigned to non-GM players were found."))}</p>`;
  return `
    <div class="fblqa-progression-summary" data-summary-key="${escapeHtml(state.key)}">
      <div class="fblqa-progression-summary-intro">
        <div class="fblqa-progression-summary-head">
          <div>
            <strong>${escapeHtml(qaLocalize("StateProgression.GMSummaryHeading", "Player states"))}</strong>
            <span>${escapeHtml(qaLocalize("StateProgression.GMSummaryHint", "Only characters assigned to non-GM users are included. Player results are kept out of chat."))}</span>
          </div>
          <span class="fblqa-progression-current-date">${escapeHtml(qaLocalize("StateProgression.CurrentDateLabel", "Current date: {date}", { date: formatCalendariaDate(state.context?.date) }))}</span>
        </div>
        <div class="fblqa-progression-summary-toolbar" ${hasActors ? "" : "hidden"}>
            <button type="button" data-action="reset-all-current">
              <i class="fas fa-calendar-check" aria-hidden="true"></i>
              ${escapeHtml(qaLocalize("StateProgression.ResetAllCurrent", "Reset all to current date"))}
            </button>
            <button type="button" data-action="rewind-all">
              <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
              ${escapeHtml(qaLocalize("StateProgression.RewindAll", "Rewind all…"))}
            </button>
        </div>
      </div>
      <div class="fblqa-progression-summary-rows">${rowsHtml}</div>
    </div>`;
}

function renderGMSummaryRow(state, entry) {
  const status = state.statuses.get(entry.actor.id) ?? { state: entry.primaryUser?.active ? "pending" : "offline", days: 0 };
  const marker = getActorCalendarMarker(entry.actor);
  const markerLabel = marker?.date
    ? qaLocalize("StateProgression.MarkerDate", "Marker: {date}", { date: formatCalendariaDate(marker.date) })
    : qaLocalize("StateProgression.MarkerMissing", "Marker: not set");
  const pendingManual = getPendingAddictions(entry.actor).length;
  const pendingDays = Math.max(0, Number(status.days) || 0);
  const isProcessing = status.state === "processing";
  const review = needsCalendarReview(entry.actor, state.context);
  const canResolve = !review && ["pending", "offline", "error", "blocked"].includes(status.state) && pendingDays > 0 && !pendingManual;
  const canMarkAbsent = !review && ["pending", "offline", "blocked"].includes(status.state) && pendingDays > 0 && !pendingManual;
  const canUndoAbsent = status.state === "absent" && Boolean(status.undoAvailable);
  const canResetCurrent = !isProcessing && (
    review || status.state === "ahead"
    || status.state === "baseline"
    || status.state === "absent"
    || pendingDays > 0
    || !marker?.date
    || marker.calendarId !== state.context?.calendarId
    || !sameCalendariaDay(marker.date, state.context?.date)
  );
  const canRewind = !isProcessing;
  const playerNames = entry.users.map((user) => user.name ?? user.id).filter(Boolean).join(", ") || "—";
  const detail = status.detail || progressionStatusDetail(status);
  const resultDetails = renderGMSummaryResult(status.result);
  const actions = [
    pendingManual ? `<button type="button" data-action="open-stat"><i class="fas fa-list"></i> ${escapeHtml(qaLocalize("StateProgression.OpenStat", "Open STAT"))}</button>` : "",
    canResolve ? `
      <button type="button" class="fblqa-progression-resolve" data-action="resolve">
        <i class="fas fa-list-check" aria-hidden="true"></i>
        ${escapeHtml(qaLocalize("StateProgression.Resolve", "Resolve"))}
      </button>` : "",
    canMarkAbsent ? `
      <button type="button" class="fblqa-progression-absent" data-action="absent">
        <i class="fas fa-user-slash" aria-hidden="true"></i>
        ${escapeHtml(qaLocalize("StateProgression.Absent", "Absent"))}
      </button>` : "",
    canUndoAbsent ? `
      <button type="button" class="fblqa-progression-undo" data-action="undo-absent">
        <i class="fas fa-rotate-left" aria-hidden="true"></i>
        ${escapeHtml(qaLocalize("StateProgression.UndoAbsent", "Undo"))}
      </button>` : "",
    canResetCurrent ? `
      <button type="button" class="fblqa-progression-reset-current" data-action="reset-current">
        <i class="fas fa-calendar-check" aria-hidden="true"></i>
        ${escapeHtml(qaLocalize("StateProgression.ResetCurrent", "Set to current date"))}
      </button>` : "",
    canRewind ? `
      <button type="button" class="fblqa-progression-rewind" data-action="rewind">
        <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
        ${escapeHtml(qaLocalize("StateProgression.Rewind", "Rewind days…"))}
      </button>` : ""
  ].filter(Boolean).join("");

  return `
    <div class="fblqa-progression-summary-row is-${escapeHtml(status.state)}" data-actor-id="${escapeHtml(entry.actor.id)}">
      <div class="fblqa-progression-summary-character">
        <strong>${escapeHtml(entry.actor.name ?? "")}</strong>
        <small>${escapeHtml(playerNames)}</small>
        <small class="fblqa-progression-marker-date">${escapeHtml(markerLabel)}</small>
      </div>
      <div class="fblqa-progression-summary-status">
        <span>${escapeHtml(progressionStatusLabel(status.state))}</span>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
        ${resultDetails}
      </div>
      <div class="fblqa-progression-summary-actions">${actions}</div>
    </div>`;
}


function renderGMSummaryResult(result) {
  const days = Array.isArray(result?.days) ? result.days : [];
  const entries = days.flatMap((day) => (Array.isArray(day?.result?.entries) ? day.result.entries : []).map((entry) => ({
    ...entry,
    date: day?.date
  })));
  if (!entries.length) return "";

  const failed = entries.filter((entry) => entry.ok === false).length;
  const label = failed
    ? qaLocalize("StateProgression.GMChangesWithErrors", "Changes: {count}; errors: {failed}", { count: entries.length, failed })
    : qaLocalize("StateProgression.GMChanges", "Changes: {count}", { count: entries.length });
  const list = entries.map((entry) => {
    const date = days.length > 1 ? `<em>${escapeHtml(formatCalendariaDate(entry.date))}</em> ` : "";
    return `<li class="${entry.ok === false ? "is-failed" : "is-ok"}">${date}<strong>${escapeHtml(entry.itemName ?? "")}</strong>${entry.detail ? `: ${escapeHtml(entry.detail)}` : ""}</li>`;
  }).join("");
  return `<details class="fblqa-progression-summary-details"><summary>${escapeHtml(label)}</summary><ul>${list}</ul></details>`;
}

function updateGMSummaryStatus(state, actorId, status) {
  if (!state) return;
  const pendingManual = getPendingAddictions(state.entries.get(actorId)?.actor).length;
  if (pendingManual && status.state !== "processing" && status.state !== "error") {
    status = { ...status, state: "blocked", pendingManual, detail: manualEnduranceDetail() };
  }
  state.statuses.set(actorId, { ...(state.statuses.get(actorId) ?? {}), ...status, pendingManual });
  refreshGMSummaryDom(state);
}

function updateCurrentGMSummary(actorId, context, status) {
  if (!isActiveQuickAccessGM()) return;
  const state = gmSummaryWindows.get(summaryKey(context));
  if (state) updateGMSummaryStatus(state, actorId, status);
}

function refreshGMSummaryDom(state) {
  const container = state.root?.querySelector?.(".fblqa-progression-summary-rows");
  if (!container) return;
  container.innerHTML = state.entries.size
    ? Array.from(state.entries.values()).map((entry) => renderGMSummaryRow(state, entry)).join("")
    : `<p class="fblqa-progression-empty">${escapeHtml(qaLocalize("StateProgression.NoAssignedActors", "No characters assigned to non-GM players were found."))}</p>`;
  const toolbar = state.root?.querySelector?.(".fblqa-progression-summary-toolbar");
  if (toolbar) toolbar.hidden = !state.entries.size;
}

function bindGMSummaryActions(state) {
  const root = state.root;
  if (!root || root.dataset?.fblqaSummaryBound === "true") return;
  if (root.dataset) root.dataset.fblqaSummaryBound = "true";

  root.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("button[data-action]");
    if (!button || button.disabled || !root.contains(button)) return;
    event.preventDefault();
    const action = String(button.dataset.action ?? "");
    const actorId = button.closest?.("[data-actor-id]")?.dataset?.actorId;
    button.disabled = true;
    try {
      if (action === "reset-all-current" || action === "reset-current") await changeMarkersFromGMSummary(state, actorId, "reset");
      else if (action === "rewind-all" || action === "rewind") await changeMarkersFromGMSummary(state, actorId, "rewind");
      else if (action === "resolve") await resolveActorFromGMSummary(state, actorId);
      else if (action === "absent") await markActorAbsentFromGMSummary(state, actorId);
      else if (action === "undo-absent") await undoActorAbsentFromGMSummary(state, actorId);
      else if (action === "open-stat") {
        const sheet = state.entries.get(actorId)?.actor?.sheet;
        if (sheet) {
          sheet._customActiveTab = "conditions";
          sheet.render?.(true);
        }
      }
    } catch (error) {
      showCalendarError(error);
      if (error.code === "stale-calendar-day") await openStateProgressionManager();
    } finally {
      button.disabled = false;
    }
  });
}

async function markActorAbsentFromGMSummary(state, actorId) {
  if (!isActiveQuickAccessGM()) return;
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = getCalendariaContext();
  if (!context || context.calendarId !== state.context.calendarId || !sameCalendariaDay(context.date, state.context.date)) return;

  try {
    const skipped = await markActorCalendariaAbsent(entry.actor, context);
    if (!skipped.changed) {
      const marker = getActorCalendarMarker(entry.actor);
      updateGMSummaryStatus(state, actorId, summaryStatusForCurrentMarker(marker, context));
      return;
    }
    updateGMSummaryStatus(state, actorId, {
      state: "absent",
      days: 0,
      skippedDays: skipped.skippedDays,
      undoAvailable: true,
      detail: qaLocalize(
        "StateProgression.AbsentDetail",
        "Skipped {days} calendar days; character states were not changed.",
        { days: skipped.skippedDays }
      )
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not mark player character absent`, error);
    ui.notifications?.error?.(qaLocalize("StateProgression.AbsentFailed", "Could not mark the character absent for this calendar batch."));
  }
}

async function undoActorAbsentFromGMSummary(state, actorId) {
  if (!isActiveQuickAccessGM()) return;
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = getCalendariaContext();
  if (!context || context.calendarId !== state.context.calendarId || !sameCalendariaDay(context.date, state.context.date)) return;

  try {
    const undone = await undoActorCalendariaAbsent(entry.actor, context);
    if (!undone.changed) return;
    const pending = calculateActorCalendarStatus(getActorCalendarMarker(entry.actor), context);
    updateGMSummaryStatus(state, actorId, {
      state: entry.primaryUser?.active ? "pending" : "offline",
      days: Math.max(0, Number(pending.days) || 0),
      skippedDays: 0,
      undoAvailable: false,
      detail: qaLocalize("StateProgression.AbsentUndone", "Absence was undone; state progression is pending again."),
      result: null
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not undo absent calendar batch`, error);
    ui.notifications?.error?.(qaLocalize("StateProgression.UndoAbsentFailed", "Could not restore the pending calendar progression."));
  }
}

async function resolveActorFromGMSummary(state, actorId) {
  if (!isActiveQuickAccessGM()) return;
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = requireLiveCalendarDay(state.context);
  assertCalendarReviewClear(entry.actor, context);
  const marker = getActorCalendarMarker(entry.actor);
  const status = calculateActorCalendarStatus(marker, context);
  const days = Math.max(0, Number(status.days) || 0);
  if (getPendingAddictions(entry.actor).length) {
    ui.notifications?.warn?.(manualEnduranceDetail());
    if (entry.actor.sheet) {
      entry.actor.sheet._customActiveTab = "conditions";
      entry.actor.sheet.render?.(true);
    }
    return;
  }
  if (status.status === "ahead") {
    updateGMSummaryStatus(state, actorId, summaryStatusForAheadMarker(marker, status.days));
    return;
  }
  if (!days) {
    updateGMSummaryStatus(state, actorId, summaryStatusForCurrentMarker(marker, context));
    return;
  }

  if (days > 1) {
    const count = Math.min(days, MAX_AUTOMATIC_CALENDAR_DAYS);
    const confirmed = await confirmDangerAction({
      title: qaLocalize("StateProgression.ResolveTitle", "Resolve pending state progression"),
      heading: qaLocalize("StateProgression.ResolveHeading", "Process {days} days for {actor}?", { days: count, actor: entry.actor.name ?? "" }),
      message: qaLocalize("StateProgression.TimeSkipBacklog", "{actor}: up to {process} of {pending} pending days", {
        actor: entry.actor.name, process: count, pending: days
      }),
      warning: timeSkipWarning(),
      confirmLabel: qaLocalize("StateProgression.Resolve", "Resolve"),
      cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
      icon: "fas fa-list-check",
      width: 470
    });
    if (!confirmed) return;
    await applyAutomaticDaysFromSummary(state, entry, context, count, { marker });
    return;
  }

  const result = await openNewDayDialog(null, entry.actor, {
    source: "calendaria-gm",
    targetDate: context.date,
    dayKey: addictionCalendarDayKey(context.calendarId, context.date),
    applyHandler: async ({ selectedIds, selectedPreconditions }) => executeAsActiveGM(APPLY_OPERATION, {
      actorId: entry.actor.id,
      targetDate: context.date,
      calendarId: context.calendarId,
      selectedIds,
      selectedPreconditions
    })
  });
  if (result?.calendarResult) await sendPlayerResults(resolveAssignedActorEntry(actorId), context, result.calendarResult);
}

async function changeMarkersFromGMSummary(state, actorId, action) {
  const context = requireLiveCalendarDay(state.context, { requireMode: false });
  const entries = actorId ? [state.entries.get(actorId)].filter(Boolean) : [...state.entries.values()];
  if (!entries.length) return;
  const approvals = entries.map(({ actor }) => ({ id: actor.id, marker: getActorCalendarMarker(actor) }));
  const date = formatCalendariaDate(context.date);
  let days;
  if (action === "rewind") {
    days = await promptRewindDays({ actorName: actorId ? entries[0].actor.name : null });
    if (days === null) return;
  } else if (!actorId) {
    const confirmed = await confirmDangerAction({
      title: qaLocalize("StateProgression.ResetAllConfirmTitle", "Reset all Calendaria markers?"),
      heading: qaLocalize("StateProgression.ResetAllConfirmHeading", "Set the current date ({date}) for all player characters?", { date }),
      message: qaLocalize("StateProgression.ResetAllConfirmMessage", "Set the marker for each displayed character. Pending days will be marked caught up."),
      warning: qaLocalize("StateProgression.ResetAllConfirmWarning", "The character sheet will stay as it is."),
      confirmLabel: qaLocalize("StateProgression.ResetAllCurrent", "Reset all to current date"),
      cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
      icon: "fas fa-calendar-check",
      width: 480
    });
    if (!confirmed) return;
  }

  for (const approval of approvals) {
    const entry = state.entries.get(approval.id);
    if (!entry || state.statuses.get(approval.id)?.state === "processing") continue;
    updateGMSummaryStatus(state, approval.id, { state: "processing", detail: "" });
    try {
      const marker = await changeActorMarker(approval.id, context, action, days, approval.marker);
      updateGMSummaryStatus(state, approval.id, {
        ...summaryStatusForActor(entry, context), result: null,
        detail: action === "rewind"
          ? qaLocalize("StateProgression.RewindDone", "Rewound {days} day(s) to {date}. Days are pending again.", {
            days, date: formatCalendariaDate(marker.date)
          })
          : qaLocalize("StateProgression.ResetCurrentDone", "Marker reset to the current date ({date}).", { date })
      });
    } catch (error) {
      updateGMSummaryStatus(state, approval.id, { ...summaryStatusForActor(entry, context), detail: error.message });
      throw error;
    }
  }
}

function promptRewindDays({ actorName = null } = {}) {
  if (!hasFoundryDialogApi()) return Promise.resolve(null);
  const heading = actorName
    ? qaLocalize("StateProgression.RewindHeading", "Rewind Calendaria marker for {actor}", { actor: actorName })
    : qaLocalize("StateProgression.RewindAllHeading", "Rewind Calendaria marker for all player characters");
  const content = `
    <form class="fblqa-progression-rewind-form">
      <p><strong>${escapeHtml(heading)}</strong></p>
      <label class="fblqa-rest-field">
        <span>${escapeHtml(qaLocalize("StateProgression.RewindDaysLabel", "Days to rewind"))}</span>
        <input type="number" name="rewindDays" min="1" max="${MAX_AUTOMATIC_CALENDAR_DAYS}" step="1" value="1" required>
      </label>
      <p class="fblqa-rest-note">${escapeHtml(qaLocalize("StateProgression.RewindWarning", "Rewinding only moves the Calendaria processed-day marker backwards and does NOT reverse already applied injury, condition, or addiction changes. Those days will become pending again."))}</p>
    </form>`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = createFoundryDialog({
      title: qaLocalize("StateProgression.RewindTitle", "Rewind Calendaria processed days"),
      content,
      buttons: {
        rewind: {
          icon: '<i class="fas fa-clock-rotate-left"></i>',
          label: qaLocalize("StateProgression.RewindApply", "Rewind"),
          callback: (html, _event, button, renderedDialog) => {
            const form = findDialogForm(button?.form ?? renderedDialog ?? html, "form");
            const days = Number(form?.querySelector?.('input[name="rewindDays"]')?.value);
            if (!Number.isSafeInteger(days) || days < 1 || days > MAX_AUTOMATIC_CALENDAR_DAYS) {
              ui.notifications?.error?.(invalidRewindDaysDetail());
              finish(null);
              return;
            }
            finish(days);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: qaLocalize("Common.Cancel", "Cancel"),
          callback: () => finish(null)
        }
      },
      default: "rewind",
      close: () => finish(null)
    }, {
      classes: ["fblqa-condition-dialog", "fblqa-progression-rewind-dialog"],
      width: 440
    });
    if (!dialog) {
      finish(null);
      return;
    }
    dialog.render(true);
  });
}

function invalidRewindDaysDetail() {
  return qaLocalize("StateProgression.InvalidRewindDays", "Enter a whole number of days between 1 and {max}.", {
    max: MAX_AUTOMATIC_CALENDAR_DAYS
  });
}

export async function openStateProgressionManager() {
  if (!isActiveQuickAccessGM()) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerGmOnly", "Only the active GM can manage Calendaria processed days."));
    return null;
  }
  const context = getCalendariaContext();
  if (!context) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerUnavailable", "Calendaria day management is unavailable."));
    return null;
  }
  return prepareGMSummary(context, { reason: "manager", skipBaselineMutation: true });
}

function changeActorMarker(actorId, context, action, days, approvedMarker) {
  return enqueueCalendarActor(actorId, context, async ({ actor }, live) => {
    const marker = getActorCalendarMarker(actor);
    if (!documentValuesEqual(marker, approvedMarker)) throw progressionError("stale-calendar-marker", pendingChangedDetail());
    let date = live.date;
    if (action === "rewind") {
      if (!Number.isSafeInteger(days) || days < 1 || days > MAX_AUTOMATIC_CALENDAR_DAYS) {
        throw progressionError("invalid-rewind-days", invalidRewindDaysDetail());
      }
      const status = calculateActorCalendarStatus(marker, live);
      if (status.status === "unavailable") throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, live));
      const base = status.status === "ahead" || status.status === "baseline" ? live.date : marker.date;
      date = checkedAddDays(actor, live, base, -days);
    }
    const saved = await setActorCalendarMarker(actor, { ...live, date });
    actorsNeedingReview.delete(actorId);
    return saved;
  }, { requireMode: false });
}

async function baselinePlayerActors(context, { force = false } = {}) {
  for (const { actor } of getAssignedPlayerActors()) await baselineActor(actor.id, context, force);
}

function baselineActor(actorId, context, force = false) {
  return enqueueCalendarActor(actorId, context, async ({ actor }, live) => {
    const marker = getActorCalendarMarker(actor);
    if (needsCalendarReview(actor, live) || (!force && marker?.calendarId === live.calendarId)) return;
    await setActorCalendarMarker(actor, live);
  });
}

async function ensureMissingPlayerBaselines(context) {
  return baselinePlayerActors(context);
}

function enqueueCalendarActor(actorId, context, operation, options) {
  if (typeof actorId !== "string" || !actorId) throw progressionError("actor-not-assigned", "Actor is not assigned to a player");
  return enqueueActorMutation(actorId, () => {
    const live = requireLiveCalendarDay(context, options);
    return operation(resolveAssignedActorEntry(actorId), live);
  });
}

function getLiveCalendarDay(context, { requireMode = true } = {}) {
  const live = getCalendariaContext();
  return isActiveQuickAccessGM() && (!requireMode || usesCalendariaStateProgression())
    && live?.calendarId === context?.calendarId && sameCalendariaDay(live?.date, context?.date) ? live : null;
}

function isLiveCalendarDay(context) {
  return Boolean(getLiveCalendarDay(context));
}

function requireLiveCalendarDay(context, options) {
  if (!isActiveQuickAccessGM()) throw progressionError("no-active-gm", "The active GM changed");
  const live = getLiveCalendarDay(context, options);
  if (!live) throw progressionError("stale-calendar-day", pendingChangedDetail());
  return live;
}

function pendingChangedDetail() {
  return qaLocalize("StateProgression.PendingChanged", "The calendar date or pending days changed. Review the current summary before confirming again.");
}

function pendingDaysForActor(actor, context) {
  const status = calculateActorCalendarStatus(getActorCalendarMarker(actor), context);
  return Math.max(0, Number(status.days) || 0);
}

export function getActorCalendarMarker(actor) {
  let raw = null;
  try {
    raw = readActorFlag(actor, FLAG_STATE_PROGRESSION_CALENDAR);
  } catch (_error) {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const date = normalizeCalendariaDate(raw.date);
  const calendarId = String(raw.calendarId ?? "").trim();
  if (!date || !calendarId) return null;

  const marker = { calendarId, date };
  if (raw.resolution === "absent") {
    marker.resolution = "absent";
    marker.skippedDays = Math.max(1, Math.floor(Number(raw.skippedDays) || 1));
    const previousDate = normalizeCalendariaDate(raw.previousDate);
    if (previousDate) marker.previousDate = previousDate;
  }
  return marker;
}

export async function setActorCalendarMarker(actor, context, metadata = {}, documentOptions = {}, completed = []) {
  const date = normalizeCalendariaDate(context?.date);
  const calendarId = String(context?.calendarId ?? "").trim();
  if (!actor || !date || !calendarId) throw progressionError("invalid-calendar-date", invalidCalendarDateDetail(actor, context));

  const marker = { calendarId, date };
  if (metadata?.resolution === "absent") {
    marker.resolution = "absent";
    marker.skippedDays = Math.max(1, Math.floor(Number(metadata.skippedDays) || 1));
    const previousDate = normalizeCalendariaDate(metadata.previousDate);
    if (previousDate) marker.previousDate = previousDate;
  }

  const payload = structuredClone(marker);
  if (metadata.resolution !== "absent" && getActorCalendarMarker(actor)?.resolution === "absent") {
    // Object flags are merged by Foundry. Clear metadata left by an Absence.
    Object.assign(payload, { resolution: null, previousDate: null, skippedDays: null });
  }
  try {
    await runDocumentWrite(() => actor.update && (Object.keys(documentOptions).length || !actor.setFlag)
      ? actor.update({ [`flags.${MODULE_ID}.${FLAG_STATE_PROGRESSION_CALENDAR}`]: payload }, documentOptions)
      : actor.setFlag(MODULE_ID, FLAG_STATE_PROGRESSION_CALENDAR, payload));
    const saved = getActorCalendarMarker(actor);
    if (!documentValuesEqual(saved, marker)) throw new Error("The calendar marker did not persist");
    return saved;
  } catch (cause) {
    const unknown = isUnknownWriteOutcome(cause);
    const actual = getActorCalendarMarker(actor);
    const details = { actor: actor.name, date: formatCalendariaDate(date), calendar: calendarId,
      actual: actual ? `${formatCalendariaDate(actual.date)} (${actual.calendarId})` : "—",
      completed: completed.map(entry => entry.action.itemName).join(", ") || "—" };
    const message = unknown
      ? qaLocalize("StateProgression.MarkerOutcomeUnknown", "{actor}: the outcome of saving the Calendaria marker {date} ({calendar}) is unknown. Confirmed actions: {completed}. Check the sheet before trying again.", details)
      : qaLocalize("StateProgression.MarkerWriteFailed", "{actor}: Calendaria marker {date} ({calendar}) was not confirmed. Actual marker: {actual}. Confirmed actions: {completed}. Check the sheet before trying again.", details);
    if (actor.id) actorsNeedingReview.set(actor.id, calendarId);
    whisperToGM(message);
    const code = unknown ? "outcome-unknown" : "calendar-marker-failed";
    const error = new Error(message, { cause });
    error.code = code;
    showCalendarError(error);
    throw error;
  }
}

export function markActorCalendariaAbsent(actor, context) {
  return enqueueCalendarActor(actor.id, context, async ({ actor: liveActor }, live) => {
    assertCalendarReviewClear(liveActor, live);
    const marker = getActorCalendarMarker(liveActor);
    const status = calculateActorCalendarStatus(marker, live);
    const skippedDays = Math.max(0, status.days ?? 0);
    if (!skippedDays || getPendingAddictions(liveActor).length) return { changed: false, skippedDays: 0, previousMarker: marker };
    await setActorCalendarMarker(liveActor, live, { resolution: "absent", skippedDays, previousDate: marker.date });
    return { changed: true, skippedDays, previousMarker: marker };
  });
}

export function undoActorCalendariaAbsent(actor, context) {
  return enqueueCalendarActor(actor.id, context, async ({ actor: liveActor }, live) => {
    assertCalendarReviewClear(liveActor, live);
    const marker = getActorCalendarMarker(liveActor);
    if (!isAbsentMarkerForContext(marker, live) || !marker.previousDate) return { changed: false, restoredMarker: marker };
    const restoredMarker = await setActorCalendarMarker(liveActor, { ...live, date: marker.previousDate });
    return { changed: true, restoredMarker, skippedDays: marker.skippedDays };
  });
}

function isAbsentMarkerForContext(marker, context) {
  return Boolean(
    marker?.resolution === "absent"
    && marker?.calendarId === context?.calendarId
    && sameCalendariaDay(marker?.date, context?.date)
  );
}

function summaryStatusForAheadMarker(marker, days) {
  return {
    state: "ahead",
    days: 0,
    skippedDays: 0,
    undoAvailable: false,
    detail: aheadDetail(marker, days)
  };
}

function aheadDetail(marker, days) {
  return qaLocalize(
    "StateProgression.AheadDetail",
    "Marker ({marker}) is {days} days ahead of the current date. Reset it to the current date so daily progression can resume.",
    {
      marker: formatCalendariaDate(marker?.date),
      days: Math.abs(Math.floor(Number(days) || 0))
    }
  );
}

function warnIfAnyMarkersAhead(context) {
  if (!isActiveQuickAccessGM() || !context?.calendarId || !context?.date) return 0;
  const aheadActors = getAssignedPlayerActors().filter(({ actor }) =>
    calculateActorCalendarStatus(getActorCalendarMarker(actor), context).status === "ahead"
  );
  if (!aheadActors.length) return 0;
  const warningKey = `${summaryKey(context)}:${aheadActors.length}`;
  if (lastAheadWarningKey === warningKey) return aheadActors.length;
  lastAheadWarningKey = warningKey;
  ui.notifications?.warn?.(qaLocalize(
    "StateProgression.AheadDetectedWarning",
    "{count} player characters have a Calendaria marker ahead of the current date. Open “Manage Calendaria days” in module settings to reset them.",
    { count: aheadActors.length }
  ));
  return aheadActors.length;
}

function summaryStatusForCurrentMarker(marker, context) {
  if (!isAbsentMarkerForContext(marker, context)) return { state: "done", days: 0 };
  const skippedDays = Math.max(1, Math.floor(Number(marker?.skippedDays) || 1));
  return {
    state: "absent",
    days: 0,
    skippedDays,
    undoAvailable: Boolean(marker?.previousDate),
    detail: qaLocalize(
      "StateProgression.AbsentDetail",
      "Skipped {days} calendar days; character states were not changed.",
      { days: skippedDays }
    )
  };
}

function registerResultSocket() {
  if (resultSocketRegistered || !globalThis.game?.socket?.on) return false;
  game.socket.on(SOCKET_CHANNEL, (message, senderId) => {
    if (message?.type === PLAYER_RESULT_TYPE) void handlePlayerResultMessage(message, senderId);
  });
  resultSocketRegistered = true;
  return true;
}

async function sendPlayerResults(entry, context, result) {
  const activeUsers = (entry?.users ?? []).filter((user) => user?.active);
  if (!activeUsers.length && entry?.primaryUser?.active) activeUsers.push(entry.primaryUser);
  for (const user of activeUsers) {
    await sendPlayerResult(user, entry.actor, context, result);
  }
}

async function sendPlayerResult(user, actor, context, result) {
  if (!isActiveQuickAccessGM() || !user?.active || !game.socket?.emit || game.socket.connected === false
    || resolveUserCharacter(user, game.actors)?.id !== actor.id) return false;
  const packetId = makeSocketRequestId();
  const message = {
    type: PLAYER_RESULT_TYPE,
    packetId,
    recipientId: String(user.id),
    actorId: String(actor.id),
    calendarId: context.calendarId,
    targetDate: context.date,
    result
  };

  try {
    game.socket.emit(SOCKET_CHANNEL, message, { recipients: [user.id] });
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | could not send Calendaria progression result to player`, error);
    return false;
  }
}

async function handlePlayerResultMessage(message, senderId) {
  if (!isValidPlayerResultMessage(message) || message.recipientId !== game.user?.id || game.user?.isGM) return;
  const gm = getActiveGM();
  if (!gm || senderId !== gm.id) return;
  const actor = resolveUserCharacter(game.user, game.actors);
  if (actor?.id !== message.actorId || !consumeSocketProof(gm.id, PLAYER_RESULT_PROOF_KIND, message.packetId)) return;
  await showPlayerResult(actor, {
    calendarId: message.calendarId,
    date: normalizeCalendariaDate(message.targetDate)
  }, message.result);
}

function isValidPlayerResultMessage(message) {
  return message?.type === PLAYER_RESULT_TYPE
    && isValidSocketRequestId(message.packetId)
    && typeof message.recipientId === "string"
    && typeof message.actorId === "string"
    && typeof message.calendarId === "string"
    && Boolean(normalizeCalendariaDate(message.targetDate))
    && message.result && typeof message.result === "object";
}

async function showPlayerResult(actor, context, result) {
  if (!result || !hasFoundryDialogApi()) {
    ui.notifications?.info?.(qaLocalize("StateProgression.PlayerResultNotification", "Calendar state progression completed for {actor}.", { actor: actor?.name ?? "" }));
    return null;
  }

  const content = buildPlayerResultContent(result);
  const dialog = createFoundryDialog({
    title: qaLocalize("StateProgression.PlayerResultTitle", "New day — {actor}", { actor: actor?.name ?? "" }),
    content,
    buttons: {},
    render: (html, renderedDialog) => {
      const root = extractDialogElement(renderedDialog ?? html);
      root?.closest?.(".app, .application")?.classList.add("fblqa-state-progression-result");
    }
  }, {
    classes: ["fblqa-rest-dialog", "fblqa-state-progression-result"],
    width: 560,
    resizable: true,
    buttonless: true
  });
  return dialog?.render?.(true) ?? null;
}

function buildPlayerResultContent(result) {
  const days = Array.isArray(result?.days) ? result.days : [];
  const rows = days.map((day) => {
    const entries = Array.isArray(day?.result?.entries) ? day.result.entries : [];
    const list = entries.length
      ? `<ul>${entries.map((entry) => `<li class="${entry.pending ? "is-pending" : entry.ok ? "is-ok" : "is-failed"}"><strong>${escapeHtml(entry.itemName ?? "")}</strong><span>${escapeHtml(entry.detail ?? "")}</span></li>`).join("")}</ul>`
      : `<p>${escapeHtml(qaLocalize("StateProgression.NoStateChanges", "No selected state changes were needed."))}</p>`;
    return `
      <section class="fblqa-progression-result-day">
        <h3>${escapeHtml(formatCalendariaDate(day?.date))}</h3>
        ${list}
      </section>`;
  }).join("");

  return `
    <div class="fblqa-progression-result">
      <div class="fblqa-progression-result-intro">
        <strong>${escapeHtml(qaLocalize("StateProgression.PlayerResultHeading", "State progression"))}</strong>
        <span>${escapeHtml(qaLocalize("StateProgression.PlayerResultHint", "These changes were applied without posting individual messages to chat."))}</span>
      </div>
      ${rows || `<p>${escapeHtml(qaLocalize("StateProgression.NoStateChanges", "No selected state changes were needed."))}</p>`}
      ${result.detail ? `<p class="fblqa-rest-note">${escapeHtml(result.detail)}</p>` : ""}
      ${result?.outcomeUnknown || days.some((day) => day?.result?.outcomeUnknown) ? `<p class="fblqa-rest-note">${escapeHtml(qaLocalize("Writes.Unknown", "The outcome is unknown. Check the sheet before trying again."))}</p>` : ""}
      ${result.pendingManual ? `<p class="fblqa-rest-note">${escapeHtml(manualEnduranceDetail())}</p>` : ""}
    </div>`;
}

function manualEnduranceDetail() {
  return qaLocalize("StateProgression.AddictionPending", "Manual addiction Endurance is required. Record Success or Failure in STAT before processing the next day.");
}

function emptyCalendarResult(date) {
  return {
    mode: "interactive",
    processedDays: 0,
    failedDays: 0,
    failedActions: 0,
    days: [{ date, result: { changed: false, selected: 0, successCount: 0, failedCount: 0, entries: [] } }]
  };
}

function resolveAssignedActorEntry(actorId) {
  const id = String(actorId ?? "").trim();
  const entry = getAssignedPlayerActors().find((candidate) => candidate.actor.id === id);
  if (!entry) throw progressionError("actor-not-assigned", "Actor is not assigned to a player");
  return entry;
}

function assertRequesterAssignedToActor(entry, user) {
  if (!user || user.active === false) throw progressionError("missing-requester", "Requesting user was not found");
  if (user.isGM) return;
  if (entry.users.some((candidate) => candidate.id === user.id)) return;
  throw progressionError("actor-permission", "The requesting player is not assigned to this actor");
}

function resolveUserCharacter(user, actors) {
  const value = user?.character;
  const id = typeof value === "string" ? value : value?.id ?? user?.characterId ?? null;

  // Prefer the canonical world Actor from game.actors. User.character can be a
  // Document reference supplied by another part of Foundry; resolving by id
  // avoids carrying a stale/non-canonical instance into write operations while
  // preserving the old fallback when no Actor collection is available.
  if (id && actors?.get) return actors.get(id) ?? null;
  if (value?.documentName === "Actor") return value;
  return null;
}

function summaryKey(context) {
  return `${String(context?.calendarId ?? "")}:${calendariaDateKey(context?.date)}`;
}

function progressionModeLabel(mode) {
  return mode === STATE_PROGRESSION_MODES.CALENDARIA
    ? qaLocalize("Settings.StateProgressionMode.ChoiceCalendaria", "Calendaria — new day")
    : qaLocalize("Settings.StateProgressionMode.ChoiceLongRest", "Long Rest");
}

function progressionStatusLabel(state) {
  return qaLocalize(`StateProgression.Status.${state}`, {
    pending: "Waiting for player",
    offline: "Player offline",
    processing: "Processing",
    done: "Done",
    error: "Completed with errors",
    baseline: "Baseline set",
    blocked: "Needs manual resolution",
    absent: "Absent",
    ahead: "Marker ahead"
  }[state] ?? state);
}

function progressionStatusDetail(status) {
  const days = Math.max(0, Number(status?.days) || 0);
  if (!days) return "";
  return qaLocalize("StateProgression.PendingDays", "Pending days: {days}", { days });
}

function isActiveQuickAccessGM() {
  const gm = getActiveGM();
  return Boolean(game.user?.isGM && gm?.id === game.user.id);
}

function warnCalendariaUnavailable() {
  if (!game.user?.isGM || calendariaUnavailableWarned) return;
  // Do not misreport an enabled Calendaria installation as unavailable merely
  // because its active CalendarManager is still being initialized. The module
  // emits `calendaria.ready` once that work is complete.
  if (isCalendariaModuleActive()) return;
  calendariaUnavailableWarned = true;
  ui.notifications?.warn?.(qaLocalize(
    "StateProgression.CalendariaUnavailable",
    "Calendaria progression is selected, but Calendaria is unavailable. State progression is paused; Long Rest will not be used as a fallback."));
}

function showCalendarError(error) {
  if (error.notified) return;
  error.notified = true;
  console.error(`${MODULE_ID} | Calendaria progression stopped`, error);
  const warning = error.code?.startsWith("stale-") || isUnknownWriteOutcome(error);
  (warning ? ui.notifications?.warn : ui.notifications?.error)?.call(ui.notifications, escapeHtml(error.message));
}

function progressionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
