import {
  FLAG_STATE_PROGRESSION_CALENDAR,
  FLAG_STATE_PROGRESSION_FAILURES,
  FLAG_STATE_PROGRESSION_OPERATION,
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
  findDialogForm,
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
import { clearDocumentFlagNullVerified, clonePlainJson, flagReplaceUpdatePath, plainValuesEqual, readDocumentFlag, setDocumentFlagVerified } from "./document-writes.js";
import {
  calendariaDateKey,
  calendariaHookComponentToPublicDate,
  formatCalendariaDate,
  getCalendariaApi,
  getCalendariaContext,
  hasCalendariaReadyFired,
  isCalendariaModuleActive,
  normalizeCalendariaDate,
  registerCalendariaReadyHook,
  sameCalendariaDay
} from "./integration/calendaria-adapter.js";
import { addictionCalendarDayKey, getPendingAddictions } from "./conditions/services/addiction-service.js";

export { calendariaDateKey, calendariaHookComponentToPublicDate, normalizeCalendariaDate } from "./integration/calendaria-adapter.js";

export const STATE_PROGRESSION_MODES = Object.freeze({
  LONG_REST: "long-rest",
  CALENDARIA: "calendaria"
});

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
let lastAheadWarningKey = "";

const activePlayerPrompts = new Set();
const gmSummaryWindows = new Map();
const activeSummaryOperations = new Map();
const enqueueStateProgressionOperation = createObjectOperationQueue();

function beginSummaryOperation(actorId) {
  const operation = Symbol();
  activeSummaryOperations.set(actorId, operation);
  return () => {
    if (activeSummaryOperations.get(actorId) === operation) activeSummaryOperations.delete(actorId);
  };
}

export function handleStateProgressionActorDeleted(actor) {
  const actorId = String(actor?.id ?? "");
  if (!actorId) return;
  activeSummaryOperations.delete(actorId);
  for (const state of gmSummaryWindows.values()) {
    if (!state.entries.has(actorId)) continue;
    state.entries.delete(actorId);
    state.statuses.delete(actorId);
    refreshGMSummaryDom(state);
  }
}

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
  registerCalendariaReadyHook(handleCalendariaReady);
  globalThis.Hooks?.on?.("fblQuickAccess.stateProgressionModeChanged", (mode) => {
    void handleProgressionModeChanged(mode);
  });
  const refreshMorningSummary = item => {
    const actor = item?.parent;
    if (!actor || !isActiveQuickAccessGM()) return;
    for (const state of gmSummaryWindows.values()) {
      if (!state.entries.has(actor.id)) continue;
      const old = state.statuses.get(actor.id);
      if (old?.state === "processing" && activeSummaryOperations.has(actor.id)) continue;
      const recovery = calendarOperationSummaryStatus(actor, state.context);
      if (recovery) {
        updateGMSummaryStatus(state, actor.id, recovery);
        continue;
      }
      const pendingCount = getPendingAddictions(actor).length;
      if (!pendingCount && old?.pendingManual) {
        const marker = getActorCalendarMarker(actor);
        const status = calculateActorCalendarStatus(marker, state.context);
        const nextState = old?.state === "error"
          ? "error"
          : status.status === "ahead"
            ? "ahead"
            : status.days > 0 ? "pending" : "done";
        updateGMSummaryStatus(state, actor.id, {
          state: nextState,
          days: status.status === "ahead" ? Math.abs(status.days) : Math.max(0, status.days ?? 0),
          pendingManual: 0,
          detail: old?.state === "error" ? old.detail : (status.status === "ahead" ? aheadDetail(marker, status.days) : ""),
          result: old?.state === "error" ? old.result : null
        });
      } else if (pendingCount) {
        updateGMSummaryStatus(state, actor.id, { ...old, pendingManual: pendingCount });
      }
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
    await ensureMissingPlayerBaselines(context);
    warnIfAnyMarkersAhead(context);
    warnIfCalendarRecoveryNeeded();
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

export function calculateActorCalendarStatus(marker, context, api = context?.api ?? getCalendariaApi()) {
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
  warnIfCalendarRecoveryNeeded();
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

async function handleCalendariaReady() {
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
    warnIfCalendarRecoveryNeeded();
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

  const outcome = await baselinePlayerActors(context, { force: true });
  if (outcome.failedActorIds.length || outcome.skippedActorIds.length) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.CalendarChangedPartial",
      "After switching calendars, baselines saved: {count}. Skipped: {skipped}. Failed: {failed}.", {
        count: outcome.count, skipped: outcome.skippedActorIds.length, failed: outcome.failedActorIds.length
      }));
  } else {
    ui.notifications?.info?.(qaLocalize(
      "StateProgression.CalendarChanged",
      "Calendaria changed its active calendar. Player state progression was re-baselined to the current date; no states were advanced."));
  }
  warnIfCalendarRecoveryNeeded();
}

async function handleCalendariaDayChange(data) {
  if (!usesCalendariaStateProgression()) return;
  const previous = calendariaHookComponentToPublicDate(data?.previous);
  const current = calendariaHookComponentToPublicDate(data?.current);
  if (!previous || !current) return;
  const context = getCalendariaContext(current);
  if (!context) return;

  let delta;
  try {
    delta = Number(context.api.daysBetween(previous, current));
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
      warnIfAnyMarkersAhead(context);
    }
    return;
  }

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
  const entries = getAssignedPlayerActors();
  if (!entries.length) return;

  const summary = await prepareGMSummary(context, { reason: "time-skip", skipBaselineMutation: true });
  if (delta > MAX_AUTOMATIC_CALENDAR_DAYS) {
    for (const entry of entries) {
      updateGMSummaryStatus(summary, entry.actor.id, calendarOperationSummaryStatus(entry.actor, context) ?? {
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

  const approvedMarkers = new Map(entries.map(({ actor }) => [actor.id, getActorCalendarMarker(actor)]));
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
      const recovery = calendarOperationSummaryStatus(entry.actor, context);
      if (recovery) {
        updateGMSummaryStatus(summary, entry.actor.id, recovery);
        continue;
      }
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

  if (!isActiveQuickAccessGM() || !usesCalendariaStateProgression()) return;
  if (!isCurrentCalendarDay(context)) {
    ui.notifications?.warn?.(pendingChangedDetail());
    return;
  }

  for (const entry of entries) {
    if (!usesCalendariaStateProgression()) return;
    const recovery = calendarOperationSummaryStatus(entry.actor, context);
    if (recovery) {
      updateGMSummaryStatus(summary, entry.actor.id, recovery);
      continue;
    }
    const marker = getActorCalendarMarker(entry.actor);
    if (!plainValuesEqual(approvedMarkers.get(entry.actor.id), marker)) {
      updateGMSummaryStatus(summary, entry.actor.id, {
        state: entry.primaryUser?.active ? "pending" : "offline",
        days: pendingDaysForActor(entry.actor, context), detail: pendingChangedDetail()
      });
      continue;
    }
    if (!marker || marker.calendarId !== context.calendarId) {
      // Missing markers usually mean a newly assigned/newly created PC. A
      // multi-day world jump must not age a character from an unknown origin.
      try {
        const updated = await ensureActorCalendarBaseline(entry.actor, context, { approvedMarker: marker });
        updateGMSummaryStatus(summary, entry.actor.id, calendarOperationSummaryStatus(entry.actor, context) ?? (updated ? {
          state: "baseline",
          days: 0,
          detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
        } : summaryStatusForCurrentMarker(getActorCalendarMarker(entry.actor), context)));
      } catch (error) {
        if (error?.code === "stale-calendar-day") {
          ui.notifications?.warn?.(pendingChangedDetail());
          return;
        }
        console.error(`${MODULE_ID} | Calendaria baseline write failed for ${entry.actor?.name}`, error);
        updateGMSummaryStatus(summary, entry.actor.id, {
          state: "error",
          days: 0,
          detail: qaLocalize("StateProgression.BaselineFailed", "Could not save the Calendaria baseline marker.")
        });
      }
      continue;
    }

    const status = calculateActorCalendarStatus(marker, context);
    if (status.status === "ahead") {
      updateGMSummaryStatus(summary, entry.actor.id, summaryStatusForAheadMarker(marker, status.days));
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

    const releaseProcessing = beginSummaryOperation(entry.actor.id);
    updateGMSummaryStatus(summary, entry.actor.id, { state: "processing", days });
    try {
      const result = await processActorAutomaticDays(entry.actor, marker.date, context, days, {
        approvedMarker: marker,
        maxDays: days > DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT ? days : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT
      });
      updateGMSummaryStatus(summary, entry.actor.id, result.failedDays > 0
        ? { state: "error", days: result.limitedDays, result, detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: result.failedActions }) }
        : result.limitedDays > 0
          ? { state: "blocked", days: result.limitedDays, result, detail: qaLocalize("StateProgression.AutomaticDaysLimited", "Processed {processed} calendar days; {remaining} days remain pending.", { processed: result.processedDays, remaining: result.limitedDays }) }
          : { state: "done", days: 0, result, detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: result.processedDays }) });

      await sendPlayerResults(entry, context, result);
    } catch (error) {
      if (error?.code === "stale-calendar-day") {
        updateGMSummaryStatus(summary, entry.actor.id, calendarOperationSummaryStatus(entry.actor, context) ?? {
          state: "pending", days: pendingDaysForActor(entry.actor, context), detail: pendingChangedDetail()
        });
        ui.notifications?.warn?.(pendingChangedDetail());
        return;
      }
      console.error(`${MODULE_ID} | automatic Calendaria time skip failed for ${entry.actor?.name}`, error);
      updateGMSummaryStatus(summary, entry.actor.id, calendarOperationSummaryStatus(entry.actor, context) ?? {
        state: "error",
        days: pendingDaysForActor(entry.actor, context),
        detail: qaLocalize("StateProgression.ApplyFailed", "Could not apply Calendaria state progression.")
      });
    } finally {
      releaseProcessing();
    }
  }
}

async function processActorAutomaticDays(actor, startDate, context, requestedDays, options = {}) {
  return enqueueStateProgressionOperation(actor, () =>
    processActorAutomaticDaysUnlocked(actor, startDate, context, requestedDays, options)
  );
}

async function processActorAutomaticDaysUnlocked(actor, startDate, context, requestedDays, options = {}) {
  assertCalendarApplyContext(context);
  const api = context.api ?? getCalendariaApi();
  const dayResults = [];
  // Requests target a date. Another queued request may already have advanced
  // this Actor while this request was waiting for the queue.
  const marker = getActorCalendarMarker(actor);
  if (options.approvedMarker && !plainValuesEqual(marker, options.approvedMarker)) {
    throw progressionError("stale-calendar-day", pendingChangedDetail());
  }
  const storedOperation = getCalendarOperation(actor);
  if (storedOperation && !canFinishCalendarOperation(storedOperation, marker, context, api)) {
    throw calendarRecoveryError(storedOperation);
  }
  const currentStatus = calculateActorCalendarStatus(marker, context, api);
  if (marker && currentStatus.status === "baseline") return emptyCalendarResult(context.date);
  const initialDate = normalizeCalendariaDate(marker?.date ?? startDate);
  let cursor = initialDate;
  const pendingDays = marker ? Math.max(0, Number(currentStatus.days) || 0) : Number(requestedDays);
  const requested = Math.min(Math.max(0, Math.floor(Number(requestedDays) || 0)), Math.floor(pendingDays));
  const configuredLimit = Number.isFinite(Number(options.maxDays))
    ? Math.max(0, Math.floor(Number(options.maxDays)))
    : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT;
  const effectiveLimit = Math.min(configuredLimit, MAX_AUTOMATIC_CALENDAR_DAYS);
  let remaining = Math.min(requested, effectiveLimit);
  let failedDays = 0;
  let failedActions = 0;
  let pendingManual = getPendingAddictions(actor).length;
  let recoveredMarkerDate = null;

  while (remaining > 0 && cursor) {
    assertCalendarApplyContext(context);
    const nextDate = normalizeCalendariaDate(api?.addDays?.(cursor, 1));
    if (!nextDate) break;

    const operation = getCalendarOperation(actor);
    if (operation) {
      const consumed = api.daysBetween(cursor, operation.through);
      await finishCalendarOperation(actor, context, operation, consumed < remaining ? { render: false } : {});
      recoveredMarkerDate = operation.through;
      if (operation.failures.length) {
        failedDays += 1;
        failedActions += operation.failures.length;
      }
      cursor = operation.through;
      remaining -= consumed;
      pendingManual = getPendingAddictions(actor).length;
      continue;
    }
    if (pendingManual) break;

    const plan = await buildNewDayPlanWithProviders(actor, { dayKey: addictionCalendarDayKey(context.calendarId, nextDate) });
    assertCalendarApplyContext(context);
    const selectedIds = plan.actions.filter((action) => action.checked !== false).map((action) => action.id);

    if (plan.providerErrors?.length) {
      failedDays += 1;
      failedActions += plan.providerErrors.length;
      await recordCalendarFailures(actor, context, nextDate, plan.providerErrors.map(error => ({
        id: String(error.providerId ?? error.id ?? "provider"), kind: "provider-build"
      })));
      // Nothing for this date has been applied yet. Leave its marker unchanged
      // so a recovered provider can be tried after reload without double ticks.
      break;
    }

    // If only the bookkeeping Short Rest reset remains, repeating an empty day
    // hundreds of times would create document traffic with no gameplay value.
    const meaningful = plan.actions.filter((action) => action.kind !== "short-rest-reset");
    if (!meaningful.length) {
      const reset = plan.actions.find((action) => action.kind === "short-rest-reset");
      const targetDate = normalizeCalendariaDate(api?.addDays?.(cursor, remaining)) ?? context.date;
      if (reset) {
        const resetResult = await applyCalendarDay(actor, context, cursor, nextDate, targetDate, plan, [reset.id]);
        dayResults.push({ date: nextDate, result: serializeNewDayResult(resetResult) });
        if (resetResult.failed.length) {
          failedDays += 1;
          failedActions += resetResult.failed.length;
        }
      } else {
        await setActorCalendarMarker(actor, { ...context, date: targetDate });
      }
      remaining = 0;
      cursor = targetDate;
      break;
    }

    const applied = await applyCalendarDay(actor, context, cursor, nextDate, nextDate, plan, selectedIds,
      remaining > 1 ? { render: false } : {});
    const dayResult = { date: nextDate, result: serializeNewDayResult(applied) };
    dayResults.push(dayResult);
    if (applied.failed.length) {
      failedDays += 1;
      failedActions += applied.failed.length;
    }
    cursor = nextDate;
    remaining -= 1;
    pendingManual = getPendingAddictions(actor).length;
  }

  // `dayResults` counts days that produced an explicit result entry, not days
  // whose calendar marker was logically consumed. The short-rest-only shortcut
  // intentionally jumps the marker straight to context.date after one reset, so
  // derive the contract from marker advancement instead of result count.
  let processedDays = Math.max(0, requested - remaining);
  try {
    const markerAdvance = Number(api?.daysBetween?.(initialDate, cursor));
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
    pendingManual,
    ...(recoveredMarkerDate ? { recoveredMarkerDate } : {}),
    days: dayResults
  };
}

async function recordCalendarFailures(actor, context, date, failures) {
  await actor.setFlag(MODULE_ID, FLAG_STATE_PROGRESSION_FAILURES,
    calendarFailureHistory(actor, context.calendarId, date, calendarFailureIds(failures)));
}

function calendarFailureIds(failures) {
  return failures.map(value => ({
    id: String(value.action?.id ?? value.id ?? "action"),
    kind: value.kind === "provider-build" ? "provider-build" : "action-apply"
  }));
}

function calendarFailureHistory(actor, calendarId, date, failures) {
  const previous = readDocumentFlag(actor, MODULE_ID, FLAG_STATE_PROGRESSION_FAILURES);
  const entries = Array.isArray(previous) ? previous : [];
  const entry = { calendarId, date, failures, at: Date.now() };
  const next = entries.filter(value => value.calendarId !== calendarId || !sameCalendariaDay(value.date, date));
  next.push(entry);
  return next.slice(-100);
}

async function checkCurrentPlayerPending({ context = null } = {}) {
  if (game.user?.isGM || !usesCalendariaStateProgression()) return null;
  const actor = resolveUserCharacter(game.user, game.actors);
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return null;

  context ??= getCalendariaContext();
  if (!context) return null;
  const marker = getActorCalendarMarker(actor);
  const operation = getCalendarOperation(actor);
  if (operation) {
    try {
      await executeAsActiveGM(REPORT_OPERATION, { actorId: actor.id, targetDate: context.date, calendarId: context.calendarId });
    } catch (error) {
      console.error(`${MODULE_ID} | could not report unfinished Calendaria progression`, error);
    }
    ui.notifications?.warn?.(qaLocalize("StateProgression.DayAwaitingGM", "The GM needs to review an unfinished calendar day for this character."));
    return null;
  }

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
    if (code === "calendar-reconciliation-required") {
      ui.notifications?.warn?.(qaLocalize("StateProgression.DayAwaitingGM", "The GM needs to review an unfinished calendar day for this character."));
    } else if (code === "multi-day-pending" || code === "stale-calendar-day") {
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
  const actorEntry = resolveAssignedActorEntry(payload?.actorId);
  assertRequesterAssignedToActor(actorEntry, context.requestUser);
  const actor = actorEntry.actor;
  const targetDate = normalizeCalendariaDate(payload?.targetDate);

  return enqueueStateProgressionOperation(actor, async () => {
    const calendaria = getCalendariaContext();
    if (!calendaria || String(payload?.calendarId ?? "") !== calendaria.calendarId || !sameCalendariaDay(targetDate, calendaria.date)) {
      throw progressionError("stale-calendar-day", "The Calendaria calendar or date changed while the dialog was open");
    }

    const marker = getActorCalendarMarker(actor);
    const operation = getCalendarOperation(actor);
    const status = calculateActorCalendarStatus(marker, calendaria);
    let plan, selectedIds;
    if (operation) {
      if (!canFinishCalendarOperation(operation, marker, calendaria)) {
        updateCurrentGMSummary(actor.id, calendaria, calendarOperationSummaryStatus(actor, calendaria));
        throw calendarRecoveryError(operation);
      }
      if (!sameCalendariaDay(operation.through, targetDate)) {
        updateCurrentGMSummary(actor.id, calendaria, calendarOperationSummaryStatus(actor, calendaria));
        throw progressionError("multi-day-pending", "Multiple Calendaria days are pending");
      }
    } else {
      const pendingManual = getPendingAddictions(actor).length;
      if (pendingManual) {
        updateCurrentGMSummary(actor.id, calendaria, { state: "blocked", days: status.days ?? 0 });
        return { status: "awaiting-endurance", calendarResult: { ...emptyCalendarResult(marker?.date ?? targetDate), pendingManual } };
      }
      if (status.status === "baseline") {
        await setActorCalendarMarker(actor, calendaria);
        updateCurrentGMSummary(actor.id, calendaria, {
          state: "baseline",
          days: 0,
          detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
        });
        return { status: "baseline", calendarResult: emptyCalendarResult(targetDate) };
      }
      if (status.status === "ahead") {
        updateCurrentGMSummary(actor.id, calendaria, summaryStatusForAheadMarker(marker, status.days));
        throw progressionError("stale-calendar-day", "The character calendar marker is ahead of the current date");
      }
      if (status.status === "current") {
        updateCurrentGMSummary(actor.id, calendaria, summaryStatusForCurrentMarker(marker, calendaria));
        return {
          status: isAbsentMarkerForContext(marker, calendaria) ? "already-skipped" : "already-processed",
          calendarResult: emptyCalendarResult(targetDate)
        };
      }
      if (status.status !== "pending") {
        updateCurrentGMSummary(actor.id, calendaria, { state: "pending", days: status.days ?? 0 });
        throw progressionError("multi-day-pending", "Multiple Calendaria days are pending");
      }
      ({ plan, selectedIds } = await buildInteractiveCalendarPlan(actor, calendaria, payload));
    }

    const releaseProcessing = beginSummaryOperation(actor.id);
    updateCurrentGMSummary(actor.id, calendaria, { state: "processing", days: status.days });
    try {
      let failedActions, days;
      if (operation) {
        await finishCalendarOperation(actor, calendaria, operation);
        failedActions = operation.failures.length;
        days = [];
      } else {
        const applied = await applyCalendarDay(actor, calendaria, marker.date, targetDate, targetDate, plan, selectedIds);
        failedActions = applied.failed.length;
        days = [{ date: targetDate, result: serializeNewDayResult(applied) }];
      }
      const calendarResult = {
        mode: "interactive",
        processedDays: status.days,
        failedDays: failedActions ? 1 : 0,
        failedActions,
        pendingManual: getPendingAddictions(actor).length,
        ...(operation ? { recoveredMarkerDate: operation.through } : {}),
        days
      };
      updateCurrentGMSummary(actor.id, calendaria, failedActions
        ? {
            state: "error",
            days: 0,
            result: calendarResult,
            detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: failedActions })
          }
        : {
            state: "done",
            days: 0,
            result: calendarResult,
            detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: calendarResult.processedDays })
          });
      return { status: failedActions ? "processed-with-errors" : "processed", calendarResult };
    } catch (error) {
      updateCurrentGMSummary(actor.id, calendaria, calendarOperationSummaryStatus(actor, calendaria) ?? {
        state: "error",
        days: pendingDaysForActor(actor, calendaria),
        detail: qaLocalize("StateProgression.ApplyFailed", "Could not apply Calendaria state progression.")
      });
      throw error;
    } finally {
      releaseProcessing();
    }
  });
}

async function buildInteractiveCalendarPlan(actor, context, payload) {
  const plan = await buildNewDayPlanWithProviders(actor, { dayKey: addictionCalendarDayKey(context.calendarId, context.date) });
  if (plan.providerErrors?.length) {
    await recordCalendarFailures(actor, context, context.date, plan.providerErrors.map(error => ({ id: error.providerId, kind: "provider-build" })));
    throw progressionError("provider-build-failed", "A New Day provider is unavailable. The day was not applied.");
  }
  const selectedIds = normalizeSelectedActionIds(payload?.selectedIds);
  const knownIds = new Set(plan.actions.map(action => action.id));
  const unknown = selectedIds.find(id => !knownIds.has(id));
  if (unknown) throw progressionError("invalid-action", `Unknown new-day action: ${unknown}`);

  if (payload?.selectedPreconditions && typeof payload.selectedPreconditions === "object") {
    for (const id of selectedIds) {
      const expected = Object.hasOwn(payload.selectedPreconditions, id) ? payload.selectedPreconditions[id] : undefined;
      const live = plan.preconditions?.[id];
      if (live !== undefined && expected !== live) {
        throw progressionError("stale-plan", qaLocalize("NewDay.StalePlan", "Данные изменились. Обновите предварительный просмотр."));
      }
    }
  }
  return { plan, selectedIds };
}

async function handleCalendariaPendingReport(payload, context) {
  assertCalendariaModeAvailable();
  const calendaria = getCalendariaContext();
  if (!calendaria) throw progressionError("calendaria-unavailable", "Calendaria is unavailable");

  const actorEntry = resolveAssignedActorEntry(payload?.actorId);
  assertRequesterAssignedToActor(actorEntry, context.requestUser);

  const actor = actorEntry.actor;
  await ensureActorCalendarBaseline(actor, calendaria);
  await prepareGMSummary(calendaria, { reason: "player-report", skipBaselineMutation: true });
  const recovery = calendarOperationSummaryStatus(actor, calendaria);
  if (recovery) return { status: recovery.state, days: recovery.days };
  const status = calculateActorCalendarStatus(getActorCalendarMarker(actor), calendaria);
  return { status: status.status, days: status.days ?? 0 };
}

async function prepareGMSummary(context, { reason = "day-change", skipBaselineMutation = false } = {}) {
  if (!isActiveQuickAccessGM()) return null;
  const entries = getAssignedPlayerActors();
  const summary = openOrRefreshGMSummary(context, entries, reason);

  for (const entry of entries) {
    const existing = summary.statuses.get(entry.actor.id);
    if (existing?.state === "processing" && activeSummaryOperations.has(entry.actor.id)) continue;

    const operationStatus = calendarOperationSummaryStatus(entry.actor, context);
    if (operationStatus) {
      updateGMSummaryStatus(summary, entry.actor.id, operationStatus);
      continue;
    }

    let marker = getActorCalendarMarker(entry.actor);
    if ((!marker || marker.calendarId !== context.calendarId) && !skipBaselineMutation) {
      try {
        const updated = await ensureActorCalendarBaseline(entry.actor, context);
        const recovery = calendarOperationSummaryStatus(entry.actor, context);
        marker = getActorCalendarMarker(entry.actor);
        if (recovery || updated) {
          updateGMSummaryStatus(summary, entry.actor.id, recovery ?? {
            state: "baseline",
            days: 0,
            detail: qaLocalize("StateProgression.Baselined", "Baseline set to the current Calendaria date.")
          });
          continue;
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Calendaria baseline write failed for ${entry.actor?.name}`, error);
        updateGMSummaryStatus(summary, entry.actor.id, {
          state: "error",
          days: 0,
          detail: qaLocalize("StateProgression.BaselineFailed", "Could not save the Calendaria baseline marker.")
        });
        continue;
      }
    }

    const status = calculateActorCalendarStatus(marker, context);
    if (status.status === "ahead") {
      updateGMSummaryStatus(summary, entry.actor.id, summaryStatusForAheadMarker(marker, status.days));
    } else if (status.status === "current") {
      updateGMSummaryStatus(summary, entry.actor.id, summaryStatusForCurrentMarker(marker, context));
    } else if (status.status === "baseline") {
      updateGMSummaryStatus(summary, entry.actor.id, { state: "baseline", days: 0, detail: "" });
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
    state.entries = new Map(entries.map(entry => [entry.actor.id, entry]));
    for (const id of state.statuses.keys()) {
      if (!state.entries.has(id)) state.statuses.delete(id);
    }
    state.context = context;
    refreshGMSummaryDom(state);
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
        ${hasActors ? `
          <div class="fblqa-progression-summary-toolbar">
            <button type="button" data-action="reset-all-current">
              <i class="fas fa-calendar-check" aria-hidden="true"></i>
              ${escapeHtml(qaLocalize("StateProgression.ResetAllCurrent", "Reset all to current date"))}
            </button>
            <button type="button" data-action="rewind-all">
              <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
              ${escapeHtml(qaLocalize("StateProgression.RewindAll", "Rewind all…"))}
            </button>
          </div>` : ""}
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
  const operation = getCalendarOperation(entry.actor);
  const canResolve = status.state === "unmarked" || (status.state === "recovery" && status.canAcknowledge)
    || (!operation && ["pending", "offline", "error", "blocked"].includes(status.state) && pendingDays > 0 && !pendingManual);
  const canMarkAbsent = !operation && ["pending", "offline", "blocked"].includes(status.state) && pendingDays > 0 && !pendingManual;
  const canUndoAbsent = !operation && status.state === "absent" && Boolean(status.undoAvailable);
  const normalResetNeeded = ["ahead", "baseline", "absent"].includes(status.state) || pendingDays > 0
    || marker?.calendarId !== state.context?.calendarId || !sameCalendariaDay(marker?.date, state.context?.date);
  const canResetCurrent = !isProcessing && (operation
    ? status.state === "recovery" && !status.canAcknowledge
    : normalResetNeeded);
  const canRewind = !isProcessing && !operation;
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
  status = { ...status, pendingManual };
  if (pendingManual && !["processing", "error", "unmarked", "recovery"].includes(status.state)) {
    status = { ...status, state: "blocked", detail: manualEnduranceDetail() };
  }
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
  container.innerHTML = state.entries.size
    ? Array.from(state.entries.values()).map((entry) => renderGMSummaryRow(state, entry)).join("")
    : `<p class="fblqa-progression-empty">${escapeHtml(qaLocalize("StateProgression.NoAssignedActors", "No characters assigned to non-GM players were found."))}</p>`;
}

function bindGMSummaryActions(state) {
  const root = state.root;
  if (!root || root.dataset?.fblqaSummaryBound === "true") return;
  if (root.dataset) root.dataset.fblqaSummaryBound = "true";

  root.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-action]");
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const action = String(button.dataset.action ?? "");
    if (action === "reset-all-current") {
      void resetAllFromGMSummary(state);
      return;
    }
    if (action === "rewind-all") {
      void rewindAllFromGMSummary(state);
      return;
    }

    const actorId = button.closest?.("[data-actor-id]")?.dataset?.actorId;
    if (!actorId) return;
    if (action === "resolve") void resolveActorFromGMSummary(state, actorId);
    else if (action === "open-stat") {
      const sheet = state.entries.get(actorId)?.actor?.sheet;
      if (sheet) {
        sheet._customActiveTab = "conditions";
        sheet.render?.(true);
      }
    } else if (action === "absent") void markActorAbsentFromGMSummary(state, actorId);
    else if (action === "undo-absent") void undoActorAbsentFromGMSummary(state, actorId);
    else if (action === "reset-current") void resetActorFromGMSummary(state, actorId);
    else if (action === "rewind") void rewindActorFromGMSummary(state, actorId);
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
  const context = getCalendariaContext();
  if (!context || context.calendarId !== state.context.calendarId) return;
  if (getCalendarOperation(entry.actor)) {
    await resolveCalendarOperationFromSummary(state, entry.actor, context);
    return;
  }
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
    let approvedContext = context;
    let approvedDays = days;
    let liveContext = null;
    let liveMarker = null;
    let liveDays = 0;

    while (true) {
      if (approvedDays > MAX_AUTOMATIC_CALENDAR_DAYS) {
        ui.notifications?.warn?.(qaLocalize("StateProgression.TooManyDaysWarning", "Calendaria advanced by {days} days. Quick Access will not automatically simulate more than {max} days at once.", {
          days: approvedDays,
          max: MAX_AUTOMATIC_CALENDAR_DAYS
        }));
        return;
      }
      const confirmed = await confirmDangerAction({
        title: qaLocalize("StateProgression.ResolveTitle", "Resolve pending state progression"),
        heading: qaLocalize("StateProgression.ResolveHeading", "Process {days} days for {actor}?", { days: approvedDays, actor: entry.actor.name ?? "" }),
        message: qaLocalize("StateProgression.ResolveMessage", "The missing calendar days will be simulated sequentially using the currently applicable daily actions."),
        warning: qaLocalize("StateProgression.TimeSkipWarning", "This can resolve injuries, wash states, addictions and other daily conditions. Moving the calendar backwards will not undo these changes."),
        confirmLabel: qaLocalize("StateProgression.Resolve", "Resolve"),
        cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
        icon: "fas fa-list-check",
        width: 470
      });
      if (!confirmed) return;

      liveContext = getCalendariaContext();
      if (!liveContext || liveContext.calendarId !== state.context.calendarId) return;
      if (getCalendarOperation(entry.actor)) {
        await resolveCalendarOperationFromSummary(state, entry.actor, liveContext);
        return;
      }
      liveMarker = getActorCalendarMarker(entry.actor);
      const liveStatus = calculateActorCalendarStatus(liveMarker, liveContext);
      liveDays = Math.max(0, Number(liveStatus.days) || 0);
      if (!liveDays) {
        updateGMSummaryStatus(state, actorId, liveStatus.status === "ahead"
          ? summaryStatusForAheadMarker(liveMarker, liveStatus.days)
          : summaryStatusForCurrentMarker(liveMarker, liveContext));
        return;
      }
      if (sameCalendariaDay(liveContext.date, approvedContext.date) && liveDays === approvedDays) break;

      updateGMSummaryStatus(state, actorId, {
        state: entry.primaryUser?.active ? "pending" : "offline",
        days: liveDays,
        detail: pendingChangedDetail()
      });
      if (liveDays === 1) {
        return resolveActorFromGMSummary(state, actorId);
      }
      approvedContext = liveContext;
      approvedDays = liveDays;
    }

    const releaseProcessing = beginSummaryOperation(actorId);
    updateGMSummaryStatus(state, actorId, { state: "processing", days: liveDays });
    try {
      const result = await processActorAutomaticDays(entry.actor, liveMarker.date, liveContext, liveDays, {
        approvedMarker: liveMarker,
        maxDays: liveDays > DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT ? liveDays : DEFAULT_AUTOMATIC_CALENDAR_DAY_LIMIT
      });
      updateGMSummaryStatus(state, actorId, result.failedActions
        ? { state: "error", days: result.limitedDays, result, detail: qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: result.failedActions }) }
        : result.limitedDays > 0
          ? { state: "blocked", days: result.limitedDays, result, detail: qaLocalize("StateProgression.AutomaticDaysLimited", "Processed {processed} calendar days; {remaining} days remain pending.", { processed: result.processedDays, remaining: result.limitedDays }) }
          : { state: "done", days: 0, result, detail: qaLocalize("StateProgression.ProcessedDays", "Processed {days} calendar days.", { days: result.processedDays }) });
      await sendPlayerResults(entry, liveContext, result);
    } catch (error) {
      if (error?.code === "stale-calendar-day") {
        const latest = getCalendariaContext();
        if (latest?.calendarId === liveContext.calendarId) {
          const currentMarker = getActorCalendarMarker(entry.actor);
          const calendarStatus = calculateActorCalendarStatus(currentMarker, latest);
          updateGMSummaryStatus(state, actorId, calendarOperationSummaryStatus(entry.actor, latest)
            ?? (calendarStatus.status === "ahead" ? summaryStatusForAheadMarker(currentMarker, calendarStatus.days)
              : calendarStatus.days > 0 ? { state: entry.primaryUser?.active ? "pending" : "offline", days: calendarStatus.days, detail: pendingChangedDetail() }
                : summaryStatusForCurrentMarker(currentMarker, latest)));
        } else {
          updateGMSummaryStatus(state, actorId, { state: "error", days: 0, detail: pendingChangedDetail() });
        }
        ui.notifications?.warn?.(pendingChangedDetail());
        return;
      }
      console.error(`${MODULE_ID} | GM multi-day resolve failed`, error);
      ui.notifications?.error?.(qaLocalize("StateProgression.ApplyFailed", "Could not apply Calendaria state progression."));
      updateGMSummaryStatus(state, actorId, calendarOperationSummaryStatus(entry.actor, liveContext) ?? {
        state: "error",
        days: pendingDaysForActor(entry.actor, liveContext),
        detail: qaLocalize("StateProgression.ApplyFailed", "Could not apply Calendaria state progression.")
      });
    } finally {
      releaseProcessing();
    }
    return;
  }

  const result = await openNewDayDialog(null, entry.actor, {
    source: "calendaria-gm",
    targetDate: context.date,
    dayKey: addictionCalendarDayKey(context.calendarId, context.date),
    applyHandler: async ({ selectedIds, selectedPreconditions }) => handleCalendariaApplyRequest({
      actorId: entry.actor.id,
      targetDate: context.date,
      calendarId: context.calendarId,
      selectedIds,
      selectedPreconditions
    }, {
      requestUser: game.user,
      requesterId: game.user.id,
      activeGM: game.user,
      isRemote: false
    })
  });
  if (result?.calendarResult) await sendPlayerResults(entry, context, result.calendarResult);
}

async function resetActorFromGMSummary(state, actorId) {
  if (!isActiveQuickAccessGM()) return;
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = getCalendariaContext();
  if (!context) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerUnavailable", "Calendaria day management is unavailable."));
    return;
  }
  const operation = clonePlainJson(getCalendarOperation(entry.actor));
  if (operation) {
    if (calendarOperationWindowMatches(operation, getActorCalendarMarker(entry.actor), context)) {
      await resolveCalendarOperationFromSummary(state, entry.actor, context);
      return;
    }
    const confirmed = await confirmDangerAction({
      title: qaLocalize("StateProgression.ResetInterruptedTitle", "Close unfinished calendar day?"),
      heading: qaLocalize("StateProgression.ResetInterruptedHeading", "Set {actor}’s marker to {date}?", {
        actor: entry.actor.name ?? "", date: formatCalendariaDate(context.date)
      }),
      warning: qaLocalize("StateProgression.ResetInterruptedWarning", "Check and correct the character’s states first. This closes the unfinished day and skips all pending days without applying or undoing any actions."),
      confirmLabel: qaLocalize("StateProgression.ResetCurrent", "Set to current date"),
      cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
      icon: "fas fa-calendar-check"
    });
    if (!confirmed || !isActiveQuickAccessGM() || summaryKey(getCalendariaContext() ?? {}) !== summaryKey(context)) return;
  }

  try {
    await resetCalendarMarker(entry.actor, context, { approvedOperation: operation, requireCurrentDay: true });
    updateGMSummaryStatus(state, actorId, {
      state: "done",
      days: 0,
      skippedDays: 0,
      undoAvailable: false,
      result: null,
      detail: qaLocalize("StateProgression.ResetCurrentDone", "Marker reset to the current date ({date}).", {
        date: formatCalendariaDate(context.date)
      })
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not reset Calendaria marker`, error);
    ui.notifications?.error?.(qaLocalize("StateProgression.ResetCurrentFailed", "Could not reset the marker to the current date."));
  }
}

async function rewindActorFromGMSummary(state, actorId) {
  if (!isActiveQuickAccessGM()) return;
  const entry = state.entries.get(actorId);
  if (!entry) return;
  const context = getCalendariaContext();
  if (!context) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerUnavailable", "Calendaria day management is unavailable."));
    return;
  }
  const days = await promptRewindDays({ actorName: entry.actor.name ?? "" });
  if (!days) return;
  const liveContext = getCalendariaContext();
  if (!liveContext || liveContext.calendarId !== context.calendarId) return;
  try {
    const rewound = await rewindActorCalendarMarker(entry.actor, days, liveContext, liveContext.api, { requireCurrentDay: true });
    const pending = calculateActorCalendarStatus(getActorCalendarMarker(entry.actor), liveContext);
    updateGMSummaryStatus(state, actorId, {
      state: entry.primaryUser?.active ? "pending" : "offline",
      days: Math.max(0, Number(pending.days) || 0),
      skippedDays: 0,
      undoAvailable: false,
      result: null,
      detail: qaLocalize("StateProgression.RewindDone", "Marker rewound by {days} day(s) (to {date}). Days are pending again.", {
        days: rewound.days,
        date: formatCalendariaDate(rewound.marker?.date)
      })
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not rewind Calendaria marker`, error);
    ui.notifications?.error?.(rewindFailureDetail(error));
  }
}

async function resetAllFromGMSummary(state) {
  if (!isActiveQuickAccessGM()) return;
  const context = getCalendariaContext();
  if (!context) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerUnavailable", "Calendaria day management is unavailable."));
    return;
  }
  const dateLabel = formatCalendariaDate(context.date);
  const confirmed = await confirmDangerAction({
    title: qaLocalize("StateProgression.ResetAllConfirmTitle", "Reset all Calendaria markers?"),
    heading: qaLocalize("StateProgression.ResetAllConfirmHeading", "Set the current date ({date}) for all player characters?", { date: dateLabel }),
    message: qaLocalize("StateProgression.ResetAllConfirmMessage", "All assigned player characters will have their processed-day marker set to the current Calendaria date. Character sheet states will not be changed."),
    warning: qaLocalize("StateProgression.ResetAllConfirmWarning", "Pending past days will be marked caught up. Characters with unfinished days are skipped and must be reviewed individually."),
    confirmLabel: qaLocalize("StateProgression.ResetAllCurrent", "Reset all to current date"),
    cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
    icon: "fas fa-calendar-check",
    width: 480
  });
  if (!confirmed) return;

  const liveContext = getCalendariaContext();
  if (!liveContext || summaryKey(liveContext) !== summaryKey(context)) {
    ui.notifications?.warn?.(pendingChangedDetail());
    return;
  }

  try {
    const { count, succeededActorIds, skippedActorIds, failedActorIds } = await resetAllCalendarMarkersToCurrent(context, { requireCurrentDay: true });
    for (const actorId of succeededActorIds) {
      if (!state.entries.has(actorId)) continue;
      updateGMSummaryStatus(state, actorId, {
        state: "done",
        days: 0,
        skippedDays: 0,
        undoAvailable: false,
        result: null,
        detail: qaLocalize("StateProgression.ResetCurrentDone", "Marker reset to the current date ({date}).", { date: dateLabel })
      });
    }
    for (const actorId of [...skippedActorIds, ...failedActorIds]) {
      const entry = state.entries.get(actorId);
      if (!entry) continue;
      updateGMSummaryStatus(state, actorId, calendarOperationSummaryStatus(entry.actor, context) ?? {
        state: "error", days: pendingDaysForActor(entry.actor, context), result: null,
        detail: qaLocalize("StateProgression.ResetCurrentFailed", "Could not reset the marker to the current date.")
      });
    }
    if (failedActorIds.length || skippedActorIds.length) {
      ui.notifications?.warn?.(qaLocalize("StateProgression.ResetAllPartial",
        "Markers reset to {date}: {count}; skipped: {skipped}; failed: {failed}. Check these characters before retrying.", {
          date: dateLabel, count, skipped: skippedActorIds.length, failed: failedActorIds.length
        }));
    } else {
      ui.notifications?.info?.(qaLocalize("StateProgression.ResetAllDone", "Calendaria markers reset to {date} for {count} characters.", { date: dateLabel, count }));
    }
  } catch (error) {
    console.error(`${MODULE_ID} | could not reset all Calendaria markers`, error);
    ui.notifications?.error?.(qaLocalize("StateProgression.ResetCurrentFailed", "Could not reset the marker to the current date."));
  }
}

async function rewindAllFromGMSummary(state) {
  if (!isActiveQuickAccessGM()) return;
  const context = getCalendariaContext();
  if (!context) {
    ui.notifications?.warn?.(qaLocalize("StateProgression.ManagerUnavailable", "Calendaria day management is unavailable."));
    return;
  }
  const days = await promptRewindDays({ actorName: null });
  if (!days) return;
  const liveContext = getCalendariaContext();
  if (!liveContext || liveContext.calendarId !== context.calendarId) return;

  try {
    const outcome = await rewindAllCalendarMarkers(days, liveContext, liveContext.api, { requireCurrentDay: true });
    for (const item of outcome.succeeded) {
      const entry = state.entries.get(item.actorId);
      if (!entry) continue;
      const marker = getActorCalendarMarker(entry.actor);
      const pending = calculateActorCalendarStatus(marker, liveContext);
      updateGMSummaryStatus(state, item.actorId, {
        state: entry.primaryUser?.active ? "pending" : "offline",
        days: Math.max(0, Number(pending.days) || 0),
        skippedDays: 0,
        undoAvailable: false,
        result: null,
        detail: qaLocalize("StateProgression.RewindDone", "Marker rewound by {days} day(s) (to {date}). Days are pending again.", {
          days,
          date: formatCalendariaDate(marker?.date)
        })
      });
    }
    for (const item of outcome.failed) {
      const entry = state.entries.get(item.actorId);
      if (!entry) continue;
      updateGMSummaryStatus(state, item.actorId, calendarOperationSummaryStatus(entry.actor, liveContext) ?? {
        state: "error",
        days: pendingDaysForActor(entry.actor, liveContext),
        detail: rewindFailureDetail(item.error)
      });
    }
    if (outcome.failed.length) {
      ui.notifications?.warn?.(qaLocalize(
        "StateProgression.RewindAllPartial",
        "Markers rewound for {succeeded} characters. Failed: {failed}. Review unfinished days before retrying affected characters individually.",
        { succeeded: outcome.count, failed: outcome.failed.length }
      ));
    } else {
      ui.notifications?.info?.(qaLocalize("StateProgression.RewindAllDone", "Markers rewound by {days} day(s) for {count} characters.", {
        days,
        count: outcome.count
      }));
    }
  } catch (error) {
    console.error(`${MODULE_ID} | could not rewind all Calendaria markers`, error);
    ui.notifications?.error?.(qaLocalize("StateProgression.RewindFailed", "Could not rewind Calendaria processed days."));
  }
}

function rewindFailureDetail(error) {
  return error?.code === "rewind-backlog-limit" ? error.message
    : qaLocalize("StateProgression.RewindFailed", "Could not rewind Calendaria processed days.");
}

function promptRewindDays({ actorName = null, defaultDays = 1 } = {}) {
  if (!hasFoundryDialogApi()) return Promise.resolve(null);
  const heading = actorName
    ? qaLocalize("StateProgression.RewindHeading", "Rewind Calendaria marker for {actor}", { actor: actorName })
    : qaLocalize("StateProgression.RewindAllHeading", "Rewind Calendaria marker for all player characters");
  const content = `
    <form class="fblqa-progression-rewind-form">
      <p><strong>${escapeHtml(heading)}</strong></p>
      <label class="fblqa-rest-field">
        <span>${escapeHtml(qaLocalize("StateProgression.RewindDaysLabel", "Days to rewind"))}</span>
        <input type="number" name="rewindDays" min="1" max="${MAX_AUTOMATIC_CALENDAR_DAYS}" step="1" value="${Math.max(1, Math.floor(Number(defaultDays) || 1))}">
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
            const raw = Number(form?.querySelector?.('input[name="rewindDays"]')?.value);
            const safeDays = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_AUTOMATIC_CALENDAR_DAYS, Math.floor(raw))) : 1;
            finish(safeDays);
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

export async function resetActorCalendarMarkerToCurrent(actor, context = getCalendariaContext()) {
  return resetCalendarMarker(actor, context);
}

function resetCalendarMarker(actor, context, { approvedOperation = null, requireCurrentDay = false } = {}) {
  assertCalendarManagerAuthority();
  const calendarId = String(context?.calendarId ?? "").trim();
  const normalizedDate = normalizeCalendariaDate(context?.date);
  if (!actor || !calendarId || !normalizedDate) {
    throw progressionError("calendaria-unavailable", "Calendaria context is unavailable");
  }
  return enqueueStateProgressionOperation(actor, async () => {
    assertCalendarManagerAuthority();
    if (requireCurrentDay) assertApprovedCalendarDay(context);
    const operation = getCalendarOperation(actor);
    if (!plainValuesEqual(operation, approvedOperation)) throw calendarRecoveryError(operation ?? approvedOperation);
    const previousMarker = getActorCalendarMarker(actor);
    const nextContext = { calendarId, date: normalizedDate };
    const written = await writeActorCalendarMarker(actor, nextContext, {}, {}, { finish: operation, discard: true });
    if (!written) {
      throw progressionError("write-not-persisted", "Could not persist Calendaria marker");
    }
    return {
      changed: true,
      previousMarker,
      marker: getActorCalendarMarker(actor) ?? nextContext
    };
  });
}

export async function rewindActorCalendarMarker(actor, days = 1, context = getCalendariaContext(), api = context?.api ?? getCalendariaApi(), options = {}) {
  assertCalendarManagerAuthority();
  const request = normalizeRewindRequest(days, context, api, options);
  if (!actor) throw progressionError("calendaria-unavailable", "Calendaria context is unavailable");
  const outcome = await attemptCalendarRewind(actor, request, { explicitTargetDate: options?.targetDate });
  if (outcome.error) throw outcome.error;
  return outcome;
}

function normalizeRewindRequest(days, context, api, { requireCurrentDay = false } = {}) {
  const calendarId = String(context?.calendarId ?? "").trim();
  const normalizedCurrentDate = normalizeCalendariaDate(context?.date);
  if (!calendarId || !normalizedCurrentDate || !api?.addDays || !api?.daysBetween) {
    throw progressionError("calendaria-unavailable", "Calendaria context is unavailable");
  }
  const safeDays = Math.floor(Number(days));
  if (!Number.isInteger(safeDays) || safeDays < 1 || safeDays > MAX_AUTOMATIC_CALENDAR_DAYS) {
    throw new RangeError(`Rewind days must be an integer between 1 and ${MAX_AUTOMATIC_CALENDAR_DAYS}`);
  }
  return { context: { ...context, calendarId, date: normalizedCurrentDate }, api, days: safeDays, requireCurrentDay };
}

function attemptCalendarRewind(actor, { context, api, days, requireCurrentDay }, { explicitTargetDate, retryTarget } = {}) {
  return enqueueStateProgressionOperation(actor, async () => {
    const previousMarker = getActorCalendarMarker(actor);
    let targetDate = null;
    let retry = null;
    try {
      assertCalendarManagerAuthority();
      if (requireCurrentDay) assertApprovedCalendarDay(context);
      if (retryTarget !== undefined) {
        targetDate = normalizeCalendariaDate(retryTarget?.date);
        if (!targetDate || retryTarget.calendarId !== context.calendarId || !Object.hasOwn(retryTarget, "previousMarker")) {
          throw progressionError("invalid-rewind-retry", "Retry requires a saved target for this calendar.");
        }
        if (previousMarker?.calendarId === context.calendarId && sameCalendariaDay(previousMarker.date, targetDate)) {
          return { changed: false, days, previousMarker, targetDate, marker: previousMarker };
        }
        if (!plainValuesEqual(previousMarker, retryTarget.previousMarker)) {
          throw progressionError("stale-calendar-marker", "The calendar marker changed after the first rewind attempt.");
        }
      }

      const operation = getCalendarOperation(actor);
      if (operation) throw calendarRecoveryError(operation);
      if (retryTarget === undefined) {
        if (explicitTargetDate != null) {
          targetDate = normalizeCalendariaDate(explicitTargetDate);
        } else {
          const status = calculateActorCalendarStatus(previousMarker, context, api);
          const usePrevious = previousMarker?.calendarId === context.calendarId && !["ahead", "unavailable"].includes(status.status);
          const baseDate = usePrevious ? previousMarker.date : context.date;
          targetDate = normalizeCalendariaDate(api.addDays(baseDate, -days));
        }
      }
      if (!targetDate) throw progressionError("invalid-rewind-date", "Could not compute rewound Calendaria date");
      const target = { calendarId: context.calendarId, date: targetDate };
      const pending = calculateActorCalendarStatus(target, context, api);
      if (pending.days == null || pending.days < 0) {
        throw progressionError("invalid-rewind-date", "The rewound marker must be on or before the current calendar date.");
      }
      if (pending.days > MAX_AUTOMATIC_CALENDAR_DAYS) {
        throw progressionError("rewind-backlog-limit", qaLocalize("StateProgression.RewindBacklogLimit",
          "This rewind would leave {days} pending days. Resolve some of them or choose a shorter rewind to stay within {max} days.",
          { days: pending.days, max: MAX_AUTOMATIC_CALENDAR_DAYS }));
      }
      retry = { ...target, previousMarker };
      if (!await setActorCalendarMarker(actor, target)) {
        throw progressionError("write-not-persisted", "Could not persist Calendaria marker");
      }
      return { changed: true, days, previousMarker, targetDate, marker: getActorCalendarMarker(actor) ?? target };
    } catch (error) {
      return { previousMarker, targetDate, error, retry };
    }
  });
}

export async function resetAllCalendarMarkersToCurrent(context = getCalendariaContext(), { requireCurrentDay = false } = {}) {
  assertCalendarManagerAuthority();
  const calendarId = String(context?.calendarId ?? "").trim();
  const normalizedDate = normalizeCalendariaDate(context?.date);
  if (!calendarId || !normalizedDate) {
    throw progressionError("calendaria-unavailable", "Calendaria context is unavailable");
  }
  const normalizedContext = { ...context, calendarId, date: normalizedDate };
  return {
    ...await collectMarkerWriteOutcomes(actor => resetCalendarMarker(actor, normalizedContext, { requireCurrentDay })),
    date: normalizedDate
  };
}

export async function rewindAllCalendarMarkers(days = 1, context = getCalendariaContext(), api = context?.api ?? getCalendariaApi(), options = {}) {
  assertCalendarManagerAuthority();
  const request = normalizeRewindRequest(days, context, api, options);
  const filterIds = Array.isArray(options?.actorIds) ? new Set(options.actorIds.map(String)) : null;
  const explicitTargets = options?.targetDates && typeof options.targetDates === "object" ? options.targetDates : null;
  const entries = getAssignedPlayerActors().filter(({ actor }) => !filterIds || filterIds.has(String(actor?.id ?? "")));

  const results = [];
  const succeeded = [];
  const failed = [];
  const targetDates = new Map();

  for (const { actor } of entries) {
    const actorId = String(actor?.id ?? "");
    if (explicitTargets && !Object.hasOwn(explicitTargets, actorId)) continue;
    const retryTarget = explicitTargets ? explicitTargets[actorId] ?? null : undefined;
    const { changed, previousMarker, targetDate, marker, error, retry } = await attemptCalendarRewind(actor, request, { retryTarget });
    const item = { actorId, actorName: actor.name ?? "", ok: !error, previousMarker, targetDate, ...(error ? { error } : { changed, marker }) };
    results.push(item);
    if (error) {
      console.error(`${MODULE_ID} | bulk rewind failed for ${item.actorName || actorId}`, error);
      failed.push(item);
      if (retry) targetDates.set(actorId, retry);
    } else succeeded.push(item);
  }

  return {
    ok: failed.length === 0,
    count: succeeded.length,
    days: request.days,
    succeeded,
    failed,
    results,
    failedActorIds: failed.map((item) => item.actorId),
    targetDates: Object.fromEntries(targetDates)
  };
}

async function baselinePlayerActors(context, { force = false } = {}) {
  return collectMarkerWriteOutcomes(actor => ensureActorCalendarBaseline(actor, context, { force }));
}

async function collectMarkerWriteOutcomes(write) {
  const succeededActorIds = [];
  const skippedActorIds = [];
  const failedActorIds = [];
  for (const { actor } of getAssignedPlayerActors()) {
    try {
      const written = await write(actor);
      (written ? succeededActorIds : skippedActorIds).push(actor.id);
    } catch (error) {
      if (error?.code === "calendar-reconciliation-required") skippedActorIds.push(actor.id);
      else {
        failedActorIds.push(actor.id);
        console.error(`${MODULE_ID} | failed to write Calendaria marker for ${actor.name ?? actor.id}`, error);
      }
    }
  }
  return { count: succeededActorIds.length, succeededActorIds, skippedActorIds, failedActorIds };
}

async function ensureMissingPlayerBaselines(context) {
  return baselinePlayerActors(context, { force: false });
}

function ensureActorCalendarBaseline(actor, context, { force = false, approvedMarker } = {}) {
  return enqueueStateProgressionOperation(actor, async () => {
    assertCalendarManagerAuthority();
    if (approvedMarker !== undefined) assertCalendariaMode();
    assertApprovedCalendarDay(context);
    if (getCalendarOperation(actor)) return false;
    const marker = getActorCalendarMarker(actor);
    if (approvedMarker !== undefined && !plainValuesEqual(marker, approvedMarker)) {
      throw progressionError("stale-calendar-day", pendingChangedDetail());
    }
    if (!force && marker?.calendarId === context.calendarId) return false;
    if (!await setActorCalendarMarker(actor, context)) {
      throw progressionError("write-not-persisted", "Could not persist Calendaria baseline marker");
    }
    return true;
  });
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
  return writeActorCalendarMarker(actor, context, metadata, documentOptions);
}

async function writeActorCalendarMarker(actor, context, metadata, documentOptions, { finish = null, discard = false } = {}) {
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

  const operation = getCalendarOperation(actor);
  if (operation || finish) {
    if (!finish || !plainValuesEqual(operation, finish)) throw calendarRecoveryError(operation ?? finish);
    const update = {
      [flagReplaceUpdatePath(MODULE_ID, FLAG_STATE_PROGRESSION_CALENDAR)]: marker,
      [`flags.${MODULE_ID}.${FLAG_STATE_PROGRESSION_OPERATION}`]: null
    };
    const failures = !discard && finish.failures?.length
      ? calendarFailureHistory(actor, calendarId, finish.date, finish.failures)
      : null;
    if (failures) update[`flags.${MODULE_ID}.${FLAG_STATE_PROGRESSION_FAILURES}`] = failures;
    await actor.update(clonePlainJson(update), documentOptions);
    if (getCalendarOperation(actor)
      || !plainValuesEqual(readDocumentFlag(actor, MODULE_ID, FLAG_STATE_PROGRESSION_CALENDAR), marker)
      || (failures && !plainValuesEqual(readDocumentFlag(actor, MODULE_ID, FLAG_STATE_PROGRESSION_FAILURES), failures))) {
      throw progressionError("write-not-persisted", "Could not persist Calendaria marker and operation together");
    }
    return true;
  }

  return setDocumentFlagVerified(
    actor,
    MODULE_ID,
    FLAG_STATE_PROGRESSION_CALENDAR,
    marker,
    documentOptions,
    { replace: true }
  );
}

function getCalendarOperation(actor) {
  return readDocumentFlag(actor, MODULE_ID, FLAG_STATE_PROGRESSION_OPERATION) ?? null;
}

function calendarOperationWindowMatches(operation, marker, context, api = context?.api ?? getCalendariaApi()) {
  if (!context || !operation
    || operation.calendarId !== context.calendarId || marker?.calendarId !== context.calendarId
    || !sameCalendariaDay(marker.date, operation.previousDate)
    || !normalizeCalendariaDate(operation.date) || !normalizeCalendariaDate(operation.through)) return false;
  try {
    const firstDay = normalizeCalendariaDate(api.addDays(marker.date, 1));
    return sameCalendariaDay(firstDay, operation.date)
      && api.daysBetween(operation.date, operation.through) >= 0
      && api.daysBetween(operation.through, context.date) >= 0;
  } catch (_error) {
    return false;
  }
}

function canFinishCalendarOperation(operation, marker, context, api) {
  return operation?.phase === "applied" && Array.isArray(operation.failures)
    && calendarOperationWindowMatches(operation, marker, context, api);
}

function calendarRecoveryError(operation) {
  return progressionError("calendar-reconciliation-required", qaLocalize(
    "StateProgression.InterruptedDay",
    "Day processing stopped on {date}. Check the character’s states, then use Manage Calendaria days to review the interrupted operation. Nothing was reapplied automatically.",
    { date: formatCalendariaDate(operation?.date) }
  ));
}

function calendarOperationSummaryStatus(actor, context) {
  const operation = getCalendarOperation(actor);
  if (!operation) return null;
  const marker = getActorCalendarMarker(actor);
  const canFinish = canFinishCalendarOperation(operation, marker, context);
  const canAcknowledge = operation.phase === "applying" && calendarOperationWindowMatches(operation, marker, context);
  return {
    state: canFinish ? "unmarked" : "recovery",
    canAcknowledge,
    days: pendingDaysForActor(actor, context),
    detail: canFinish ? qaLocalize("StateProgression.FinishMarker", "Actions for {date} are already applied. Resolve saves the marker without repeating them.", {
      date: formatCalendariaDate(operation.date)
    }) : calendarRecoveryError(operation).message
  };
}

function warnIfCalendarRecoveryNeeded() {
  if (!getAssignedPlayerActors().some(({ actor }) => getCalendarOperation(actor))) return;
  ui.notifications?.warn?.(qaLocalize("StateProgression.ReviewUnfinishedDays", "Some calendar days are unfinished. Open Manage Calendaria days to review them."));
}

async function resolveCalendarOperationFromSummary(state, actor, context) {
  const approved = clonePlainJson(getCalendarOperation(actor));
  const status = calendarOperationSummaryStatus(actor, context);
  if (status?.state !== "unmarked" && !status?.canAcknowledge) return;
  if (status.canAcknowledge) {
    const confirmed = await confirmDangerAction({
      title: qaLocalize("StateProgression.AcknowledgeDayTitle", "Close interrupted calendar day?"),
      heading: qaLocalize("StateProgression.ResetInterruptedHeading", "Set {actor}’s marker to {date}?", {
        actor: actor.name ?? "", date: formatCalendariaDate(approved.through)
      }),
      warning: qaLocalize("StateProgression.AcknowledgeDayWarning", "Check and correct the character’s states first. No daily actions will be repeated or undone; later days remain pending."),
      confirmLabel: qaLocalize("StateProgression.Resolve", "Resolve"),
      cancelLabel: qaLocalize("Common.Cancel", "Cancel"),
      icon: "fas fa-list-check"
    });
    if (!confirmed) return;
  }
  try {
    const operation = await enqueueStateProgressionOperation(actor, async () => {
      assertCalendarManagerAuthority();
      const live = getCalendariaContext();
      const saved = getCalendarOperation(actor);
      if (!saved) return null;
      if (!plainValuesEqual(saved, approved) || !calendarOperationWindowMatches(saved, getActorCalendarMarker(actor), live)) {
        throw progressionError("stale-calendar-day", pendingChangedDetail());
      }
      if (status.canAcknowledge) {
        await writeActorCalendarMarker(actor, { ...live, date: saved.through }, {}, {}, { finish: saved });
      } else {
        await finishCalendarOperation(actor, live, saved);
      }
      return saved;
    });
    const marker = getActorCalendarMarker(actor);
    const days = pendingDaysForActor(actor, context);
    const detail = operation?.failures?.length
      ? qaLocalize("StateProgression.CompletedWithErrors", "Processed with {count} failed daily actions.", { count: operation.failures.length })
      : operation ? recoveredMarkerDetail(operation.through) : "";
    updateGMSummaryStatus(state, actor.id, {
      ...summaryStatusForCurrentMarker(marker, context),
      canAcknowledge: false,
      detail,
      ...(days ? { state: "pending", days } : {}),
      ...(operation?.failures?.length ? { state: "error" } : {})
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not finish Calendaria marker`, error);
    ui.notifications?.error?.(String(error.message));
    const status = calendarOperationSummaryStatus(actor, context);
    if (status) updateGMSummaryStatus(state, actor.id, status);
  }
}

async function finishCalendarOperation(actor, context, operation, documentOptions = {}) {
  if (!canFinishCalendarOperation(operation, getActorCalendarMarker(actor), context)) throw calendarRecoveryError(operation);
  await writeActorCalendarMarker(actor, { ...context, date: operation.through }, {}, documentOptions, { finish: operation });
}

async function applyCalendarDay(actor, context, previousDate, date, through, plan, selectedIds, documentOptions = {}) {
  assertCalendarApplyContext(context);
  const existing = getCalendarOperation(actor);
  if (existing) throw calendarRecoveryError(existing);
  const marker = getActorCalendarMarker(actor);
  if (marker?.calendarId !== context.calendarId || !sameCalendariaDay(marker.date, previousDate)) {
    throw progressionError("stale-calendar-day", "The character calendar marker changed before processing");
  }

  const operation = { id: makeSocketRequestId(), phase: "applying", calendarId: context.calendarId, previousDate, date, through };
  const writeOperation = value => setDocumentFlagVerified(actor, MODULE_ID, FLAG_STATE_PROGRESSION_OPERATION,
    value, { render: false }, { replace: true });
  const discardUnstarted = async () => {
    if (!plainValuesEqual(getCalendarOperation(actor), operation)) throw calendarRecoveryError(getCalendarOperation(actor));
    await clearDocumentFlagNullVerified(actor, MODULE_ID, FLAG_STATE_PROGRESSION_OPERATION, { render: false });
  };
  const beforeApply = () => {
    try {
      assertCalendarApplyContext(context);
      if (!plainValuesEqual(getCalendarOperation(actor), operation) || !plainValuesEqual(getActorCalendarMarker(actor), marker)) {
        throw progressionError("stale-calendar-day", pendingChangedDetail());
      }
    } catch (error) {
      return discardUnstarted().then(() => { throw error; });
    }
  };
  await writeOperation(operation);
  const applied = await applyNewDayPlan(actor, plan, selectedIds, { ...calendarApplyOptions(), beforeApply }).catch(async error => {
    if (error?.beforeNewDayWrites) await discardUnstarted();
    throw error;
  });
  if (applied.stalePlan) {
    await discardUnstarted();
    throw progressionError("stale-plan", qaLocalize("NewDay.StalePlan", "Данные изменились. Обновите предварительный просмотр."));
  }
  const finished = { ...operation, phase: "applied", failures: calendarFailureIds(applied.failed) };
  await writeOperation(finished);
  await finishCalendarOperation(actor, context, finished, documentOptions);
  return applied;
}

export async function markActorCalendariaAbsent(actor, context, api = context?.api ?? getCalendariaApi()) {
  return enqueueStateProgressionOperation(actor, () => markActorCalendariaAbsentUnlocked(actor, context, api));
}

async function markActorCalendariaAbsentUnlocked(actor, context, api) {
  const operation = getCalendarOperation(actor);
  if (operation) throw calendarRecoveryError(operation);
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
  const operation = getCalendarOperation(actor);
  if (operation) throw calendarRecoveryError(operation);
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
  if (!aheadActors.length) {
    lastAheadWarningKey = "";
    return 0;
  }
  const warningKey = JSON.stringify([context.calendarId, aheadActors.map(({ actor }) => actor.id).sort()]);
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
  game.socket.on(SOCKET_CHANNEL, (message) => {
    if (message?.type === PLAYER_RESULT_TYPE) void handlePlayerResultMessage(message);
  });
  resultSocketRegistered = true;
  return true;
}

async function sendPlayerResults(entry, context, result) {
  const currentEntry = getAssignedPlayerActors().find(({ actor }) => actor.id === entry?.actor?.id);
  const activeUsers = currentEntry?.users.filter(user => user.active) ?? [];
  for (const user of activeUsers) {
    await sendPlayerResult(user, currentEntry.actor, context, result);
  }
}

function isAssignedActivePlayer(userId, actorId) {
  const user = findGameUser(userId);
  return Boolean(user?.active && !user.isGM && resolveUserCharacter(user, game.actors)?.id === actorId);
}

async function sendPlayerResult(user, actor, context, result) {
  if (!isActiveQuickAccessGM() || !isAssignedActivePlayer(user.id, actor.id) || !game.socket?.emit) return false;
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
    if (!isActiveQuickAccessGM() || !isAssignedActivePlayer(user.id, actor.id)) return false;
    game.socket.emit(SOCKET_CHANNEL, message);
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | could not send Calendaria progression result to player`, error);
    return false;
  }
}

async function handlePlayerResultMessage(message) {
  if (!isValidPlayerResultMessage(message) || message.recipientId !== game.user?.id
    || !isAssignedActivePlayer(message.recipientId, message.actorId)) return;
  const gm = findGameUser(message.activeGMId);
  if (!gm?.isGM || !gm.active) return;

  const proof = await verifySocketProofWithRetry(gm, PLAYER_RESULT_PROOF_KIND, message.packetId, message, {
    ttlMs: RESULT_PROOF_TTL_MS
  });
  if (!proof.ok || message.recipientId !== game.user?.id || !isAssignedActivePlayer(message.recipientId, message.actorId)) return;
  if (!consumeSocketProof(gm.id, PLAYER_RESULT_PROOF_KIND, message.packetId)) return;

  const actor = resolveUserCharacter(game.user, game.actors);
  if (actor?.id !== message.actorId) return;
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
      ? `<ul>${entries.map((entry) => `<li class="${entry.pending ? "is-pending" : entry.ok ? "is-ok" : "is-failed"}"><strong>${escapeHtml(entry.itemName ?? "")}</strong><span>${escapeHtml(entry.detail ?? "")}</span></li>`).join("")}</ul>`
      : `<p>${escapeHtml(qaLocalize("StateProgression.NoStateChanges", "No selected state changes were needed."))}</p>`;
    return `
      <section class="fblqa-progression-result-day">
        <h3>${escapeHtml(formatCalendariaDate(day?.date))}</h3>
        ${list}
      </section>`;
  }).join("");
  const recovered = normalizeCalendariaDate(result.recoveredMarkerDate);
  const recoveredNote = recovered ? `<p>${escapeHtml(recoveredMarkerDetail(recovered))}</p>` : "";

  return `
    <div class="fblqa-progression-result">
      <div class="fblqa-progression-result-intro">
        <strong>${escapeHtml(qaLocalize("StateProgression.PlayerResultHeading", "State progression"))}</strong>
        <span>${escapeHtml(qaLocalize("StateProgression.PlayerResultHint", "These changes were applied without posting individual messages to chat."))}</span>
      </div>
      ${recoveredNote}${rows || (recovered ? "" : `<p>${escapeHtml(qaLocalize("StateProgression.NoStateChanges", "No selected state changes were needed."))}</p>`)}
      ${result.pendingManual ? `<p class="fblqa-rest-note">${escapeHtml(manualEnduranceDetail())}</p>` : ""}
    </div>`;
}

function recoveredMarkerDetail(date) {
  return qaLocalize("StateProgression.MarkerRecovered", "Saved the marker through {date} for the previously processed day.", {
    date: formatCalendariaDate(date)
  });
}

function manualEnduranceDetail() {
  return qaLocalize("StateProgression.AddictionPending", "Manual addiction Endurance is required. Record Success or Failure in STAT before processing the next day.");
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

function assertCalendariaMode() {
  if (!usesCalendariaStateProgression()) throw progressionError("wrong-progression-mode", "Calendaria state progression is not enabled");
}

function assertCalendariaModeAvailable() {
  assertCalendariaMode();
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
    ahead: "Marker ahead",
    unmarked: "Marker not saved",
    recovery: "Review required"
  }[state] ?? state);
}

function progressionStatusDetail(status) {
  const days = Math.max(0, Number(status?.days) || 0);
  if (!days) return "";
  return qaLocalize("StateProgression.PendingDays", "Pending days: {days}", { days });
}

function isActiveQuickAccessGM() {
  const gm = getActiveGM();
  return Boolean(globalThis.game?.user?.isGM && gm?.id === game.user.id);
}

function assertCalendarManagerAuthority() {
  if (!isActiveQuickAccessGM()) {
    throw progressionError("active-gm-required", qaLocalize("StateProgression.ManagerGmOnly", "Only the active GM can manage Calendaria processed days."));
  }
}

function pendingChangedDetail() {
  return qaLocalize("StateProgression.PendingChanged", "The calendar date or pending days changed while confirming; please confirm again.");
}

function isCurrentCalendarDay(context) {
  const current = getCalendariaContext();
  return Boolean(current && summaryKey(current) === summaryKey(context));
}

function assertApprovedCalendarDay(context) {
  if (!isCurrentCalendarDay(context)) {
    throw progressionError("stale-calendar-day", pendingChangedDetail());
  }
}

function assertCalendarApplyContext(context) {
  assertCalendarManagerAuthority();
  assertCalendariaMode();
  assertApprovedCalendarDay(context);
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
