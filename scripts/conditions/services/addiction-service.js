import { MODULE_ID, FLAGS } from "../constants.js";
import { createChatMessage, escapeHTML, localize, rollToMessage } from "../utils.js";
import { getAddictionState, updateAddictionModifiers } from "../features/special-counters.js";
import { buildAddictionFlatMessage, buildAddictionRollMessage } from "./chat-service.js";

const ADDICTION_DICE_STEPS = Object.freeze([6, 8, 10, 12]);

export function shouldAdvanceAddictionAfterRoll(total) {
  const value = Number(total);
  return Number.isFinite(value) && value !== 1 && value !== 2;
}

export async function performAddictionMorning(actor, item, options = {}) {
  if (!actor || !item) return { changed: false, skipped: true };

  const state = getAddictionState(item);
  const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor }) ?? undefined;
  const autoAdvanceOnControlled = Boolean(options.autoAdvanceOnControlled);
  const advanceFlatPhase = Boolean(options.advanceFlatPhase);
  const documentOptions = options.documentOptions ?? {};
  const postChat = options.postChat !== false;
  const notify = options.notify !== false;

  if (state.phase === "flat") {
    const content = buildAddictionFlatMessage(actor.name, item.name, state);
    if (postChat) await createChatMessage({ speaker, content });

    const progression = advanceFlatPhase
      ? await advanceAddictionCycle(actor, item, { documentOptions, notify })
      : null;

    return {
      changed: Boolean(progression?.changed),
      advanced: Boolean(progression?.changed),
      cured: Boolean(progression?.cured),
      phase: state.phase,
      state,
      nextState: progression?.state ?? state,
      roll: null
    };
  }

  const roll = await new Roll(`1d${state.die}`).evaluate();
  const controlled = shouldAdvanceAddictionAfterRoll(roll.total);
  const progression = autoAdvanceOnControlled && controlled
    ? await advanceAddictionCycle(actor, item, { documentOptions, notify })
    : null;
  const flavor = buildAddictionRollMessage(actor.name, item.name, state, roll.total, {
    autoAdvanced: Boolean(progression?.changed),
    cured: Boolean(progression?.cured)
  });
  if (postChat) await rollToMessage(roll, { speaker, flavor });

  return {
    changed: Boolean(progression?.changed),
    advanced: Boolean(progression?.changed),
    cured: Boolean(progression?.cured),
    phase: state.phase,
    state,
    nextState: progression?.state ?? state,
    roll,
    total: roll.total
  };
}

export async function processAddictionNewDay(actor, item, options = {}) {
  return performAddictionMorning(actor, item, {
    ...options,
    autoAdvanceOnControlled: true,
    advanceFlatPhase: true
  });
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

export async function advanceAddictionCycle(actor, item, options = {}) {
  if (!actor || !item) return { changed: false, skipped: true };

  const documentOptions = options.documentOptions ?? {};
  const previousState = getAddictionState(item);
  const result = calculateNextAddictionState(previousState);

  if (result.cured) {
    if (options.notify !== false) ui.notifications?.info?.(localize("Notifications.AddictionCured", "{actor} recovered from {condition}.", {
      actor: escapeHTML(actor.name),
      condition: escapeHTML(item.name)
    }));
    await item.delete(documentOptions);
    return { changed: true, cured: true, previousState, state: null };
  }

  await item.update({ [`flags.${MODULE_ID}.${FLAGS.ADDICTION_STATE}`]: result.state }, documentOptions);
  await updateAddictionModifiers(item, result.state, documentOptions);
  return { changed: true, cured: false, previousState, state: result.state };
}
