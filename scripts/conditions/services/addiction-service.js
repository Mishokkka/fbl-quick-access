import { MODULE_ID, FLAGS } from "../constants.js";
import { createChatMessage, escapeHTML, localize, rollToMessage } from "../utils.js";
import { getAddictionState, isAddictionCondition, saveAddictionState } from "../features/special-counters.js";
import { buildAddictionFlatMessage, buildAddictionRollMessage } from "./chat-service.js";
import { createObjectOperationQueue } from "../../operation-queue.js";
import { makeSocketRequestId } from "../../socket-utils.js";
import { executeAsActiveGM, getActiveGM, registerSocketHandler } from "../../integration/socket-api.js";
import { getCalendariaApi, registerCalendariaReadyHook } from "../../integration/calendaria-adapter.js";
import { clearDocumentFlagNullVerified, createCodedError, plainValuesEqual, readDocumentFlag, setDocumentFlagVerified } from "../../document-writes.js";

const ADDICTION_DICE_STEPS = Object.freeze([6, 8, 10, 12]);
const enqueueMorning = createObjectOperationQueue();
const MORNING_OPERATION = "conditions.addiction-morning";
const PENDING_TRANSITION = "conditions.addictionPendingTransition";
const PENDING_ADJUSTMENT = "conditions.addictionPendingAdjustment";
let operationsInitialized = false;

function hasActorItem(actor, itemId) {
  if (!actor?.items || !itemId) return false;
  if (typeof actor.items.get === "function") return Boolean(actor.items.get(itemId));
  return Array.from(actor.items).some((entry) => entry?.id === itemId);
}

export async function handleAddictionOperation(payload, context) {
  const actor = payload?.actorUuid ? await globalThis.fromUuid?.(payload.actorUuid) : game.actors?.get?.(payload?.actorId);
  const item = actor?.items?.get?.(payload?.itemId);
  if (!actor || actor.pack || actor.documentName !== "Actor" || actor.type !== "character" || item?.type !== "criticalInjury" || !isAddictionCondition(item)
    || context.requestUser?.active === false
    || (!context.requestUser?.isGM && !actor.testUserPermission?.(context.requestUser, "OWNER"))) {
    throw new Error("Addiction changes require ownership of a character");
  }
  const submitted = payload.options ?? {};
  const dayAction = payload.kind === "morning" && submitted.newDay === true;
  if (!context.requestUser?.isGM && !dayAction && !game.settings.get(MODULE_ID, "playersCanEdit")) {
    throw new Error("STAT editing is disabled");
  }
  const options = { dayKey: submitted.dayKey, newDay: submitted.newDay === true, validateRequestedDay: true,
    requireDayMatch: submitted.requireDayMatch === true,
    morningId: submitted.morningId, postChat: submitted.postChat !== false, notify: submitted.notify !== false,
    state: submitted.state, delta: submitted.delta,
    documentOptions: submitted.render === false ? { render: false } : {} };
  const result = payload.kind === "morning" ? await performAddictionMorning(actor, item, options)
    : payload.kind === "resolve" ? await resolveAddictionMorning(actor, item, payload.outcome, options)
      : payload.kind === "dose" ? await relapseAddiction(actor, item, options)
        : payload.kind === "adjust" ? await correctAddictionState(actor, item, options) : null;
  if (!result) throw new TypeError("Invalid addiction action");
  return { ...result, roll: null };
}

export function initializeAddictionOperations() {
  if (operationsInitialized) return;
  registerSocketHandler(MORNING_OPERATION, handleAddictionOperation);
  registerCalendariaReadyHook();
  operationsInitialized = true;
}

function remoteMorningOperation(actor, item, kind, options, outcome) {
  const activeGM = getActiveGM();
  if (!activeGM || activeGM.id === game.user?.id) return null;
  return executeAsActiveGM(MORNING_OPERATION, {
    actorUuid: actor.uuid, actorId: actor.id, itemId: item.id, kind, outcome,
    options: { dayKey: options.dayKey, newDay: options.newDay === true, morningId: options.morningId,
      requireDayMatch: options.requireDayMatch === true,
      state: options.state, delta: options.delta,
      postChat: options.postChat !== false, notify: options.notify !== false, render: options.documentOptions?.render }
  });
}

export function getAddictionMorning(item) {
  return item?.getFlag?.(MODULE_ID, FLAGS.ADDICTION_MORNING) ?? null;
}

export function getPendingAddictionTransition(item) {
  return readDocumentFlag(item, MODULE_ID, PENDING_TRANSITION) ?? null;
}

export function getPendingAddictions(actor) {
  return Array.from(actor?.items?.values?.() ?? actor?.items ?? []).filter(item =>
    item.type === "criticalInjury" && isAddictionCondition(item)
      && (getAddictionMorning(item)?.status === "pending" || getPendingAddictionTransition(item))
  );
}

export function addictionCalendarDayKey(calendarId, date) {
  return `calendar:${calendarId}:${date.year}:${date.month}:${date.day}`;
}

export function getAddictionDayKey(actor, { dayKey, newDay = false } = {}) {
  if (dayKey) return String(dayKey);
  if (globalThis.game?.settings?.get?.(MODULE_ID, "stateProgressionMode") === "calendaria") {
    const api = getCalendariaApi({ requireActiveModule: false });
    const date = api?.getCurrentDateTime?.();
    const calendar = api?.getActiveCalendar?.();
    const calendarId = calendar?.metadata?.id ?? calendar?.id;
    if (date && calendarId) return addictionCalendarDayKey(calendarId, date);
  }
  // Long Rest need not advance world time. Its explicit New Day action starts
  // the next numbered morning; STAT reuses the currently started morning.
  let current = Math.max(0, Number(actor?.getFlag?.(MODULE_ID, FLAGS.ADDICTION_DAY)) || 0);
  // The Item write can succeed before the Actor counter write fails. Its
  // committed day also prevents replay in that partial-failure case.
  for (const item of actor?.items?.values?.() ?? actor?.items ?? []) {
    const morning = getAddictionMorning(item);
    if (morning?.startedByNewDay && morning.dayKey?.startsWith("manual:")) {
      current = Math.max(current, Number(morning.dayKey.slice(7)) || 0);
    }
  }
  return `manual:${Math.max(1, current + (newDay ? 1 : 0))}`;
}

async function rememberManualDay(actor, dayKey, documentOptions) {
  if (!dayKey.startsWith("manual:")) return;
  const number = Number(dayKey.slice(7));
  if (!(number > Number(actor?.getFlag?.(MODULE_ID, FLAGS.ADDICTION_DAY) || 0))) return;
  if (actor?.update || actor?.setFlag) {
    await setDocumentFlagVerified(actor, MODULE_ID, FLAGS.ADDICTION_DAY, number, { render: false, ...documentOptions });
  }
}

function morningResult(morning, { changed = false, reused = false } = {}) {
  return {
    changed, reused, morningId: morning.id, dayKey: morning.dayKey,
    pending: morning.status === "pending", advanced: !reused && Boolean(morning.advanced),
    cured: Boolean(morning.cured), phase: morning.state.phase, state: morning.state,
    nextState: morning.nextState, total: morning.total, outcome: morning.outcome, roll: null
  };
}

async function commitMorning(actor, item, morning, options) {
  await setDocumentFlagVerified(item, MODULE_ID, PENDING_TRANSITION, morning, options.documentOptions ?? {}, { replace: true });
  await finishMorningTransition(actor, item, morning, options);
}

async function finishMorningTransition(actor, item, morning, options) {
  const documentOptions = options.documentOptions ?? {};
  if (morning.cured) {
    if (morning.startedByNewDay) await rememberManualDay(actor, morning.dayKey, documentOptions);
    await item.delete(documentOptions);
    if (hasActorItem(actor, item.id)) {
      throw createCodedError("write-not-persisted", "Addiction cure deletion was not persisted.");
    }
    if (options.notify !== false) {
      try { ui.notifications?.info?.(localize("Notifications.AddictionCured", "{actor} recovered from {condition}.", {
        actor: actor.name, condition: item.name
      })); } catch (error) { console.error(`${MODULE_ID} | addiction recovery notification failed`, error); }
    }
  } else {
    await saveAddictionState(item, morning.nextState, documentOptions);
    if (!plainValuesEqual(getAddictionMorning(item), morning)) {
      await setDocumentFlagVerified(item, MODULE_ID, FLAGS.ADDICTION_MORNING, morning, documentOptions, { replace: true });
    }
    await clearDocumentFlagNullVerified(item, MODULE_ID, PENDING_TRANSITION, documentOptions);
  }
}

async function resumeMorningTransition(actor, item, morning, options) {
  await finishMorningTransition(actor, item, morning, options);
  if (options.newDay && !morning.cured) await rememberManualDay(actor, morning.dayKey, options.documentOptions);
  return { ...morningResult(morning, { changed: true }), resumed: true };
}

async function finishAddictionAdjustment(item, state, documentOptions = {}) {
  await saveAddictionState(item, state, documentOptions);
  await clearDocumentFlagNullVerified(item, MODULE_ID, PENDING_ADJUSTMENT, documentOptions);
  return { changed: true, state };
}

function assertRequestedDayCurrent(actor, dayKey, itemDay, options) {
  const earlierManualDay = dayKey.startsWith("manual:") && itemDay?.startsWith("manual:")
    && Number(dayKey.slice(7)) < Number(itemDay.slice(7));
  if (!earlierManualDay) {
    if (!options.dayKey || !options.validateRequestedDay || dayKey === itemDay) return;
    if (dayKey === getAddictionDayKey(actor, { newDay: options.newDay })) return;
    if (options.newDay && dayKey === getAddictionDayKey(actor)) return;
  }
  throw createCodedError("stale-addiction-day", "The addiction day changed; refresh the preview");
}

export function shouldAdvanceAddictionAfterRoll(total) {
  const value = Number(total);
  return Number.isFinite(value) && value >= 3;
}

export async function performAddictionMorning(actor, item, options = {}) {
  if (!actor || !item) return { changed: false, skipped: true };
  const remote = remoteMorningOperation(actor, item, "morning", options);
  if (remote) return remote;
  return enqueueMorning(item, async () => {
    if (actor.items?.get && actor.items.get(item.id) !== item) return { changed: false, skipped: true };
    const interrupted = getPendingAddictionTransition(item);
    if (interrupted && !options.dayKey) return resumeMorningTransition(actor, item, interrupted, options);
    const dayKey = getAddictionDayKey(actor, options);
    const previous = getAddictionMorning(item);
    assertRequestedDayCurrent(actor, dayKey, interrupted?.dayKey ?? previous?.dayKey, options);
    const pendingDay = interrupted?.dayKey ?? (previous?.status === "pending" ? previous.dayKey : null);
    if (options.requireDayMatch && pendingDay && pendingDay !== dayKey) {
      throw createCodedError("stale-addiction-day", "The pending addiction morning belongs to another day; refresh the preview.");
    }
    if (interrupted) return resumeMorningTransition(actor, item, interrupted, options);
    if (previous?.status === "pending" || previous?.dayKey === dayKey) {
      if (options.newDay && previous.dayKey === dayKey) {
        if (!previous.startedByNewDay) {
          await setDocumentFlagVerified(item, MODULE_ID, FLAGS.ADDICTION_MORNING,
            { ...previous, startedByNewDay: true }, options.documentOptions ?? {}, { replace: true });
        }
        await rememberManualDay(actor, dayKey, options.documentOptions ?? {});
      }
      return morningResult(previous, { reused: true });
    }

    const adjustment = readDocumentFlag(item, MODULE_ID, PENDING_ADJUSTMENT);
    if (adjustment) await finishAddictionAdjustment(item, adjustment, options.documentOptions);
    const state = getAddictionState(item);
    const roll = state.phase === "flat" ? null : await new Roll(`1d${state.die}`).evaluate();
    const controlled = Boolean(roll && shouldAdvanceAddictionAfterRoll(roll.total));
    const progression = controlled ? calculateNextAddictionState(state) : { state, cured: false };
    const morning = {
      id: makeSocketRequestId(), dayKey, status: controlled ? "resolved" : "pending",
      startedByNewDay: Boolean(options.newDay),
      state, nextState: progression.cured ? null : progression.state,
      total: roll?.total ?? null, advanced: controlled, cured: progression.cured,
      outcome: controlled ? "controlled" : null
    };
    await commitMorning(actor, item, morning, options);
    if (options.newDay && !morning.cured) await rememberManualDay(actor, dayKey, options.documentOptions);

    // Presentation is secondary to the persisted morning. A chat failure must
    // not invite another craving roll or repeat a completed cycle transition.
    if (options.postChat !== false) {
      try {
        const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor }) ?? undefined;
        if (roll) await rollToMessage(roll, { speaker, flavor: buildAddictionRollMessage(actor.name, item.name, state, roll.total, {
          autoAdvanced: controlled, cured: progression.cured
        }) });
        else await createChatMessage({ speaker, content: buildAddictionFlatMessage(actor.name, item.name, state) });
      } catch (error) { console.error(`${MODULE_ID} | addiction morning chat failed`, error); }
    }
    return { ...morningResult(morning, { changed: true }), roll };
  });
}

export async function processAddictionNewDay(actor, item, options = {}) {
  return performAddictionMorning(actor, item, {
    ...options,
    newDay: true
  });
}

export async function resolveAddictionMorning(actor, item, outcome, options = {}) {
  if (!["success", "failure-dose", "failure-no-dose"].includes(outcome)) throw new TypeError("Invalid addiction outcome");
  const remote = remoteMorningOperation(actor, item, "resolve", options, outcome);
  if (remote) return remote;
  return enqueueMorning(item, async () => {
    if (actor.items?.get && actor.items.get(item.id) !== item) return { changed: false, skipped: true };
    const interrupted = getPendingAddictionTransition(item);
    if (interrupted) {
      return !options.morningId || options.morningId === interrupted.id
        ? resumeMorningTransition(actor, item, interrupted, options)
        : { changed: false, skipped: true };
    }
    const morning = getAddictionMorning(item);
    if (morning?.status !== "pending" || (options.morningId && options.morningId !== morning.id)) {
      return { changed: false, skipped: true };
    }
    const state = getAddictionState(item);
    const relapse = outcome === "failure-dose";
    const progression = relapse
      ? { state: { ...state, phase: "down", die: 12, daysLeft: 0 }, cured: false }
      : calculateNextAddictionState(state);
    const resolved = { ...morning, status: "resolved", outcome, advanced: !relapse,
      nextState: progression.cured ? null : progression.state, cured: progression.cured };
    await commitMorning(actor, item, resolved, options);
    if (options.postChat !== false) {
      try {
        const label = localize(`Addiction.Outcome.${outcome}`, outcome);
        await createChatMessage({ speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }),
          content: `<b>${escapeHTML(actor.name)} — ${escapeHTML(item.name)}</b>: ${escapeHTML(label)}.` });
      } catch (error) { console.error(`${MODULE_ID} | addiction result chat failed`, error); }
    }
    return morningResult(resolved, { changed: true });
  });
}

export async function relapseAddiction(actor, item, options = {}) {
  const remote = remoteMorningOperation(actor, item, "dose", options);
  if (remote) return remote;
  return enqueueMorning(item, async () => {
    if (actor.items?.get && actor.items.get(item.id) !== item) return { changed: false, skipped: true };
    const interrupted = getPendingAddictionTransition(item);
    if (interrupted) return resumeMorningTransition(actor, item, interrupted, options);
    const adjustment = readDocumentFlag(item, MODULE_ID, PENDING_ADJUSTMENT);
    if (adjustment) await finishAddictionAdjustment(item, adjustment, options.documentOptions);
    const state = { ...getAddictionState(item), phase: "down", die: 12, daysLeft: 0 };
    const morning = getAddictionMorning(item);
    if (morning) {
      await commitMorning(actor, item, { ...morning, status: "resolved", outcome: "dose", advanced: false, cured: false, nextState: state }, options);
    } else {
      await saveAddictionState(item, state, options.documentOptions ?? {});
    }
    return { changed: true, state };
  });
}

/** Adjust the cycle without a roll, dose, chat message, or automatic recovery. */
export async function correctAddictionState(actor, item, options = {}) {
  if (!actor || !item) return { changed: false, skipped: true };
  const remote = remoteMorningOperation(actor, item, "adjust", options);
  if (remote) return remote;
  return enqueueMorning(item, async () => {
    if (actor.items?.get && actor.items.get(item.id) !== item) return { changed: false, skipped: true };
    const interrupted = getPendingAddictionTransition(item);
    if (interrupted) return resumeMorningTransition(actor, item, interrupted, options);
    const adjustment = readDocumentFlag(item, MODULE_ID, PENDING_ADJUSTMENT);
    if (adjustment) return finishAddictionAdjustment(item, adjustment, options.documentOptions);
    const previous = getAddictionState(item);
    const state = options.delta === 1 || options.delta === -1
      ? shiftAddictionState(previous, options.delta)
      : normalizeManualAddictionState(options.state, previous);
    if (Object.keys(state).every(key => state[key] === previous[key])) return { changed: false, state };
    const morning = getAddictionMorning(item);
    if (morning) {
      await commitMorning(actor, item, { ...morning, status: "resolved", outcome: "manual",
        advanced: false, cured: false, nextState: state }, options);
    } else {
      const documentOptions = options.documentOptions ?? {};
      await setDocumentFlagVerified(item, MODULE_ID, PENDING_ADJUSTMENT, state, documentOptions, { replace: true });
      return finishAddictionAdjustment(item, state, documentOptions);
    }
    return { changed: true, state };
  });
}

function normalizeManualAddictionState(input, previous) {
  if (!input || !["down", "flat", "up"].includes(input.phase)) throw new TypeError("Invalid addiction phase");
  const die = Number(input.die);
  const severity = Number(input.severity ?? previous.severity);
  const daysLeft = Number(input.daysLeft ?? previous.daysLeft);
  if (!ADDICTION_DICE_STEPS.includes(die) || ![1, 5, 10].includes(severity)
    || !Number.isInteger(daysLeft) || daysLeft < 0 || daysLeft > 365 || (input.phase === "flat" && daysLeft < 1)) {
    throw new TypeError("Invalid addiction state");
  }
  return { phase: input.phase, die: input.phase === "flat" ? 6 : die,
    daysLeft: input.phase === "flat" ? daysLeft : 0, severity };
}

function shiftAddictionState(previous, delta) {
  if (delta > 0) return calculateNextAddictionState(previous).state;
  const state = { ...previous };
  if (state.phase === "down") {
    const index = ADDICTION_DICE_STEPS.indexOf(Number(state.die));
    state.die = index >= 0 ? ADDICTION_DICE_STEPS[Math.min(3, index + 1)] : 12;
  } else if (state.phase === "flat") {
    if (state.daysLeft < state.severity) state.daysLeft += 1;
    else { state.phase = "down"; state.die = 6; state.daysLeft = 0; }
  } else if (state.phase === "up") {
    const index = ADDICTION_DICE_STEPS.indexOf(Number(state.die));
    if (index > 0) state.die = ADDICTION_DICE_STEPS[index - 1];
    else if (index === 0) { state.phase = "flat"; state.die = 6; state.daysLeft = 1; }
    else state.die = 6;
  }
  return state;
}

export function calculateNextAddictionState(inputState = {}) {
  const state = {
    phase: inputState.phase ?? "down",
    die: Number(inputState.die) || 12,
    daysLeft: Number(inputState.daysLeft) || 0,
    severity: Math.max(1, Number(inputState.severity) || 5)
  };

  if (state.phase === "down") {
    const currentIndex = ADDICTION_DICE_STEPS.indexOf(state.die);
    if (currentIndex < 0) state.die = 12;
    else if (currentIndex > 0) state.die = ADDICTION_DICE_STEPS[currentIndex - 1];
    else {
      state.phase = "flat";
      state.daysLeft = state.severity;
    }
    return { state, cured: false };
  }

  if (state.phase === "flat") {
    state.daysLeft -= 1;
    if (state.daysLeft <= 0) {
      state.phase = "up";
      state.die = 6;
      state.daysLeft = 0;
    }
    return { state, cured: false };
  }

  if (state.phase === "up") {
    const currentIndex = ADDICTION_DICE_STEPS.indexOf(state.die);
    if (currentIndex < 0) {
      state.die = 6;
      return { state, cured: false };
    }
    if (currentIndex < ADDICTION_DICE_STEPS.length - 1) {
      state.die = ADDICTION_DICE_STEPS[currentIndex + 1];
      return { state, cured: false };
    }
    return { state, cured: true };
  }

  state.phase = "down";
  state.die = 12;
  state.daysLeft = 0;
  return { state, cured: false };
}
