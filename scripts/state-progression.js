import {
  FLAG_STATE_PROGRESSION_CALENDAR,
  MODULE_ID,
  SETTINGS
} from "./constants.js";
import { qaLocalize } from "./i18n.js";
import {
  applyNewDayPlan,
  buildNewDayPlanWithProviders,
  openNewDayDialog,
  serializeNewDayResult
} from "./new-day.js";
import {
  confirmDangerAction,
  createFoundryDialog,
  extractDialogElement,
  hasFoundryDialogApi
} from "./dialogs.js";
import { escapeHtml } from "./utils.js";
import {
  executeAsActiveGM,
  getActiveGM,
  registerSocketHandler
} from "./integration/socket-api.js";
import {
  consumeSocketProof,
  createSocketProof,
  scheduleSocketProofCleanup,
  verifySocketProofWithRetry
} from "./socket-auth.js";
import {
  findGameUser,
  makeSocketRequestId,
  normalizeSocketRequestId
} from "./socket-utils.js";
import { createObjectOperationQueue } from "./operation-queue.js";

export const STATE_PROGRESSION_MODES = Object.freeze({
  LONG_REST: "long-rest",
  CALENDARIA: "calendaria"
});

const CALENDARIA_MODULE_ID = "calendaria";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const APPLY_OPERATION = "state-progression.apply-calendaria-day";
const REPORT_OPERATION = "state-progression.report-calendaria-pending";
const PLAYER_RESULT_TYPE = "state-progression-player-result";
const PLAYER_RESULT_PROOF_KIND = "stateProgressionResult";
const RESULT_PROOF_TTL_MS = 2 * 60_000;
const DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT = 90;
const MAX_AUTOMATIC_CALENDAR_DAYS = 365;

let initialized = false;
let resultSocketRegistered = false;
let observedMode = null;
let revertingMode = false;
let calendariaUnavailableWarned = false;
let calendariaReadyApi = null;
let calendariaReadySeen = false;

const activePlayerPrompts = new Set();
const gmSummaryWindows = new Map();
const enqueueStateProgressionOperation = createObjectOperationQueue();

export function initializeStateProgression() {
  if (initialized) return;
  registerSocketHandler(APPLY_OPERATION, handleCalendariaApplyRequest);
  registerSocketHandler(REPORT_OPERATION, handleCalendariaPendingReport);

  globalThis.Hooks?.on?.("calendaria.dayChange", (data) => {
    void handleCalendariaDayChange(data);
  });
  globalThis.Hooks?.on?.("calendaria.calendarSwitched", () => {
    void handleCalendariaCalendarSwitch();
  });
  globalThis.Hooks?.on?.("calendaria.ready", (data) => {
    void handleCalendariaReady(data);
  });
  globalThis.Hooks?.on?.("fblQuickAccess.stateProgressionModeChanged", (mode) => {
    void handleProgressionModeChanged(mode);
  });
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

  if (isActiveQuickAccessGM()) await ensureMissingPlayerBaselines(context);
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

/** Calendaria's dayChange payload uses internal 0-indexed month/day fields. */
export function calendariaHookComponentToPublicDate(components) {
  if (!components || typeof components !== "object") return null;
  const year = Number(components.year);
  const month = Number(components.month);
  const dayOfMonth = Number(components.dayOfMonth ?? components.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(dayOfMonth)) return null;
  return {
    year,
    month: month + 1,
    day: dayOfMonth + 1
  };
}

export function normalizeCalendariaDate(date) {
  if (!date || typeof date !== "object") return null;
  const year = Number(date.year);
  const month = Number(date.month);
  const day = Number(date.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || day < 1) return null;
  return { year, month, day };
}

export function calendariaDateKey(date) {
  const normalized = normalizeCalendariaDate(date);
  if (!normalized) return "invalid-date";
  return `${normalized.year}:${normalized.month}:${normalized.day}`;
}

export function getAssignedPlayerActors(users = globalThis.game?.users, actors = globalThis.game?.actors) {
  const byActor = new Map();
  for (const user of Array.from(users ?? [])) {
    if (!user || user.isGM) continue;
    const actor = resolveUserCharacter(user, actors);
    if (!actor || actor.documentName !== "Actor" || actor.type !== "character") continue;

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

export function calculateActorCalendarStatus(marker, context, api = getCalendariaApi()) {
  if (!context?.date || !context?.calendarId || !api?.daysBetween) {
    return { status: "unavailable", days: null };
  }
  if (!marker?.date || marker.calendarId !== context.calendarId) {
    return { status: "baseline", days: null };
  }

  let days;
  try {
    days = Number(api.daysBetween(marker.date, context.date));
  } catch (_error) {
    return { status: "unavailable", days: null };
  }
  if (!Number.isFinite(days)) return { status: "unavailable", days: null };
  if (days <= 0) return { status: "current", days };
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
  calendariaReadySeen = true;
  calendariaReadyApi = data?.api ?? globalThis.CALENDARIA?.api ?? calendariaReadyApi;
  if (!usesCalendariaStateProgression()) return;
  calendariaUnavailableWarned = false;
  const context = getCalendariaContext();
  if (!context) {
    // The ready hook itself proves Calendaria is present. A missing context at
    // this point means no active calendar/API context, not a disabled module.
    console.warn(`${MODULE_ID} | Calendaria ready fired without an active calendar context`);
    return;
  }

  if (isActiveQuickAccessGM()) await ensureMissingPlayerBaselines(context);
  if (!game.user?.isGM) await checkCurrentPlayerPending();
}

async function handleCalendariaCalendarSwitch() {
  // Calendaria deliberately fires calendarSwitched during its own world startup,
  // before calendaria.ready. Ignore that initialization signal. The ready handler
  // establishes any missing baselines against the final persisted calendar.
  if (!calendariaReadySeen) return;
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
  if (!Number.isFinite(delta) || delta === 0) return;

  if (delta < 0) {
    if (isActiveQuickAccessGM()) {
      ui.notifications?.info?.(qaLocalize(
        "StateProgression.RewindIgnored",
        "Calendaria moved backwards. Player states were not reversed and already processed days will not be processed again."));
    }
    return;
  }

  const context = getCalendariaContext(current);
  if (!context) return;

  if (delta > 1) {
    if (isActiveQuickAccessGM()) await handleCalendariaMultiDayJump(previous, context, delta);
    return;
  }

  if (isActiveQuickAccessGM()) await prepareGMSummary(context, { reason: "day-change" });
  if (!game.user?.isGM) await checkCurrentPlayerPending({ context });
}

async function handleCalendariaMultiDayJump(previousDate, context, delta) {
  const entries = getAssignedPlayerActors();
  if (!entries.length) return;

  const summary = await prepareGMSummary(context, { reason: "time-skip", skipBaselineMutation: true });
  if (delta > MAX_AUTOMATIC_CALENDAR_DAYS) {
    for (const entry of entries) {
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: "blocked",
        days: pendingDaysForActor(entry.actor, context),
        detail: qaLocalize("StateProgression.TooManyDays", "The time skip is too large for automatic processing.")
      });
    }
    ui.notifications?.warn?.(qaLocalize(
      "StateProgression.TooManyDaysWarning",
      "Calendaria advanced by {days} days. Quick Access will not automatically simulate more than {max} days at once.",
      { days: delta, max: MAX_AUTOMATIC_CALENDAR_DAYS }
    ));
    return;
  }

  const confirmed = await confirmDangerAction({
    title: qaLocalize("StateProgression.TimeSkipTitle", "Calendaria time skip"),
    heading: qaLocalize("StateProgression.TimeSkipHeading", "Advance player states by {days} days?", { days: delta }),
    message: qaLocalize(
      "StateProgression.TimeSkipMessage",
      "Calendaria moved from {from} to {to}. Quick Access can process the missing days sequentially for all assigned player characters.",
      { from: formatCalendariaDate(previousDate), to: formatCalendariaDate(context.date) }
    ),
    warning: qaLocalize(
      "StateProgression.TimeSkipWarning",
      "This can resolve injuries, wash states, addictions and other daily conditions. Moving the calendar backwards will not undo these changes."),
    confirmLabel: qaLocalize("StateProgression.TimeSkipApply", "Process time skip"),
    cancelLabel: qaLocalize("StateProgression.TimeSkipLater", "Leave pending"),
    icon: "fas fa-calendar-plus",
    width: 500
  });

  if (!confirmed) {
    for (const entry of entries) {
      const days = pendingDaysForActor(entry.actor, context);
      if (days > 0) {
        updateGMSummaryStatus(summary, entry.actor.id, {
          state: entry.primaryUser?.active ? "pending" : "offline",
          days,
          detail: qaLocalize("StateProgression.PendingTimeSkip", "Time skip left pending by the GM.")
        });
      }
    }
    return;
  }

  for (const entry of entries) {
    const marker = getActorCalendarMarker(entry.actor);
    if (!marker || marker.calendarId !== context.calendarId) {
      // Missing markers usually mean a newly assigned/newly created PC. A
      // multi-day world jump must not age a character from an unknown origin.
      await setActorCalendarMarker(entry.actor, context);
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: "baseline",
        days: 0,
        detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
      });
      continue;
    }

    const days = pendingDaysForActor(entry.actor, context);
    if (days <= 0) {
      updateGMSummaryStatus(summary, entry.actor.id, summaryStatusForCurrentMarker(marker, context));
      continue;
    }

    // A disconnected player is the closest reliable signal that the character
    // is not participating in the session. Do not age that character
    // automatically during a multi-day jump: leave the batch for the GM to
    // Resolve or mark Absent from the summary.
    if (!entry.primaryUser?.active) {
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: "offline",
        days,
        detail: qaLocalize(
          "StateProgression.OfflineTimeSkipPending",
          "Player is offline. The time skip was left pending so the GM can resolve it or mark the character absent."
        )
      });
      continue;
    }

    updateGMSummaryStatus(summary, entry.actor.id, { state: "processing", days });
    const result = await processActorAutomaticDays(entry.actor, marker.date, context, days, {
      maxDays: days > DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT ? days : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT
    });
    updateGMSummaryStatus(summary, entry.actor.id, result.failedDays > 0
      ? { state: "error", days: result.limitedDays, result, detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: result.failedActions }) }
      : result.limitedDays > 0
        ? { state: "blocked", days: result.limitedDays, result, detail: qaLocalize("StateProgression.AutomaticDaysLimited", "Processed {processed} calendar days; {remaining} days remain pending.", { processed: result.processedDays, remaining: result.limitedDays }) }
        : { state: "done", days: 0, result, detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: result.processedDays }) });

    if (entry.primaryUser?.active) await sendPlayerResult(entry.primaryUser, entry.actor, context, result);
  }
}

async function processActorAutomaticDays(actor, startDate, context, requestedDays, options = {}) {
  return enqueueStateProgressionOperation(actor, () =>
    processActorAutomaticDaysUnlocked(actor, startDate, context, requestedDays, options)
  );
}

async function processActorAutomaticDaysUnlocked(actor, startDate, context, requestedDays, options = {}) {
  const api = getCalendariaApi();
  const dayResults = [];
  let cursor = normalizeCalendariaDate(startDate);
  const requested = Math.max(0, Math.floor(Number(requestedDays) || 0));
  const configuredLimit = Number.isFinite(Number(options.maxDays))
    ? Math.max(0, Math.floor(Number(options.maxDays)))
    : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT;
  const effectiveLimit = Math.min(configuredLimit, MAX_AUTOMATIC_CALENDAR_DAYS);
  let remaining = Math.min(requested, effectiveLimit);
  let failedDays = 0;
  let failedActions = 0;

  while (remaining > 0 && cursor) {
    const nextDate = normalizeCalendariaDate(api?.addDays?.(cursor, 1));
    if (!nextDate) break;

    const plan = await buildNewDayPlanWithProviders(actor);
    const selectedIds = plan.actions.filter((action) => action.checked !== false).map((action) => action.id);

    // If only the bookkeeping Short Rest reset remains, repeating an empty day
    // hundreds of times would create document traffic with no gameplay value.
    const meaningful = plan.actions.filter((action) => action.kind !== "short-rest-reset");
    if (!meaningful.length && !plan.providerErrors?.length) {
      const reset = plan.actions.find((action) => action.kind === "short-rest-reset");
      if (reset) {
        const resetResult = await applyNewDayPlan(actor, plan, [reset.id], calendarApplyOptions());
        dayResults.push({ date: nextDate, result: serializeNewDayResult(resetResult) });
        if (resetResult.failed.length) {
          failedDays += 1;
          failedActions += resetResult.failed.length;
        }
      }
      // Keep the marker as the final Actor mutation for this shortcut. Core
      // New Day writes keep their normal Foundry render behavior so any open
      // embedded Item sheets stay synchronized on every client.
      await setActorCalendarMarker(actor, context);
      remaining = 0;
      cursor = context.date;
      break;
    }

    const applied = await applyNewDayPlan(actor, plan, selectedIds, calendarApplyOptions());
    dayResults.push({ date: nextDate, result: serializeNewDayResult(applied) });
    if (applied.failed.length) {
      failedDays += 1;
      failedActions += applied.failed.length;
    }

    // Consume this day even if an individual action failed. Re-running an
    // already partly-applied day can decrement successful timers twice. The GM
    // summary exposes failures for manual correction instead.
    const finalIteration = remaining <= 1;
    await setActorCalendarMarker(
      actor,
      { ...context, date: nextDate },
      {},
      finalIteration ? {} : { render: false }
    );
    cursor = nextDate;
    remaining -= 1;
  }

  // `dayResults` counts days that produced an explicit result entry, not days
  // whose calendar marker was logically consumed. The short-rest-only shortcut
  // intentionally jumps the marker straight to context.date after one reset, so
  // derive the contract from marker advancement instead of result count.
  let processedDays = Math.max(0, requested - remaining);
  try {
    const markerAdvance = Number(api?.daysBetween?.(normalizeCalendariaDate(startDate), cursor));
    if (Number.isFinite(markerAdvance)) {
      processedDays = Math.max(0, Math.min(requested, Math.floor(markerAdvance)));
    }
  } catch (_error) {
    // Fall back to the loop's consumed-day count if Calendaria cannot compare.
  }

  return {
    mode: "automatic",
    requestedDays: requested,
    processedDays,
    limitedDays: Math.max(0, requested - processedDays),
    failedDays,
    failedActions,
    days: dayResults
  };
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
  if (status.status === "current") return null;
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
      applyHandler: async ({ selectedIds }) => executeAsActiveGM(APPLY_OPERATION, {
        actorId: actor.id,
        targetDate: context.date,
        calendarId: context.calendarId,
        selectedIds
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
  assertCalendariaModeAvailable();
  const calendaria = getCalendariaContext();
  if (!calendaria) throw progressionError("calendaria-unavailable", "Calendaria is unavailable");

  const actorEntry = resolveAssignedActorEntry(payload?.actorId);
  assertRequesterAssignedToActor(actorEntry, context.requestUser);

  const targetDate = normalizeCalendariaDate(payload?.targetDate);
  if (!targetDate || String(payload?.calendarId ?? "") !== calendaria.calendarId) {
    throw progressionError("stale-calendar-day", "The Calendaria calendar changed");
  }
  if (!sameCalendariaDay(targetDate, calendaria.date)) {
    throw progressionError("stale-calendar-day", "The Calendaria date changed while the dialog was open");
  }

  return enqueueStateProgressionOperation(actorEntry.actor, async () => {
    // Re-read the marker inside the per-Actor queue. This makes Apply, Absent,
    // Undo and multi-day GM resolution mutually exclusive even if two clients
    // act on the same calendar prompt at nearly the same moment.
    let marker = getActorCalendarMarker(actorEntry.actor);
    if (!marker || marker.calendarId !== calendaria.calendarId) {
      await setActorCalendarMarker(actorEntry.actor, calendaria);
      updateCurrentGMSummary(actorEntry.actor.id, calendaria, {
        state: "baseline",
        days: 0,
        detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
      });
      return { status: "baseline", calendarResult: emptyCalendarResult(targetDate) };
    }

    const status = calculateActorCalendarStatus(marker, calendaria);
    if (status.status === "current") {
      updateCurrentGMSummary(actorEntry.actor.id, calendaria, summaryStatusForCurrentMarker(marker, calendaria));
      return {
        status: isAbsentMarkerForContext(marker, calendaria) ? "already-skipped" : "already-processed",
        calendarResult: emptyCalendarResult(targetDate)
      };
    }
    if (status.status !== "pending") {
      updateCurrentGMSummary(actorEntry.actor.id, calendaria, { state: "pending", days: status.days ?? 0 });
      throw progressionError("multi-day-pending", "Multiple Calendaria days are pending");
    }

    const plan = await buildNewDayPlanWithProviders(actorEntry.actor);
    const selectedIds = normalizeSelectedActionIds(payload?.selectedIds);
    const knownIds = new Set(plan.actions.map((action) => action.id));
    const unknown = selectedIds.find((id) => !knownIds.has(id));
    if (unknown) throw progressionError("invalid-action", `Unknown new-day action: ${unknown}`);

    updateCurrentGMSummary(actorEntry.actor.id, calendaria, { state: "processing", days: 1 });
    const applied = await applyNewDayPlan(actorEntry.actor, plan, selectedIds, calendarApplyOptions());
    await setActorCalendarMarker(actorEntry.actor, calendaria);

    const calendarResult = {
      mode: "interactive",
      processedDays: 1,
      failedDays: applied.failed.length ? 1 : 0,
      failedActions: applied.failed.length,
      days: [{ date: targetDate, result: serializeNewDayResult(applied) }]
    };

    updateCurrentGMSummary(actorEntry.actor.id, calendaria, applied.failed.length
      ? {
          state: "error",
          days: 0,
          result: calendarResult,
          detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: applied.failed.length })
        }
      : {
          state: "done",
          days: 0,
          result: calendarResult,
          detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: 1 })
        });

    return { status: applied.failed.length ? "processed-with-errors" : "processed", calendarResult };
  });
}

async function handleCalendariaPendingReport(payload, context) {
  assertCalendariaModeAvailable();
  const calendaria = getCalendariaContext();
  if (!calendaria) throw progressionError("calendaria-unavailable", "Calendaria is unavailable");

  const actorEntry = resolveAssignedActorEntry(payload?.actorId);
  assertRequesterAssignedToActor(actorEntry, context.requestUser);

  let marker = getActorCalendarMarker(actorEntry.actor);
  if (!marker || marker.calendarId !== calendaria.calendarId) {
    await setActorCalendarMarker(actorEntry.actor, calendaria);
    marker = getActorCalendarMarker(actorEntry.actor);
  }

  const status = calculateActorCalendarStatus(marker, calendaria);
  const summary = await prepareGMSummary(calendaria, { reason: "player-report", skipBaselineMutation: true });
  if (status.status === "current") {
    updateGMSummaryStatus(summary, actorEntry.actor.id, summaryStatusForCurrentMarker(marker, calendaria));
  } else {
    updateGMSummaryStatus(summary, actorEntry.actor.id, {
      state: actorEntry.primaryUser?.active ? "pending" : "offline",
      days: Math.max(0, Number(status.days) || 0),
      detail: status.status === "pending-multiple"
        ? qaLocalize("StateProgression.MultiplePendingGM", "Multiple calendar days are pending; GM resolution is required.")
        : ""
    });
  }

  return { status: status.status, days: status.days ?? 0 };
}

async function prepareGMSummary(context, { reason = "day-change", skipBaselineMutation = false } = {}) {
  if (!isActiveQuickAccessGM()) return null;
  const entries = getAssignedPlayerActors();
  const summary = openOrRefreshGMSummary(context, entries, reason);

  for (const entry of entries) {
    let marker = getActorCalendarMarker(entry.actor);
    if ((!marker || marker.calendarId !== context.calendarId) && !skipBaselineMutation) {
      await setActorCalendarMarker(entry.actor, context);
      marker = getActorCalendarMarker(entry.actor);
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: "baseline",
        days: 0,
        detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
      });
      continue;
    }

    const status = calculateActorCalendarStatus(marker, context);
    if (status.status === "current") {
      updateGMSummaryStatus(summary, entry.actor.id, summaryStatusForCurrentMarker(marker, context));
    } else if (status.status === "baseline") {
      updateGMSummaryStatus(summary, entry.actor.id, { state: "baseline", days: 0 });
    } else {
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: entry.primaryUser?.active ? "pending" : "offline",
        days: Math.max(0, Number(status.days) || 0),
        detail: status.status === "pending-multiple"
          ? qaLocalize("StateProgression.MultiplePendingGM", "Multiple calendar days are pending; GM resolution is required.")
          : ""
      });
    }
  }
  return summary;
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
    for (const entry of entries) state.entries.set(entry.actor.id, entry);
    state.context = context;
  }

  if (!hasFoundryDialogApi() || state.dialog) return state;

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
    width: 650,
    resizable: true,
    buttonless: true
  });
  state.dialog?.render?.(true);
  return state;
}

function buildGMSummaryContent(state) {
  return `
    <div class="fblqa-progression-summary" data-summary-key="${escapeHtml(state.key)}">
      <div class="fblqa-progression-summary-intro">
        <strong>${escapeHtml(qaLocalize("StateProgression.GMSummaryHeading", "Player states"))}</strong>
        <span>${escapeHtml(qaLocalize("StateProgression.GMSummaryHint", "Only characters assigned to non-GM users are included. Player results are kept out of chat."))}</span>
      </div>
      <div class="fblqa-progression-summary-rows">${Array.from(state.entries.values()).map((entry) => renderGMSummaryRow(state, entry)).join("")}</div>
    </div>`;
}

function renderGMSummaryRow(state, entry) {
  const status = state.statuses.get(entry.actor.id) ?? { state: entry.primaryUser?.active ? "pending" : "offline", days: 0 };
  const pendingDays = Math.max(0, Number(status.days) || 0);
  const canResolve = ["pending", "offline", "error", "blocked"].includes(status.state) && pendingDays > 0;
  const canMarkAbsent = ["pending", "offline", "blocked"].includes(status.state) && pendingDays > 0;
  const canUndoAbsent = status.state === "absent" && Boolean(status.undoAvailable);
  const playerNames = entry.users.map((user) => user.name ?? user.id).filter(Boolean).join(", ") || "—";
  const detail = status.detail || progressionStatusDetail(status);
  const resultDetails = renderGMSummaryResult(status.result);
  const actions = [
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
      </button>` : ""
  ].filter(Boolean).join("");

  return `
    <div class="fblqa-progression-summary-row is-${escapeHtml(status.state)}" data-actor-id="${escapeHtml(entry.actor.id)}">
      <div class="fblqa-progression-summary-character">
        <strong>${escapeHtml(entry.actor.name ?? "")}</strong>
        <small>${escapeHtml(playerNames)}</small>
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
  state.statuses.set(actorId, { ...(state.statuses.get(actorId) ?? {}), ...status });
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
  container.innerHTML = Array.from(state.entries.values()).map((entry) => renderGMSummaryRow(state, entry)).join("");
  bindGMSummaryActions(state);
}

function bindGMSummaryActions(state) {
  const root = state.root;
  if (!root) return;
  for (const button of root.querySelectorAll?.("[data-action]") ?? []) {
    if (button.dataset.fblqaBound === "true") continue;
    button.dataset.fblqaBound = "true";
    button.addEventListener("click", () => {
      const actorId = button.closest?.("[data-actor-id]")?.dataset?.actorId;
      if (!actorId) return;
      const action = String(button.dataset.action ?? "");
      if (action === "resolve") void resolveActorFromGMSummary(state, actorId);
      else if (action === "absent") void markActorAbsentFromGMSummary(state, actorId);
      else if (action === "undo-absent") void undoActorAbsentFromGMSummary(state, actorId);
    });
  }
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
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = getCalendariaContext();
  if (!context || context.calendarId !== state.context.calendarId) return;
  const marker = getActorCalendarMarker(entry.actor);
  const status = calculateActorCalendarStatus(marker, context);
  const days = Math.max(0, Number(status.days) || 0);
  if (!days) {
    updateGMSummaryStatus(state, actorId, summaryStatusForCurrentMarker(marker, context));
    return;
  }

  if (days > 1) {
    if (days > MAX_AUTOMATIC_CALENDAR_DAYS) {
      ui.notifications?.warn?.(qaLocalize("StateProgression.TooManyDaysWarning", "Calendaria advanced by {days} days. Quick Access will not automatically simulate more than {max} days at once.", {
        days,
        max: MAX_AUTOMATIC_CALENDAR_DAYS
      }));
      return;
    }
    const confirmed = await confirmDangerAction({
      title: qaLocalize("StateProgression.ResolveTitle", "Resolve pending state progression"),
      heading: qaLocalize("StateProgression.ResolveHeading", "Process {days} days for {actor}?", { days, actor: entry.actor.name ?? "" }),
      message: qaLocalize("StateProgression.ResolveMessage", "The missing calendar days will be simulated sequentially using the currently applicable daily actions."),
      warning: qaLocalize("StateProgression.TimeSkipWarning", "This can resolve injuries, wash states, addictions and other daily conditions. Moving the calendar backwards will not undo these changes."),
      confirmLabel: qaLocalize("StateProgression.Resolve", "Resolve"),
      cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
      icon: "fas fa-list-check",
      width: 470
    });
    if (!confirmed) return;

    updateGMSummaryStatus(state, actorId, { state: "processing", days });
    const result = await processActorAutomaticDays(entry.actor, marker.date, context, days, {
      maxDays: days > DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT ? days : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT
    });
    updateGMSummaryStatus(state, actorId, result.failedActions
      ? { state: "error", days: result.limitedDays, result, detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: result.failedActions }) }
      : result.limitedDays > 0
        ? { state: "blocked", days: result.limitedDays, result, detail: qaLocalize("StateProgression.AutomaticDaysLimited", "Processed {processed} calendar days; {remaining} days remain pending.", { processed: result.processedDays, remaining: result.limitedDays }) }
        : { state: "done", days: 0, result, detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: result.processedDays }) });
    if (entry.primaryUser?.active) await sendPlayerResult(entry.primaryUser, entry.actor, context, result);
    return;
  }

  const result = await openNewDayDialog(null, entry.actor, {
    source: "calendaria-gm",
    targetDate: context.date,
    applyHandler: async ({ selectedIds }) => handleCalendariaApplyRequest({
      actorId: entry.actor.id,
      targetDate: context.date,
      calendarId: context.calendarId,
      selectedIds
    }, {
      requestUser: game.user,
      requesterId: game.user.id,
      activeGM: game.user,
      isRemote: false
    })
  });
  if (result?.calendarResult && entry.primaryUser?.active) await sendPlayerResult(entry.primaryUser, entry.actor, context, result.calendarResult);
}

async function baselinePlayerActors(context, { force = false } = {}) {
  if (!isActiveQuickAccessGM()) return 0;
  let count = 0;
  for (const { actor } of getAssignedPlayerActors()) {
    const marker = getActorCalendarMarker(actor);
    if (!force && marker?.calendarId === context.calendarId && marker?.date) continue;
    await setActorCalendarMarker(actor, context);
    count += 1;
  }
  return count;
}

async function ensureMissingPlayerBaselines(context) {
  return baselinePlayerActors(context, { force: false });
}

function pendingDaysForActor(actor, context) {
  const status = calculateActorCalendarStatus(getActorCalendarMarker(actor), context);
  return Math.max(0, Number(status.days) || 0);
}

export function getActorCalendarMarker(actor) {
  let raw = null;
  try {
    raw = actor?.getFlag?.(MODULE_ID, FLAG_STATE_PROGRESSION_CALENDAR)
      ?? actor?.flags?.[MODULE_ID]?.[FLAG_STATE_PROGRESSION_CALENDAR]
      ?? null;
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

export async function setActorCalendarMarker(actor, context, metadata = {}, documentOptions = {}) {
  const date = normalizeCalendariaDate(context?.date);
  const calendarId = String(context?.calendarId ?? "").trim();
  if ((!actor?.setFlag && !actor?.update) || !date || !calendarId) return false;

  const marker = { calendarId, date };
  if (metadata?.resolution === "absent") {
    marker.resolution = "absent";
    marker.skippedDays = Math.max(1, Math.floor(Number(metadata.skippedDays) || 1));
    const previousDate = normalizeCalendariaDate(metadata.previousDate);
    if (previousDate) marker.previousDate = previousDate;
  }

  if (Object.keys(documentOptions ?? {}).length && typeof actor.update === "function") {
    await actor.update({ [`flags.${MODULE_ID}.${FLAG_STATE_PROGRESSION_CALENDAR}`]: marker }, documentOptions);
  } else {
    await actor.setFlag(MODULE_ID, FLAG_STATE_PROGRESSION_CALENDAR, marker);
  }
  return true;
}

export async function markActorCalendariaAbsent(actor, context, api = context?.api ?? getCalendariaApi()) {
  return enqueueStateProgressionOperation(actor, () => markActorCalendariaAbsentUnlocked(actor, context, api));
}

async function markActorCalendariaAbsentUnlocked(actor, context, api) {
  const marker = getActorCalendarMarker(actor);
  const status = calculateActorCalendarStatus(marker, context, api);
  const skippedDays = Math.max(0, Math.floor(Number(status.days) || 0));
  if (!marker || skippedDays <= 0) return { changed: false, skippedDays: 0, previousMarker: marker };

  await setActorCalendarMarker(actor, context, {
    resolution: "absent",
    skippedDays,
    previousDate: marker.date
  });
  return { changed: true, skippedDays, previousMarker: marker };
}

export async function undoActorCalendariaAbsent(actor, context) {
  return enqueueStateProgressionOperation(actor, () => undoActorCalendariaAbsentUnlocked(actor, context));
}

async function undoActorCalendariaAbsentUnlocked(actor, context) {
  const marker = getActorCalendarMarker(actor);
  if (!isAbsentMarkerForContext(marker, context) || !marker.previousDate) {
    return { changed: false, restoredMarker: marker };
  }

  const restored = { calendarId: marker.calendarId, date: marker.previousDate };
  await setActorCalendarMarker(actor, restored);
  return { changed: true, restoredMarker: restored, skippedDays: marker.skippedDays ?? 1 };
}

function isAbsentMarkerForContext(marker, context) {
  return Boolean(
    marker?.resolution === "absent"
    && marker?.calendarId === context?.calendarId
    && sameCalendariaDay(marker?.date, context?.date)
  );
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

function getCalendariaContext(dateOverride = null) {
  const api = getCalendariaApi();
  if (!api?.getCurrentDateTime || !api?.getActiveCalendar) return null;
  try {
    // Calendaria's public getCurrentDateTime() is already 1-indexed. Only the
    // raw dayChange hook payload requires calendariaHookComponentToPublicDate().
    const date = normalizeCalendariaDate(dateOverride ?? api.getCurrentDateTime());
    const calendar = api.getActiveCalendar();
    const calendarId = String(calendar?.metadata?.id ?? calendar?.id ?? "").trim();
    if (!date || !calendarId) return null;
    return { api, calendar, calendarId, date };
  } catch (_error) {
    return null;
  }
}

function isCalendariaModuleActive() {
  const module = globalThis.game?.modules?.get?.(CALENDARIA_MODULE_ID);
  if (!module) return Boolean(globalThis.CALENDARIA?.api || calendariaReadyApi);
  return module.active !== false;
}

function getCalendariaApi() {
  if (!isCalendariaModuleActive()) return null;
  const module = globalThis.game?.modules?.get?.(CALENDARIA_MODULE_ID);
  return globalThis.CALENDARIA?.api ?? calendariaReadyApi ?? module?.api ?? null;
}

function registerResultSocket() {
  if (resultSocketRegistered || !globalThis.game?.socket?.on) return false;
  game.socket.on(SOCKET_CHANNEL, (message) => {
    if (message?.type === PLAYER_RESULT_TYPE) void handlePlayerResultMessage(message);
  });
  resultSocketRegistered = true;
  return true;
}

async function sendPlayerResult(user, actor, context, result) {
  if (!isActiveQuickAccessGM() || !user?.active || !game.socket?.emit) return false;
  const packetId = makeSocketRequestId();
  const message = {
    type: PLAYER_RESULT_TYPE,
    packetId,
    recipientId: String(user.id),
    actorId: String(actor.id),
    actorName: String(actor.name ?? ""),
    activeGMId: String(game.user.id),
    calendarId: context.calendarId,
    targetDate: context.date,
    result,
    createdAt: Date.now()
  };

  try {
    await createSocketProof(PLAYER_RESULT_PROOF_KIND, packetId, message, game.user);
    scheduleSocketProofCleanup(game.user, PLAYER_RESULT_PROOF_KIND, packetId, RESULT_PROOF_TTL_MS);
    game.socket.emit(SOCKET_CHANNEL, message);
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | could not send Calendaria progression result to player`, error);
    return false;
  }
}

async function handlePlayerResultMessage(message) {
  if (!isValidPlayerResultMessage(message) || message.recipientId !== game.user?.id || game.user?.isGM) return;
  const gm = findGameUser(message.activeGMId);
  if (!gm?.isGM || !gm.active) return;

  const proof = await verifySocketProofWithRetry(gm, PLAYER_RESULT_PROOF_KIND, message.packetId, message, {
    ttlMs: RESULT_PROOF_TTL_MS
  });
  if (!proof.ok) return;
  if (!consumeSocketProof(gm.id, PLAYER_RESULT_PROOF_KIND, message.packetId)) return;

  const actor = globalThis.game?.actors?.get?.(message.actorId) ?? resolveUserCharacter(game.user, game.actors);
  await showPlayerResult(actor, {
    calendarId: message.calendarId,
    date: normalizeCalendariaDate(message.targetDate)
  }, message.result);
}

function isValidPlayerResultMessage(message) {
  try {
    normalizeSocketRequestId(message?.packetId);
  } catch (_error) {
    return false;
  }
  return message?.type === PLAYER_RESULT_TYPE
    && typeof message.recipientId === "string"
    && typeof message.actorId === "string"
    && typeof message.activeGMId === "string"
    && typeof message.calendarId === "string"
    && Boolean(normalizeCalendariaDate(message.targetDate))
    && message.result && typeof message.result === "object"
    && Number.isFinite(Number(message.createdAt));
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
      ? `<ul>${entries.map((entry) => `<li class="${entry.ok ? "is-ok" : "is-failed"}"><strong>${escapeHtml(entry.itemName ?? "")}</strong><span>${escapeHtml(entry.detail ?? "")}</span></li>`).join("")}</ul>`
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
    </div>`;
}

function calendarApplyOptions() {
  return {
    postChat: false,
    suppressNotifications: true,
    source: "calendaria"
  };
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

function normalizeSelectedActionIds(value) {
  if (!Array.isArray(value)) throw progressionError("invalid-action-list", "Selected action ids must be an array");
  const unique = [];
  const seen = new Set();
  for (const raw of value) {
    const id = String(raw ?? "").trim();
    if (!id || id.length > 240 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length > 250) throw progressionError("too-many-actions", "Too many selected daily actions");
  }
  return unique;
}

function resolveAssignedActorEntry(actorId) {
  const id = String(actorId ?? "").trim();
  const entry = getAssignedPlayerActors().find((candidate) => candidate.actor.id === id);
  if (!entry) throw progressionError("actor-not-assigned", "Actor is not assigned to a player");
  return entry;
}

function assertRequesterAssignedToActor(entry, user) {
  if (!user) throw progressionError("missing-requester", "Requesting user was not found");
  if (user.isGM) return;
  if (entry.users.some((candidate) => candidate.id === user.id)) return;
  throw progressionError("actor-permission", "The requesting player is not assigned to this actor");
}

function assertCalendariaModeAvailable() {
  if (!usesCalendariaStateProgression()) throw progressionError("wrong-progression-mode", "Calendaria state progression is not enabled");
  if (!getCalendariaContext()) throw progressionError("calendaria-unavailable", "Calendaria is unavailable");
}

function resolveUserCharacter(user, actors) {
  const value = user?.character;
  const id = typeof value === "string" ? value : value?.id ?? user?.characterId ?? null;

  // Prefer the canonical world Actor from game.actors. User.character can be a
  // Document reference supplied by another part of Foundry; resolving by id
  // avoids carrying a stale/non-canonical instance into write operations while
  // preserving the old fallback when no Actor collection is available.
  const canonical = id ? actors?.get?.(id) ?? null : null;
  if (canonical?.documentName === "Actor") return canonical;
  if (value?.documentName === "Actor") return value;
  return null;
}

function sameCalendariaDay(a, b) {
  const left = normalizeCalendariaDate(a);
  const right = normalizeCalendariaDate(b);
  return Boolean(left && right && left.year === right.year && left.month === right.month && left.day === right.day);
}

function summaryKey(context) {
  return `${String(context?.calendarId ?? "")}:${calendariaDateKey(context?.date)}`;
}

function formatCalendariaDate(date) {
  const value = normalizeCalendariaDate(date);
  if (!value) return "—";
  return `${value.day}.${value.month}.${value.year}`;
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
    absent: "Absent"
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

function progressionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
