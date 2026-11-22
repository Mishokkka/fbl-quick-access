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
  const result = Object.create(null);
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

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function flagReplaceUpdatePath(scope, key) {
  const parts = String(key).split(".");
  const leaf = parts.pop();
  return ["flags", scope, ...parts, `==${leaf}`].join(".");
}

/**
 * Deterministic, opaque revision token for action preconditions.
 * Avoids transmitting raw actor injury/condition/addiction text over shared
 * module sockets or storing it in User proof flags while preserving exact
 * stale-preview detection.
 */
export function opaquePreconditionToken(value) {
  const serialized = canonicalJson(value ?? null) ?? "null";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ serialized.length;
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (code + ((i * 31) & 0xffff));
    h2 = Math.imul(h2, 0x85ebca6b);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 16;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  return `rev:${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export async function setDocumentFlagVerified(document, scope, key, value, documentOptions = {}, { replace = false } = {}) {
  const expected = clonePlainJson(value);
  const payload = clonePlainJson(expected);
  const shouldReplace = Boolean(replace && isPlainObject(expected));
  if (shouldReplace && typeof document?.update === "function") {
    const update = { [flagReplaceUpdatePath(scope, key)]: payload };
    if (hasDocumentOptions(documentOptions)) await document.update(update, documentOptions);
    else await document.update(update);
  } else if (hasDocumentOptions(documentOptions) && typeof document?.update === "function") {
    await document.update({ [`flags.${scope}.${key}`]: payload }, documentOptions);
  } else if (typeof document?.setFlag === "function") {
    await document.setFlag(scope, key, payload);
  } else if (typeof document?.update === "function") {
    await document.update({ [`flags.${scope}.${key}`]: payload });
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
