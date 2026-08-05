/**
 * Shared accessors for Forbidden Lands actor data paths.
 *
 * The system has used both singular and plural containers across releases.
 * Feature modules should use these helpers instead of guessing paths locally.
 */

const ATTRIBUTE_VALUE_FIELDS = Object.freeze(["value", "current"]);
const ATTRIBUTE_MAX_FIELDS = Object.freeze(["max", "valueMax"]);
const ATTRIBUTE_CONTAINERS = Object.freeze(["attribute", "attributes"]);
const CURRENCY_CONTAINERS = Object.freeze(["currency", "currencies"]);

export function getActorAttributeState(actor, attributeKey) {
  const key = normalizeKey(attributeKey);
  const valuePath = findExistingPath(actor, buildAttributePaths(key, ATTRIBUTE_VALUE_FIELDS))
    ?? `system.attribute.${key}.value`;
  const maxPath = findExistingPath(actor, buildAttributePaths(key, ATTRIBUTE_MAX_FIELDS));

  const value = readFiniteNumber(getProperty(actor, valuePath));
  const max = readFiniteNumber(maxPath ? getProperty(actor, maxPath) : undefined);
  const hasValue = Number.isFinite(value);
  const hasMax = Number.isFinite(max);
  const effectiveMax = hasMax ? max : value;

  return {
    key,
    valuePath,
    maxPath,
    value: hasValue ? value : 0,
    max: Number.isFinite(effectiveMax) ? effectiveMax : 0,
    hasValue,
    hasMax,
    canRecover: hasValue && hasMax && value < max
  };
}

export function getActorAttributeValuePath(actor, attributeKey) {
  return getActorAttributeState(actor, attributeKey).valuePath;
}

export function getActorAttributeMaximum(actor, attributeKey) {
  const state = getActorAttributeState(actor, attributeKey);
  if (state.hasMax) return state.max;
  return state.hasValue ? state.value : 0;
}

export function getActorCurrencyPath(actor, currencyKey) {
  const key = normalizeKey(currencyKey);
  const candidates = CURRENCY_CONTAINERS.flatMap((container) => [
    `system.${container}.${key}.value`,
    `system.${container}.${key}.current`,
    `system.${container}.${key}`
  ]);
  return findExistingPath(actor, candidates) ?? `system.currency.${key}.value`;
}

export function getActorCurrencyValue(actor, currencyKey) {
  const value = readFiniteNumber(getProperty(actor, getActorCurrencyPath(actor, currencyKey)));
  return Number.isFinite(value) ? value : 0;
}

export function buildActorCurrencyUpdate(actor, values = {}) {
  const update = {};
  for (const [key, rawValue] of Object.entries(values)) {
    update[getActorCurrencyPath(actor, key)] = Math.max(0, Math.floor(Number(rawValue) || 0));
  }
  return update;
}

export function findExistingPath(object, paths) {
  for (const path of paths ?? []) {
    if (getProperty(object, path) !== undefined) return path;
  }
  return null;
}

export function getProperty(object, path) {
  const foundryGetProperty = globalThis.foundry?.utils?.getProperty;
  if (typeof foundryGetProperty === "function") return foundryGetProperty(object, path);

  return String(path ?? "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], object);
}

function buildAttributePaths(attributeKey, fields) {
  return ATTRIBUTE_CONTAINERS.flatMap((container) => (
    fields.map((field) => `system.${container}.${attributeKey}.${field}`)
  ));
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}
