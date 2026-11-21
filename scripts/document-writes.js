/**
 * Shared Foundry v13 document-write verification and plain-value helpers.
 *
 * In Foundry v13, preCreate / preUpdate / preDelete hooks may cancel a write
 * without rejecting the Promise (returning undefined, false, or an empty/partial
 * array). Verifying the live post-image on the Document ensures cancelled writes
 * are never falsely reported as persisted changes.
 */

export function createCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readNumericValue(value) {
  if (value === null || value === undefined || typeof value === "boolean") return Number.NaN;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function hasDocumentOptions(options) {
  return Boolean(options && typeof options === "object" && Object.keys(options).length);
}

export function readDocumentFlag(document, scope, key) {
  try {
    if (typeof document?.getFlag === "function") return document.getFlag(scope, key);
  } catch (_error) {
    // Fall back to direct flag property inspection for lightweight doubles.
  }
  const scoped = document?.flags?.[scope];
  if (!scoped || typeof scoped !== "object") return undefined;
  return String(key).split(".").reduce((current, part) => current?.[part], scoped);
}

export function canonicalJson(value) {
  return JSON.stringify(sortPlainValue(value));
}

export function plainValuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch (_error) {
    return false;
  }
}

function sortPlainValue(value) {
  if (Array.isArray(value)) return value.map(sortPlainValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    result[key] = sortPlainValue(value[key]);
  }
  return result;
}

export function clonePlainJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

export async function setDocumentFlagVerified(document, scope, key, value, documentOptions = {}) {
  const expected = value === undefined ? null : value;
  if (hasDocumentOptions(documentOptions) && typeof document?.update === "function") {
    await document.update({ [`flags.${scope}.${key}`]: expected }, documentOptions);
  } else if (typeof document?.setFlag === "function") {
    await document.setFlag(scope, key, expected);
  } else if (typeof document?.update === "function") {
    await document.update({ [`flags.${scope}.${key}`]: expected });
  } else {
    throw createCodedError("write-unavailable", `Cannot persist flag ${scope}.${key}`);
  }

  const persisted = readDocumentFlag(document, scope, key);
  if (!plainValuesEqual(persisted ?? null, expected ?? null)) {
    throw createCodedError("write-not-persisted", `Flag ${scope}.${key} was not persisted`);
  }
  return true;
}

export async function clearDocumentFlagNullVerified(document, scope, key, documentOptions = {}) {
  const current = readDocumentFlag(document, scope, key);
  if (current == null) return false;

  const update = { [`flags.${scope}.${key}`]: null };
  if (typeof document?.update === "function") {
    await document.update(update, hasDocumentOptions(documentOptions) ? documentOptions : {});
  } else if (typeof document?.setFlag === "function") {
    await document.setFlag(scope, key, null);
  } else {
    throw createCodedError("write-unavailable", `Cannot clear flag ${scope}.${key}`);
  }

  const persisted = readDocumentFlag(document, scope, key);
  if (persisted != null) {
    throw createCodedError("write-not-persisted", `Flag ${scope}.${key} was not cleared`);
  }
  return true;
}
