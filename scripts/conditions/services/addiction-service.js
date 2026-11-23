import { MODULE_ID, FLAGS, flagUpdatePath } from "../constants.js";
import { createChatMessage, escapeHTML, localize, rollToMessage } from "../utils.js";
import { getAddictionState, isAddictionCondition, normalizeAddictionSeverityChange, saveAddictionState } from "../features/special-counters.js";
import { buildAddictionFlatMessage, buildAddictionRollMessage } from "./chat-service.js";
import { makeSocketRequestId } from "../../socket-utils.js";
import { executeActorOperation, handleActorOperation, registerSocketHandler } from "../../integration/socket-api.js";
import { getConditionItem, verifyConditionWrite } from "./condition-writes.js";
import { getCalendariaContext } from "../../integration/calendaria-adapter.js";
import { isUnknownWriteOutcome, runDocumentWrite, whisperToGM } from "../../document-writes.js";

const ADDICTION_DICE_STEPS = Object.freeze([6, 8, 10, 12]);
const MORNING_OPERATION = "conditions.addiction-morning";
let operationsInitialized = false;

export function handleAddictionOperation(payload, context) {
  return handleActorOperation(payload, context, async (actor, command, user) => {
    const item = getConditionItem(actor, command.itemId);
    if (item?.type !== "criticalInjury" || !isAddictionCondition(item)) throw new Error("Invalid Addiction item");
    const submitted = command.options ?? {};
    const options = { dayKey: submitted.dayKey, newDay: submitted.newDay === true,
      morningId: submitted.morningId, postChat: submitted.postChat !== false, notify: submitted.notify !== false,
      state: submitted.state, delta: submitted.delta, severity: submitted.severity,
      documentOptions: submitted.render === false ? { render: false } : {} };
    const result = await applyAddictionOperation(actor, item, command.kind, options, command.outcome, user);
    return { ...result, roll: null };
  });
}

export function initializeAddictionOperations() {
  if (operationsInitialized) return;
  registerSocketHandler(MORNING_OPERATION, handleAddictionOperation);
  operationsInitialized = true;
}

function runAddictionOperation(actor, item, kind, options, outcome) {
  if (!actor || !item) return { changed: false, skipped: true };
  return executeActorOperation(actor, MORNING_OPERATION, {
    itemId: item.id, kind, outcome,
    options: { dayKey: options.dayKey, newDay: options.newDay === true, morningId: options.morningId,
      state: options.state, delta: options.delta, severity: options.severity,
      postChat: options.postChat !== false, notify: options.notify !== false, render: options.documentOptions?.render }
  }, (liveActor, _command, user) => {
    const liveItem = getConditionItem(liveActor, item.id);
    if (liveItem?.type !== "criticalInjury" || !isAddictionCondition(liveItem)) return { changed: false, skipped: true };
    return applyAddictionOperation(liveActor, liveItem, kind, options, outcome, user);
  });
}

function applyAddictionOperation(actor, item, kind, options, outcome, user) {
  const newDay = kind === "morning" && options.newDay === true;
  if (!user?.isGM && !newDay && !game.settings.get(MODULE_ID, "playersCanEdit")) {
    throw new Error("STAT editing is disabled");
  }
  switch (kind) {
    case "morning": {
      assertMorningDayCurrent(actor, options);
      return performAddictionMorningInternal(actor, item, options);
    }
    case "resolve": return resolveAddictionMorningInternal(actor, item, outcome, options);
    case "dose": return relapseAddictionInternal(actor, item, options);
    case "adjust": return correctAddictionStateInternal(actor, item, options);
    default: throw new TypeError("Invalid addiction action");
  }
}

function assertMorningDayCurrent(actor, { dayKey, newDay }) {
  if (dayKey === undefined) return;
  const current = getAddictionDayKey(actor);
  const expected = getAddictionDayKey(actor, { newDay });
  if (dayKey === expected || (newDay && dayKey === current)) return;
  throw Object.assign(new Error("The addiction day changed; refresh the preview"), { code: "stale-plan" });
}

export function getAddictionMorning(item) {
  return item?.getFlag?.(MODULE_ID, FLAGS.ADDICTION_MORNING) ?? null;
}

export function getPendingAddictions(actor) {
  return Array.from(actor?.items?.values?.() ?? actor?.items ?? []).filter(item =>
    item.type === "criticalInjury" && isAddictionCondition(item) && getAddictionMorning(item)?.status === "pending"
  );
}

export function addictionCalendarDayKey(calendarId, date) {
  return `calendar:${calendarId}:${date.year}:${date.month}:${date.day}`;
}

export function getAddictionDayKey(actor, { dayKey, newDay = false } = {}) {
  if (dayKey) return String(dayKey);
  if (globalThis.game?.settings?.get?.(MODULE_ID, "stateProgressionMode") === "calendaria") {
    const context = getCalendariaContext();
    if (context) return addictionCalendarDayKey(context.calendarId, context.date);
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
  await runDocumentWrite(() => actor.update
    ? actor.update({ [flagUpdatePath(FLAGS.ADDICTION_DAY)]: number }, documentOptions)
    : actor.setFlag(MODULE_ID, FLAGS.ADDICTION_DAY, number));
  if (actor.getFlag(MODULE_ID, FLAGS.ADDICTION_DAY) !== number) throw new Error("Addiction day was not persisted");
}

async function rememberCommittedMorning(actor, item, morning, options) {
  try {
    await rememberManualDay(actor, morning.dayKey, options.documentOptions ?? {});
  } catch (cause) {
    const outcomeUnknown = isUnknownWriteOutcome(cause);
    const details = {
      actor: actor.name, item: item.name, id: item.id, day: morning.dayKey.slice(7),
      change: morning.cured
        ? localize("Notifications.AddictionMorningCureSaved", "recovery removed the Item")
        : localize("Notifications.AddictionMorningSaved", "the morning was saved on the Item")
    };
    const message = localize("Notifications.AddictionDayWriteFailed",
      "{actor} — {item} ({id}): {change}. Actor day {day} is unconfirmed. Check the sheet before repeating.", details);
    if (options.reportFailure !== false) whisperToGM(message);
    throw Object.assign(new Error(message, { cause }), { partiallyApplied: true,
      code: outcomeUnknown ? "condition-outcome-unknown" : "condition-partial-failure" });
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

async function commitMorning(actor, item, morning, nextState, options) {
  if (morning.cured) {
    await runDocumentWrite(() => item.delete(options.documentOptions ?? {}));
    if (getConditionItem(actor, item.id)) throw new Error("Addiction cure was not persisted");
    if (options.notify !== false) {
      try { ui.notifications?.info?.(localize("Notifications.AddictionCured", "{actor} recovered from {condition}.", {
        actor: escapeHTML(actor.name), condition: escapeHTML(item.name)
      })); } catch (error) { console.error(`${MODULE_ID} | addiction recovery notification failed`, error); }
    }
  } else {
    await saveAddictionState(item, nextState, options.documentOptions ?? {}, {
      [flagUpdatePath(FLAGS.ADDICTION_MORNING)]: morning
    });
  }
}

export function shouldAdvanceAddictionAfterRoll(total) {
  const value = Number(total);
  return Number.isFinite(value) && value >= 3;
}

export async function performAddictionMorning(actor, item, options = {}) {
  return runAddictionOperation(actor, item, "morning", options);
}

/** Execute inside an existing Actor operation. */
export async function performAddictionMorningInternal(actor, item, options = {}) {
  item = getConditionItem(actor, item?.id);
  if (!item) return { changed: false, skipped: true };
  const dayKey = getAddictionDayKey(actor, options);
  const previous = getAddictionMorning(item);
  if (previous?.status === "pending" || previous?.dayKey === dayKey) {
    if (options.newDay && previous.dayKey === dayKey) {
      if (!previous.startedByNewDay) {
        const update = { [flagUpdatePath(FLAGS.ADDICTION_MORNING)]: { ...previous, startedByNewDay: true } };
        await runDocumentWrite(() => item.update(structuredClone(update), options.documentOptions ?? {}));
        verifyConditionWrite(getConditionItem(actor, item.id), update);
      }
      await rememberCommittedMorning(actor, item, previous, options);
    }
    return morningResult(previous, { reused: true });
  }

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
  await commitMorning(actor, item, morning, progression.state, options);
  if (options.newDay) await rememberCommittedMorning(actor, item, morning, options);

  // Presentation is secondary to the persisted morning. A chat failure must
  // not invite another craving roll or repeat a completed cycle transition.
  if (options.postChat !== false) {
    const chat = postAddictionMorning(actor, item, morning, roll);
    if (!options.deferChat) await chat;
  }
  return { ...morningResult(morning, { changed: true }), roll };
}

async function postAddictionMorning(actor, item, morning, roll) {
  try {
    const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor });
    if (roll) await rollToMessage(roll, { speaker, flavor: buildAddictionRollMessage(actor.name, item.name, morning.state, morning.total, {
      autoAdvanced: morning.advanced, cured: morning.cured
    }) });
    else await createChatMessage({ speaker, content: buildAddictionFlatMessage(actor.name, item.name, morning.state) });
  } catch (error) { console.error(`${MODULE_ID} | addiction morning chat failed`, error); }
}

export async function processAddictionNewDay(actor, item, options = {}) {
  return performAddictionMorning(actor, item, {
    ...options,
    newDay: true
  });
}

export function processAddictionNewDayInternal(actor, item, options = {}) {
  // Calendaria passes its validated date, which may be before today's date.
  return performAddictionMorningInternal(actor, item, { ...options, newDay: true });
}

export async function resolveAddictionMorning(actor, item, outcome, options = {}) {
  return runAddictionOperation(actor, item, "resolve", options, outcome);
}

/** Execute inside an existing Actor operation. */
export async function resolveAddictionMorningInternal(actor, item, outcome, options = {}) {
  if (!["success", "failure-dose", "failure-no-dose"].includes(outcome)) throw new TypeError("Invalid addiction outcome");
  item = getConditionItem(actor, item?.id);
  if (!item) return { changed: false, skipped: true };
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
  await commitMorning(actor, item, resolved, progression.state, options);
  if (options.postChat !== false) {
    try {
      const label = localize(`Addiction.Outcome.${outcome}`, outcome);
      await createChatMessage({ speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }),
        content: `<b>${escapeHTML(actor.name)} — ${escapeHTML(item.name)}</b>: ${escapeHTML(label)}.` });
    } catch (error) { console.error(`${MODULE_ID} | addiction result chat failed`, error); }
  }
  return morningResult(resolved, { changed: true });
}

export async function relapseAddiction(actor, item, options = {}) {
  return runAddictionOperation(actor, item, "dose", options);
}

/** Execute inside an existing Actor operation. */
export async function relapseAddictionInternal(actor, item, options = {}) {
  item = getConditionItem(actor, item?.id);
  if (!item) return { changed: false, skipped: true };
  const state = { ...getAddictionState(item), phase: "down", die: 12, daysLeft: 0 };
  const morning = getAddictionMorning(item);
  await saveAddictionState(item, state, options.documentOptions ?? {}, morning ? {
    [flagUpdatePath(FLAGS.ADDICTION_MORNING)]: { ...morning, status: "resolved", outcome: "dose", advanced: false, cured: false, nextState: state }
  } : {});
  return { changed: true, state };
}

/** Adjust the cycle without a roll, dose, chat message, or automatic recovery. */
export async function correctAddictionState(actor, item, options = {}) {
  return runAddictionOperation(actor, item, "adjust", options);
}

/** Execute inside an existing Actor operation. */
export async function correctAddictionStateInternal(actor, item, options = {}) {
  item = getConditionItem(actor, item?.id);
  if (!item) return { changed: false, skipped: true };
  const previous = getAddictionState(item);
  if (options.severity !== undefined && ![1, 5, 10].includes(options.severity)) throw new TypeError("Invalid Addiction severity");
  const state = options.severity !== undefined ? normalizeAddictionSeverityChange({ ...previous }, options.severity)
    : options.delta === 1 || options.delta === -1
    ? shiftAddictionState(previous, options.delta)
    : normalizeManualAddictionState(options.state, previous);
  if (Object.keys(state).every(key => state[key] === previous[key])) return { changed: false, state };
  const morning = getAddictionMorning(item);
  await saveAddictionState(item, state, options.documentOptions ?? {}, morning ? {
    [flagUpdatePath(FLAGS.ADDICTION_MORNING)]: { ...morning, status: "resolved", outcome: "manual",
      advanced: false, cured: false, nextState: state }
  } : {});
  return { changed: true, state };
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
    state.die = ADDICTION_DICE_STEPS[Math.min(3, ADDICTION_DICE_STEPS.indexOf(Number(state.die)) + 1)];
  } else if (state.phase === "flat") {
    if (state.daysLeft < state.severity) state.daysLeft += 1;
    else { state.phase = "down"; state.die = 6; state.daysLeft = 0; }
  } else if (state.phase === "up") {
    const index = ADDICTION_DICE_STEPS.indexOf(Number(state.die));
    if (index > 0) state.die = ADDICTION_DICE_STEPS[index - 1];
    else { state.phase = "flat"; state.die = 6; state.daysLeft = 1; }
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
    if (currentIndex > 0) state.die = ADDICTION_DICE_STEPS[currentIndex - 1];
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
    if (currentIndex >= 0 && currentIndex < ADDICTION_DICE_STEPS.length - 1) {
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
