import { FLAGS, MODULE_ID, SETTINGS, DEFAULT_ADDICTION_STATE, flagUpdatePath } from "../constants.js";
import { CONDITION_DEFINITIONS } from "../condition-definitions.js";
import { getConditionKind } from "../condition-kind.js";
import { createObjectOperationQueue, enqueueActorMutationOperation } from "../../operation-queue.js";
import { makeSocketRequestId } from "../../socket-utils.js";
import { clearDocumentFlagNullVerified, createCodedError, readDocumentFlag, setDocumentFlagVerified } from "../../document-writes.js";

import { isFeatureEnabled } from "../settings.js";
import { applyActorAttributeDamage, clampNumber, isNamedSpecialCondition, localize, normalizeConditionName, parseCounterPair, parseFirstInteger, planActorAttributeDamage, remainingActorAttributeDamage } from "../utils.js";

const enqueueCounterItem = createObjectOperationQueue();
const HEAT_PENDING_CHANGE = "conditions.heatPendingChange";
const MOR_PENDING_GAIN = "conditions.morPendingGain";

function enqueueCounterChange(actor, item, operation) {
  return actor ? enqueueActorMutationOperation(actor, operation) : enqueueCounterItem(item, operation);
}

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
  if (item) await item.update(buildAddictionModifierUpdate(item, state), documentOptions);
}

export async function saveAddictionState(item, state, documentOptions = {}) {
  if (!item) return;
  const isPersisted = () => {
    const saved = readDocumentFlag(item, MODULE_ID, FLAGS.ADDICTION_STATE);
    return saved && Object.entries(state).every(([key, value]) => saved[key] === value) && !needsAddictionModifierSync(item, state);
  };
  if (isPersisted()) return;
  await item.update({ ...buildAddictionModifierUpdate(item, state),
    [flagUpdatePath(FLAGS.ADDICTION_STATE)]: state }, documentOptions);
  if (!isPersisted()) {
    throw createCodedError("write-not-persisted", "Addiction state or modifiers were not persisted.");
  }
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

export async function updateHeatItem(actor, item, newValue, reason = "manual", documentOptions = {}) {
  if (!item) return null;
  return enqueueCounterChange(actor, item, () => applyHeatChange(actor, item, newValue, reason, documentOptions));
}

export async function applyHeatFailure(actor, item, documentOptions = {}) {
  if (!item) return null;
  return enqueueCounterChange(actor, item, () => {
    const pending = readDocumentFlag(item, MODULE_ID, HEAT_PENDING_CHANGE);
    return applyHeatChange(actor, item, pending?.value ?? parseHeatValue(item) + 1, "failure", documentOptions);
  });
}

export function needsHeatModifierSync(item, value = parseHeatValue(item)) {
  const update = buildHeatModifierUpdate(value);
  const current = (item?._source ?? item)?.system?.rollModifiers ?? {};
  return Object.entries(update).some(([path, modifier]) => {
    const key = path.split(".").at(-1);
    if (key.startsWith("-=")) return current[key.slice(2)] !== undefined;
    return current[key]?.name !== modifier.name || String(current[key]?.value) !== modifier.value;
  });
}

async function applyHeatChange(actor, item, newValue, reason, documentOptions) {
  const heat = getHeatDefinition();
  let pending = readDocumentFlag(item, MODULE_ID, HEAT_PENDING_CHANGE);
  const previousValue = pending?.previousValue ?? parseHeatValue(item);
  const overcap = pending?.overcap ?? (reason === "failure" && Number(newValue) > previousValue && previousValue >= heat.max);
  const value = clampNumber(newValue, 0, heat.max);
  // Manual correction and cooling never cause damage. Only a recorded failure
  // of the player's final Endurance result applies the Heat consequences.
  const damage = reason === "failure" && (value > previousValue || overcap)
    ? getHeatThresholdDamage(previousValue, value, overcap) : {};

  if (pending && (pending.value !== value || reason !== "failure")) {
    const message = localize("Heat.PendingChange", "Finish the pending Heat change before changing its level again.");
    const error = createCodedError("heat-pending-change", message);
    error.fblqaUserMessage = message;
    throw error;
  }
  const hasStoredHeatState = () => {
    const stored = item._source ?? item;
    return readDocumentFlag(stored, MODULE_ID, FLAGS.HEAT_VALUE) === value
      && String(stored.system?.healingTime ?? "") === "" && !needsHeatModifierSync(item, value);
  };
  if (!pending && !overcap && previousValue === value && hasStoredHeatState()) {
    return {
      previousValue,
      value,
      heat,
      level: getHeatLevel(value),
      changed: false,
      overcap: false,
      actor,
      reason,
      appliedDamage: []
    };
  }
  if (!pending && Object.keys(damage).length) {
    pending = { id: makeSocketRequestId(), previousValue, value, overcap, damagePlan: planActorAttributeDamage(actor, damage) };
    // Keep the visible counter unchanged until the damage is committed.
    await setDocumentFlagVerified(item, MODULE_ID, HEAT_PENDING_CHANGE, pending, documentOptions);
  }
  const appliedDamage = pending
    ? await applyCounterDamage(actor, item, HEAT_PENDING_CHANGE, pending, "heatReceipts", pending.damage ?? damage, documentOptions)
    : [];
  if (!hasStoredHeatState()) {
    await item.update({
      ...buildHeatModifierUpdate(value),
      [flagUpdatePath(FLAGS.HEAT_VALUE)]: value,
      "system.healingTime": ""
    }, documentOptions);
    if (!hasStoredHeatState()) throw createCodedError("write-not-persisted", "Heat update was not persisted.");
  }
  if (pending) await clearDocumentFlagNullVerified(item, MODULE_ID, HEAT_PENDING_CHANGE, documentOptions);

  return {
    previousValue,
    value,
    heat,
    level: getHeatLevel(value),
    changed: previousValue !== value || overcap,
    overcap,
    actor,
    reason,
    appliedDamage
  };
}

async function applyCounterDamage(actor, item, pendingKey, pending, receiptName, legacyDamages, documentOptions) {
  const legacyReceipt = readDocumentFlag(actor, MODULE_ID, `conditions.${receiptName}.${item.id}`);
  const receipt = legacyReceipt?.id === pending.id ? legacyReceipt : null;
  const damagePlan = pending.damagePlan ?? receipt?.appliedDamage ?? planActorAttributeDamage(actor, legacyDamages);
  const remaining = pending.remainingDamage ?? damagePlan;
  if (!remaining.length || receipt?.applied === true) return damagePlan;
  const checkpoint = (damageInFlight, remainingDamage) => setDocumentFlagVerified(item, MODULE_ID, pendingKey,
    { ...pending, damagePlan, damageInFlight, remainingDamage }, documentOptions, { replace: true });

  if (pending.damageInFlight) {
    const uncertain = remainingActorAttributeDamage(actor, remaining);
    if (uncertain.length) {
      const targets = uncertain.map(({ attribute, value }) => `${attribute}: ${value}`).join(", ");
      const message = localize("Notifications.DamageRecoveryRequired",
        "The damage write was interrupted. Check the current attributes against the intended values: {targets}.", { targets });
      throw Object.assign(createCodedError("damage-recovery-required", message), { fblqaUserMessage: message, damageId: pending.id });
    }
    await checkpoint(false, []);
    return damagePlan;
  }

  // Keep the Item record through both the Actor update and its readback.
  // Without a verified readback, a restored attribute is ambiguous on retry.
  await checkpoint(true, remaining);
  let writeError;
  try { await applyActorAttributeDamage(actor, remaining, documentOptions); }
  catch (error) { writeError = error; }
  const missing = remainingActorAttributeDamage(actor, remaining);
  await checkpoint(false, missing);
  if (missing.length) throw writeError ?? createCodedError("write-not-persisted", "Actor attribute damage was not persisted.");
  return damagePlan;
}

export function acknowledgeCounterDamage(actor, item, damageId, documentOptions) {
  return enqueueActorMutationOperation(actor, async () => {
    const key = isHeatCondition(item) ? HEAT_PENDING_CHANGE : MOR_PENDING_GAIN;
    const pending = readDocumentFlag(item, MODULE_ID, key);
    if (!pending?.damageInFlight || pending.id !== damageId) {
      throw createCodedError("stale-counter-damage", "The pending counter damage changed while awaiting confirmation.");
    }
    return setDocumentFlagVerified(item, MODULE_ID, key,
      { ...pending, damageInFlight: false, remainingDamage: [] }, documentOptions, { replace: true });
  });
}

export function changePermanentMor(item, delta, documentOptions = {}) {
  return enqueueCounterChange(item?.parent, item, () => {
    assertMorChangeAvailable(item);
    const { current, permanent } = getMorState(item);
    return writeMorState(item, current, permanent + delta, documentOptions);
  });
}

export function removeCurrentMor(item, documentOptions = {}) {
  return enqueueCounterChange(item?.parent, item, async () => {
    assertMorChangeAvailable(item);
    const before = getMorState(item);
    if (before.current <= 0) return null;
    const roll = await new Roll("1d6").evaluate();
    assertMorChangeAvailable(item);
    assertMorStateCurrent(item, before);
    const becamePermanent = roll.total === 1;
    const state = await writeMorState(item, before.current - 1, before.permanent + Number(becamePermanent), documentOptions);
    return { roll, state, becamePermanent };
  });
}

function assertMorChangeAvailable(item) {
  if (!readDocumentFlag(item, MODULE_ID, MOR_PENDING_GAIN)) return;
  const message = localize("Mor.PendingGain", "Use + to resume or review the pending Mor gain.");
  throw Object.assign(createCodedError("mor-pending-gain", message), { fblqaUserMessage: message });
}

function sameMorState(left, right) {
  return left.current === right.current && left.permanent === right.permanent;
}

function assertMorStateCurrent(item, before) {
  if (sameMorState(getMorState(item), before)) return;
  throw createCodedError("stale-mor-state", "Mor changed before the roll could be applied.");
}

function morGainTarget(pending) {
  return { current: pending.before.current + 1, permanent: pending.before.permanent };
}

function assertPendingMorGainCurrent(item, pending, allowApplied = false) {
  if (readDocumentFlag(item, MODULE_ID, MOR_PENDING_GAIN)?.id !== pending.id) {
    throw createCodedError("stale-mor-state", "The pending Mor gain changed.");
  }
  const current = getMorState(item);
  if (!sameMorState(current, pending.before) && !(allowApplied && sameMorState(current, morGainTarget(pending)))) {
    const message = localize("Mor.StaleGain", "Mor changed during the pending gain. Review the pending roll with +.");
    throw Object.assign(createCodedError("stale-mor-gain", message), { fblqaUserMessage: message, pendingGainId: pending.id });
  }
}

export function clearStaleMorGain(item, pendingGainId, documentOptions = {}) {
  return enqueueCounterChange(item?.parent, item, async () => {
    const pending = readDocumentFlag(item, MODULE_ID, MOR_PENDING_GAIN);
    if (!pending || pending.id !== pendingGainId || sameMorState(getMorState(item), pending.before)) {
      throw createCodedError("stale-mor-state", "The pending Mor gain changed while awaiting confirmation.");
    }
    return clearDocumentFlagNullVerified(item, MODULE_ID, MOR_PENDING_GAIN, documentOptions);
  });
}

export function applyMorGain(actor, item, documentOptions = {}) {
  return enqueueCounterChange(actor, item, async () => {
    let pending = readDocumentFlag(item, MODULE_ID, MOR_PENDING_GAIN);
    let roll;
    if (pending == null) {
      const before = getMorState(item);
      const diceCount = before.current + before.permanent + 1;
      roll = await new Roll(`${diceCount}d6`).evaluate();
      const ones = roll.terms[0].results.filter(result => result.result === 1).length;
      assertMorChangeAvailable(item);
      assertMorStateCurrent(item, before);
      pending = { id: makeSocketRequestId(), before, diceCount, ones, roll: JSON.stringify(roll),
        damagePlan: planActorAttributeDamage(actor, { strength: ones }) };
      await setDocumentFlagVerified(item, MODULE_ID, MOR_PENDING_GAIN, pending, documentOptions);
    }
    const alreadyApplied = Array.isArray(pending.damagePlan) && sameMorState(getMorState(item), morGainTarget(pending));
    assertPendingMorGainCurrent(item, pending, alreadyApplied);
    roll ??= Roll.fromJSON(pending.roll);

    const appliedDamage = pending.ones > 0
      ? await applyCounterDamage(actor, item, MOR_PENDING_GAIN, pending, "morReceipts", { strength: pending.ones }, documentOptions)
      : [];
    assertPendingMorGainCurrent(item, pending, alreadyApplied);
    const { current, permanent } = morGainTarget(pending);
    const state = await writeMorState(item, current, permanent, documentOptions);
    await clearDocumentFlagNullVerified(item, MODULE_ID, MOR_PENDING_GAIN, documentOptions);
    return { roll, state, diceCount: pending.diceCount, ones: pending.ones, appliedDamage };
  });
}

async function writeMorState(item, newX, newY, documentOptions) {
  const state = { current: Math.max(0, newX), permanent: Math.max(0, newY) };
  await item.update({
    [flagUpdatePath(FLAGS.MOR_STATE)]: state,
    "system.healingTime": ""
  }, documentOptions);
  if (!sameMorState(getMorState(item), state)) {
    throw createCodedError("write-not-persisted", "Mor update was not persisted.");
  }
  return state;
}

export function buildSpecialCounterMigrationUpdate(item) {
  const healingTime = String(item?.system?.healingTime ?? "").trim();
  if (!healingTime) return null;

  if (isNamedSpecialCondition(item, getHeatDefinition())) {
    return {
      _id: item.id,
      ...(item.getFlag(MODULE_ID, FLAGS.HEAT_VALUE) == null && { [flagUpdatePath(FLAGS.HEAT_VALUE)]: parseHeatValue(item) })
    };
  }

  if (["мор", "mor"].includes(normalizeConditionName(item.name))) {
    return {
      _id: item.id,
      ...(item.getFlag(MODULE_ID, FLAGS.MOR_STATE) == null && { [flagUpdatePath(FLAGS.MOR_STATE)]: getMorState(item) })
    };
  }

  return null;
}
