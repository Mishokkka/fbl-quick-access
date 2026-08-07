import { MODULE_ID } from "./constants.js";

const PROOF_ROOT = "socketProofs";
const DEFAULT_TTL_MS = 2 * 60_000;
const CONSUMED_LIMIT = 500;
const PROOF_KIND_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,127}$/i;

const consumedProofs = new Set();
const consumedProofOrder = [];

/**
 * Persist a one-time socket proof on the current User document.
 *
 * Foundry's native module socket does not provide an authenticated sender to
 * listeners. A User document update does: the server only accepts it from the
 * user who may update that document (or a GM). Privileged socket handlers must
 * therefore validate a matching proof instead of trusting ids in the packet.
 */
export async function createSocketProof(kind, requestId, payload, user = globalThis.game?.user) {
  const normalizedKind = normalizeKind(kind);
  const normalizedRequestId = normalizeRequestId(requestId);
  if (!user?.setFlag) throw socketProofError("proof-user-unavailable", "Socket identity proof requires a User document");

  const proof = {
    userId: String(user.id ?? ""),
    createdAt: Date.now(),
    payload: clonePlain(payload)
  };
  await user.setFlag(MODULE_ID, `${PROOF_ROOT}.${normalizedKind}.${normalizedRequestId}`, proof);
  return proof;
}

/** Validate that a packet payload was authorized by the claimed User. */
export function verifySocketProof(user, kind, requestId, expectedPayload, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const normalizedKind = normalizeKind(kind);
  const normalizedRequestId = normalizeRequestId(requestId);
  if (!user?.getFlag || !user.id) return { ok: false, error: "proof-user-unavailable" };

  const proof = user.getFlag(MODULE_ID, `${PROOF_ROOT}.${normalizedKind}.${normalizedRequestId}`);
  if (!proof || typeof proof !== "object") return { ok: false, error: "proof-missing" };
  if (String(proof.userId ?? "") !== String(user.id)) return { ok: false, error: "proof-user-mismatch" };

  const createdAt = Number(proof.createdAt);
  const age = Date.now() - createdAt;
  if (!Number.isFinite(createdAt) || age < -5_000 || age > Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS)) {
    return { ok: false, error: "proof-expired" };
  }

  if (!plainValuesEqual(proof.payload, expectedPayload)) return { ok: false, error: "proof-payload-mismatch" };
  return { ok: true, proof };
}

/**
 * Mark a proof as consumed on this client before awaiting any work. The active
 * GM uses this to make replays and duplicate socket delivery idempotent.
 */
export function consumeSocketProof(userId, kind, requestId) {
  const key = `${String(userId ?? "")}:${normalizeKind(kind)}:${normalizeRequestId(requestId)}`;
  if (consumedProofs.has(key)) return false;
  consumedProofs.add(key);
  consumedProofOrder.push(key);
  while (consumedProofOrder.length > CONSUMED_LIMIT) {
    consumedProofs.delete(consumedProofOrder.shift());
  }
  return true;
}

export async function clearSocketProof(user, kind, requestId) {
  if (!user?.unsetFlag) return false;
  try {
    await user.unsetFlag(MODULE_ID, `${PROOF_ROOT}.${normalizeKind(kind)}.${normalizeRequestId(requestId)}`);
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not clear socket proof`, kind, requestId, error);
    return false;
  }
}

export function scheduleSocketProofCleanup(user, kind, requestId, delayMs = DEFAULT_TTL_MS) {
  const timeout = Math.max(1_000, Number(delayMs) || DEFAULT_TTL_MS);
  const handle = globalThis.setTimeout?.(() => {
    void clearSocketProof(user, kind, requestId);
  }, timeout) ?? null;
  handle?.unref?.();
  return handle;
}

export function getSocketProofPayload(message, omittedKeys = ["packetId"]) {
  if (!message || typeof message !== "object") return {};
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(Object.entries(message)
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => [key, clonePlain(value)]));
}

function normalizeKind(value) {
  const kind = String(value ?? "").trim();
  if (!PROOF_KIND_PATTERN.test(kind)) throw socketProofError("invalid-proof-kind", `Invalid socket proof kind: ${kind || "<empty>"}`);
  return kind;
}

function normalizeRequestId(value) {
  const id = String(value ?? "").trim();
  if (!REQUEST_ID_PATTERN.test(id)) throw socketProofError("invalid-request-id", `Invalid socket request id: ${id || "<empty>"}`);
  return id;
}

function clonePlain(value) {
  if (value === undefined) return null;
  if (globalThis.foundry?.utils?.deepClone) {
    try {
      return foundry.utils.deepClone(value);
    } catch (_error) {
      // Continue with JSON cloning for socket-safe values.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw socketProofError("non-serializable-payload", `Socket proof payload is not serializable: ${error?.message ?? error}`);
  }
}

function plainValuesEqual(a, b) {
  if (globalThis.foundry?.utils?.objectsEqual) {
    try {
      return foundry.utils.objectsEqual(a, b);
    } catch (_error) {
      // Fall through to canonical JSON comparison.
    }
  }
  return canonicalStringify(a) === canonicalStringify(b);
}

function canonicalStringify(value) {
  return JSON.stringify(sortPlainValue(value));
}

function sortPlainValue(value) {
  if (Array.isArray(value)) return value.map(sortPlainValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortPlainValue(value[key])]));
}

function socketProofError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
