import { FLAGS, MODULE_ID, SETTINGS, DEFAULT_ADDICTION_STATE, flagUpdatePath } from "../constants.js";
import { CONDITION_DEFINITIONS } from "../condition-definitions.js";
import { isFeatureEnabled } from "../settings.js";
import { applyActorAttributeDamage, clampNumber, isNamedSpecialCondition, localize, normalizeConditionName, parseCounterPair, parseFirstInteger } from "../utils.js";

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
  return isFeatureEnabled(SETTINGS.FEATURE_HEAT) && isNamedSpecialCondition(item, getHeatDefinition());
}

export function isMorCondition(item) {
  return isFeatureEnabled(SETTINGS.FEATURE_MOR) && ["мор", "mor"].includes(normalizeConditionName(item?.name));
}

export function isAddictionCondition(item) {
  const name = normalizeConditionName(item?.name);
  return isFeatureEnabled(SETTINGS.FEATURE_ADDICTION) && (name.includes("зависимость") || name.includes("addiction"));
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

export async function updateAddictionModifiers(item, state, documentOptions = {}) {
  if (!item) return;

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

  await item.update(updateData, documentOptions);
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

  const heat = getHeatDefinition();
  const previousValue = parseHeatValue(item);
  const overcap = Number(newValue) > previousValue && previousValue >= heat.max;
  const value = clampNumber(newValue, 0, heat.max);
  const damage = (value > previousValue || overcap) ? getHeatThresholdDamage(previousValue, value, overcap) : {};

  await item.update({
    [flagUpdatePath(FLAGS.HEAT_VALUE)]: value,
    "system.healingTime": ""
  }, documentOptions);

  const appliedDamage = Object.keys(damage).length ? await applyActorAttributeDamage(actor, damage, documentOptions) : [];

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

export async function updateMorItem(item, newX, newY, documentOptions = {}) {
  if (!item) return null;
  const state = { current: Math.max(0, newX), permanent: Math.max(0, newY) };
  await item.update({
    [flagUpdatePath(FLAGS.MOR_STATE)]: state,
    "system.healingTime": ""
  }, documentOptions);
  return state;
}

export function needsSpecialCounterMigration(item) {
  const healingTime = String(item?.system?.healingTime ?? "").trim();
  if (!healingTime) return false;
  if (isNamedSpecialCondition(item, getHeatDefinition()) && item.getFlag(MODULE_ID, FLAGS.HEAT_VALUE) === undefined) return true;
  if (["мор", "mor"].includes(normalizeConditionName(item.name)) && item.getFlag(MODULE_ID, FLAGS.MOR_STATE) === undefined) return true;
  return false;
}

export function buildSpecialCounterMigrationUpdate(item) {
  const healingTime = String(item?.system?.healingTime ?? "").trim();
  if (!healingTime) return null;

  if (isNamedSpecialCondition(item, getHeatDefinition()) && item.getFlag(MODULE_ID, FLAGS.HEAT_VALUE) === undefined) {
    return {
      _id: item.id,
      [flagUpdatePath(FLAGS.HEAT_VALUE)]: parseHeatValue(item),
      "system.healingTime": ""
    };
  }

  if (["мор", "mor"].includes(normalizeConditionName(item.name)) && item.getFlag(MODULE_ID, FLAGS.MOR_STATE) === undefined) {
    const mor = getMorState(item);
    return {
      _id: item.id,
      [flagUpdatePath(FLAGS.MOR_STATE)]: { current: mor.current, permanent: mor.permanent },
      "system.healingTime": ""
    };
  }

  return null;
}
