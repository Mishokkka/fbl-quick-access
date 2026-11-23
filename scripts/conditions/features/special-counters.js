import { FLAGS, MODULE_ID, SETTINGS, DEFAULT_ADDICTION_STATE, flagUpdatePath } from "../constants.js";
import { CONDITION_DEFINITIONS } from "../condition-definitions.js";
import { getConditionKind } from "../condition-kind.js";
import { executeActorOperation, handleActorOperation, hasSocketHandler, registerSocketHandler } from "../../integration/socket-api.js";
import { applyActorAttributeDamage, getConditionItem, reportPartialConditionWrite, updateConditionDocument, verifyConditionWrite } from "../services/condition-writes.js";
import { buildMorGainMessage, buildMorRemoveMessage } from "../services/chat-service.js";
import { isFeatureEnabled } from "../settings.js";
import { clampNumber, localize, parseCounterPair, parseFirstInteger, rollToMessage } from "../utils.js";

const COUNTER_OPERATION = "conditions.counters";

export function getHeatDefinition() {
  const definition = CONDITION_DEFINITIONS.heat || { names: ["жара", "heat"], max: 4, levels: {} };
  const levels = {};

  for (let value = 0; value <= definition.max; value += 1) {
    const fallback = definition.levels?.[value] || {};
    levels[value] = {
      label: localize(`Heat.Level${value}.Label`, fallback.label || `Heat ${value}`),
      summary: localize(`Heat.Level${value}.Summary`, fallback.summary || ""),
      consequence: localize(`Heat.Level${value}.Consequence`, fallback.consequence || "")
    };
  }

  return { ...definition, levels };
}

export function isHeatCondition(item) {
  return isFeatureEnabled(SETTINGS.FEATURE_HEAT) && getConditionKind(item) === "heat";
}

export function isMorCondition(item) {
  return isFeatureEnabled(SETTINGS.FEATURE_MOR) && getConditionKind(item) === "mor";
}

export function isAddictionCondition(item) {
  return isFeatureEnabled(SETTINGS.FEATURE_ADDICTION) && getConditionKind(item) === "addiction";
}

export function parseHeatValue(item) {
  const heat = getHeatDefinition();
  const raw = item?.getFlag?.(MODULE_ID, FLAGS.HEAT_VALUE) ?? item?.system?.healingTime ?? 0;
  return clampNumber(parseFirstInteger(raw, 0), 0, heat.max);
}

export function getHeatLevel(value) {
  const heat = getHeatDefinition();
  return heat.levels[value] || heat.levels[0];
}

export function buildHeatDots(value) {
  const heat = getHeatDefinition();
  let dots = "";
  for (let i = 1; i <= heat.max; i++) {
    dots += `<span class="heat-dot ${i <= value ? "active" : ""}" data-level="${i}"></span>`;
  }
  return dots;
}

export function getMorState(item) {
  const [current, permanent] = parseCounterPair(item?.getFlag?.(MODULE_ID, FLAGS.MOR_STATE) ?? item?.system?.healingTime ?? "0/0");
  return { current: Math.max(0, current), permanent: Math.max(0, permanent) };
}

export function getAddictionState(item) {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_ADDICTION_STATE),
    item?.getFlag?.(MODULE_ID, FLAGS.ADDICTION_STATE) || {},
    { inplace: false }
  );
}

export function getTreatmentLabel(status) {
  const key = {
    fail: "Treatment.FailShort",
    normal: "Treatment.NormalShort",
    prof: "Treatment.ProfessionalShort",
    none: "Treatment.NotRequiredShort"
  }[status] || "Treatment.NormalShort";
  return localize(key, status || "treated");
}

const ADDICTION_MODIFIER_DEFINITIONS = Object.freeze({
  strength: { key: "fblecAddictionStrength", name: "ATTRIBUTE.STRENGTH" },
  agility: { key: "fblecAddictionAgility", name: "ATTRIBUTE.AGILITY" },
  wits: { key: "fblecAddictionWits", name: "ATTRIBUTE.WITS" },
  empathy: { key: "fblecAddictionEmpathy", name: "ATTRIBUTE.EMPATHY" }
});

const LEGACY_ADDICTION_MODIFIER_KEYS = Object.freeze([
  "fblecAddiction0",
  "fblecAddiction1",
  "fblecAddiction2",
  "fblecAddiction3"
]);

function getAddictionModifierValues(state) {
  let modStrAgi = 0;
  let modWitEmp = 0;

  if (state.phase === "down" || state.phase === "up") {
    if (state.die === 8 || state.die === 6) modStrAgi = -1;
  } else if (state.phase === "flat") {
    const severity = Math.max(1, Number(state.severity) || DEFAULT_ADDICTION_STATE.severity);
    const daysLeft = clampNumber(Number(state.daysLeft) || 0, 0, severity);
    const daysInFlat = severity - daysLeft + 1;

    if (daysInFlat >= 9) { modStrAgi = -4; modWitEmp = -4; }
    else if (daysInFlat >= 5) { modStrAgi = -3; modWitEmp = -3; }
    else if (daysInFlat >= 3) { modStrAgi = -2; modWitEmp = -2; }
    else if (daysInFlat >= 1) { modStrAgi = -2; modWitEmp = 0; }
  }

  return { modStrAgi, modWitEmp };
}

function buildAddictionModifiers(state) {
  const { modStrAgi, modWitEmp } = getAddictionModifierValues(state);
  const nextModifiers = {};

  function addModifier(definition, value) {
    if (!value) return;
    nextModifiers[definition.key] = {
      name: definition.name,
      value: String(value)
    };
  }

  addModifier(ADDICTION_MODIFIER_DEFINITIONS.strength, modStrAgi);
  addModifier(ADDICTION_MODIFIER_DEFINITIONS.agility, modStrAgi);
  addModifier(ADDICTION_MODIFIER_DEFINITIONS.wits, modWitEmp);
  addModifier(ADDICTION_MODIFIER_DEFINITIONS.empathy, modWitEmp);

  return nextModifiers;
}

function sameStringSet(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function needsAddictionModifierSync(item, state = getAddictionState(item)) {
  if (!item) return false;

  const expectedModifiers = buildAddictionModifiers(state);
  const expectedKeys = Object.keys(expectedModifiers);
  const currentModifiers = item.system?.rollModifiers || {};
  const currentFblecKeys = Object.keys(currentModifiers)
    .filter(key => String(key).startsWith("fblecAddiction"));
  const managedKeys = Array.isArray(item.getFlag(MODULE_ID, FLAGS.ADDICTION_MODIFIER_KEYS))
    ? item.getFlag(MODULE_ID, FLAGS.ADDICTION_MODIFIER_KEYS)
    : [];

  if (!sameStringSet(currentFblecKeys, expectedKeys)) return true;
  if (!sameStringSet(managedKeys, expectedKeys)) return true;

  for (const [key, expected] of Object.entries(expectedModifiers)) {
    const current = currentModifiers[key];
    if (!current || current.name !== expected.name || String(current.value) !== expected.value) return true;
  }

  return false;
}

export function normalizeAddictionSeverityChange(state, nextSeverity) {
  const previousSeverity = Math.max(1, Number(state.severity) || DEFAULT_ADDICTION_STATE.severity);
  const severity = Math.max(1, Number(nextSeverity) || DEFAULT_ADDICTION_STATE.severity);

  if (state.phase === "flat") {
    const previousDaysLeft = clampNumber(Number(state.daysLeft) || 0, 0, previousSeverity);
    const elapsedDays = Math.max(0, previousSeverity - previousDaysLeft);
    state.daysLeft = clampNumber(severity - elapsedDays, 1, severity);
  }

  state.severity = severity;
  return state;
}

export function buildAddictionModifierUpdate(item, state) {
  const nextModifiers = buildAddictionModifiers(state);
  const nextKeys = Object.keys(nextModifiers);
  const desiredKeys = new Set(nextKeys);
  const stableKeys = Object.values(ADDICTION_MODIFIER_DEFINITIONS).map(definition => definition.key);
  const managedKeys = Array.isArray(item.getFlag(MODULE_ID, FLAGS.ADDICTION_MODIFIER_KEYS))
    ? item.getFlag(MODULE_ID, FLAGS.ADDICTION_MODIFIER_KEYS)
    : [];
  const currentKeys = Object.keys(item.system?.rollModifiers || {})
    .filter(key => String(key).startsWith("fblecAddiction"));

  const keysToDelete = new Set([
    ...LEGACY_ADDICTION_MODIFIER_KEYS,
    ...stableKeys,
    ...managedKeys,
    ...currentKeys
  ]);
  for (const key of desiredKeys) keysToDelete.delete(key);

  const updateData = {
    [flagUpdatePath(FLAGS.ADDICTION_MODIFIER_KEYS)]: nextKeys
  };

  for (const key of keysToDelete) {
    updateData[`system.rollModifiers.-=${key}`] = null;
  }

  for (const [key, modifier] of Object.entries(nextModifiers)) {
    updateData[`system.rollModifiers.${key}`] = modifier;
  }

  return updateData;
}

export async function updateAddictionModifiers(item, state, documentOptions = {}) {
  if (!item) return;
  const update = buildAddictionModifierUpdate(item, state);
  await updateConditionDocument(item, update, documentOptions, () => getConditionItem(item.parent, item.id));
}

export async function saveAddictionState(item, state, documentOptions = {}, extraUpdate = {}) {
  if (!item) return;
  const update = { ...extraUpdate, ...buildAddictionModifierUpdate(item, state), [flagUpdatePath(FLAGS.ADDICTION_STATE)]: state };
  await updateConditionDocument(item, update, documentOptions, () => getConditionItem(item.parent, item.id));
}

export function buildHeatModifierUpdate(value) {
  const update = {};
  for (const [key, name] of [["fblecHeatEndurance", "SKILL.ENDURANCE"], ["fblecHeatMove", "SKILL.MOVE"]]) {
    if (value === getHeatDefinition().max) update[`system.rollModifiers.${key}`] = { name, value: "-1" };
    else update[`system.rollModifiers.-=${key}`] = null;
  }
  return update;
}

function getHeatThresholdDamage(previousValue, value, overcap = false) {
  const damage = {};

  if (overcap) {
    damage.strength = 1;
    damage.wits = 1;
    damage.agility = 1;
    return damage;
  }

  if (previousValue < 3 && value >= 3) damage.strength = (damage.strength || 0) + 1;
  if (previousValue < 4 && value >= 4) {
    damage.strength = (damage.strength || 0) + 1;
    damage.wits = (damage.wits || 0) + 1;
  }
  return damage;
}

export function initializeCounterOperations() {
  if (hasSocketHandler(COUNTER_OPERATION)) return;
  registerSocketHandler(COUNTER_OPERATION, async (payload, context) =>
    publishCounterResult(await handleActorOperation(payload, context, applyCounterOperation)));
}

async function runCounterOperation(actor, item, command, documentOptions) {
  if (!actor || !item) return null;
  const result = await executeActorOperation(actor, COUNTER_OPERATION, {
    ...command, itemId: item.id, render: documentOptions?.render
  }, applyCounterOperation);
  return publishCounterResult(result);
}

function publishCounterResult(result) {
  if (!result?.morChat) return result;
  const { morChat, ...written } = result;
  void publishMorRoll(morChat, written);
  return written;
}

async function publishMorRoll({ actor, roll, diceCount, ones, becamePermanent }, { state, appliedDamage }) {
  try {
    const flavor = diceCount
      ? buildMorGainMessage(actor.name, state, diceCount, ones, appliedDamage)
      : buildMorRemoveMessage(actor.name, roll.total, state, becamePermanent);
    await rollToMessage(roll, { speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }), flavor });
  } catch (error) {
    console.error(`${MODULE_ID} | Mor result chat failed`, error);
  }
}

export function updateHeatItem(actor, item, value, reason = "manual", documentOptions = {}) {
  return runCounterOperation(actor, item, { kind: "heat", value, reason }, documentOptions);
}

export function applyHeatFailure(actor, item, documentOptions = {}) {
  return runCounterOperation(actor, item, { kind: "heat", delta: 1, reason: "failure" }, documentOptions);
}

export function coolHeatItem(actor, item, documentOptions = {}) {
  return runCounterOperation(actor, item, { kind: "heat", delta: -1, reason: "rest" }, documentOptions);
}

export function changeMor(actor, item, counter, delta, documentOptions = {}) {
  return runCounterOperation(actor, item, { kind: "mor", counter, delta }, documentOptions);
}

async function applyCounterOperation(actor, command, user) {
  if (!user?.isGM && !game.settings.get(MODULE_ID, SETTINGS.PLAYERS_CAN_EDIT)) {
    throw new Error("STAT editing is disabled");
  }
  const item = getConditionItem(actor, command.itemId);
  if (item?.type !== "criticalInjury") return null;
  const options = command.render === false ? { render: false } : {};
  if (command.kind === "heat" && isHeatCondition(item)) {
    const { reason, delta } = command;
    if (!["failure", "manual", "rest"].includes(reason)) throw new TypeError("Invalid Heat action");
    const value = delta === -1 || delta === 1 ? parseHeatValue(item) + delta : command.value;
    if (!Number.isSafeInteger(value)) throw new TypeError("Invalid Heat level");
    return applyHeatChange(actor, item, value, reason, options);
  }
  if (command.kind === "mor" && isMorCondition(item)) {
    return applyMorChange(actor, item, command.counter, command.delta, options);
  }
  throw new Error("The selected condition no longer matches this action");
}

/** Execute a Heat step on the live Item inside an existing Actor operation. */
export async function applyHeatChange(actor, item, newValue, reason, documentOptions = {}) {
  const heat = getHeatDefinition();
  const previousValue = parseHeatValue(item);
  const overcap = reason === "failure" && newValue > previousValue && previousValue >= heat.max;
  const value = clampNumber(newValue, 0, heat.max);
  const damage = reason === "failure" && (value > previousValue || overcap)
    ? getHeatThresholdDamage(previousValue, value, overcap) : {};
  const appliedDamage = await applyActorAttributeDamage(actor, damage, documentOptions);
  const update = {
    ...buildHeatModifierUpdate(value),
    [flagUpdatePath(FLAGS.HEAT_VALUE)]: value,
    "system.healingTime": ""
  };
  try {
    await updateConditionDocument(item, update, documentOptions, () => getConditionItem(actor, item.id));
  } catch (error) {
    if (appliedDamage.length) throw reportPartialConditionWrite(actor, item, appliedDamage, error);
    throw error;
  }

  return { previousValue, value, heat, level: getHeatLevel(value), changed: previousValue !== value || overcap,
    overcap, reason, appliedDamage };
}

/** Execute a Mor step on the live Item inside an existing Actor operation. */
export async function applyMorChange(actor, item, counter, delta, documentOptions = {}) {
  if (!["current", "permanent"].includes(counter) || ![-1, 1].includes(delta)) throw new TypeError("Invalid Mor action");
  const state = getMorState(item);
  if (state[counter] === 0 && delta < 0) return { changed: false };
  state[counter] += delta;

  let roll, diceCount, ones, becamePermanent;
  let appliedDamage = [];
  if (counter === "current" && delta > 0) {
    diceCount = state.current + state.permanent;
    roll = await new Roll(`${diceCount}d6`).evaluate();
    ones = roll.terms[0].results.filter(result => result.result === 1).length;
    appliedDamage = await applyActorAttributeDamage(actor, { strength: ones }, documentOptions);
  } else if (counter === "current") {
    roll = await new Roll("1d6").evaluate();
    becamePermanent = roll.total === 1;
    if (becamePermanent) state.permanent += 1;
  }

  try {
    await updateMorItem(item, state.current, state.permanent, documentOptions);
  } catch (error) {
    if (appliedDamage.length) throw reportPartialConditionWrite(actor, item, appliedDamage, error);
    throw error;
  }

  return { changed: true, state, appliedDamage, morChat: roll ? { actor, roll, diceCount, ones, becamePermanent } : null };
}

async function updateMorItem(item, current, permanent, documentOptions) {
  const update = { [flagUpdatePath(FLAGS.MOR_STATE)]: { current, permanent }, "system.healingTime": "" };
  await updateConditionDocument(item, update, documentOptions, () => getConditionItem(item.parent, item.id));
}

export async function migrateSpecialCounter(actor, item) {
  const healingTime = String(item.system?.healingTime ?? "").trim();
  if (!healingTime) return false;

  const kind = getConditionKind(item);
  let key, expected;
  if (kind === "heat") {
    key = FLAGS.HEAT_VALUE;
    expected = clampNumber(parseFirstInteger(healingTime, 0), 0, getHeatDefinition().max);
  } else if (kind === "mor") {
    key = FLAGS.MOR_STATE;
    const [current, permanent] = parseCounterPair(healingTime);
    expected = { current: Math.max(0, current), permanent: Math.max(0, permanent) };
  } else return false;

  const update = { [flagUpdatePath(key)]: expected };
  const options = { render: false };
  if (item.getFlag(MODULE_ID, key) === undefined) await item.update(foundry.utils.deepClone(update), options);
  const live = getConditionItem(actor, item.id);
  verifyConditionWrite(live, update);
  const cleanup = { "system.healingTime": "" };
  await live.update(cleanup, options);
  verifyConditionWrite(getConditionItem(actor, item.id), cleanup);
  return true;
}
