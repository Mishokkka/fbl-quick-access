import { MODULE_ID } from "../constants.js";
import {
  clearSocketProof,
  consumeSocketProof,
  createSocketProof,
  scheduleSocketProofCleanup,
  verifySocketProof
} from "../socket-auth.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TYPE = "integration-api-request";
const RESPONSE_TYPE = "integration-api-response";
const REQUEST_PROOF_KIND = "integrationRequest";
const RESPONSE_PROOF_KIND = "integrationResponse";
const DEFAULT_TIMEOUT_MS = 30_000;
const PROOF_GRACE_MS = 60_000;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;

const handlers = new Map();
const pendingRequests = new Map();
let socketRegistered = false;

/**
 * Return the deterministic active GM used by Quick Access integration calls.
 * Foundry can have several active GMs, so every client sorts by user id and
 * selects the same one.
 */
export function getActiveGM(users = globalThis.game?.users) {
  return Array.from(users ?? [])
    .filter((user) => user?.isGM && user?.active)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

/** Register the single generic integration socket listener. */
export function registerIntegrationSocket() {
  if (socketRegistered || !globalThis.game?.socket?.on) return false;
  game.socket.on(SOCKET_CHANNEL, (message) => {
    void handleSocketMessage(message);
  });
  socketRegistered = true;
  return true;
}

/**
 * Register a privileged operation that can be executed by the active GM.
 * Returns an unregister callback. Duplicate operation ids are rejected rather
 * than silently replacing another module's handler.
 */
export function registerSocketHandler(operation, handler) {
  const key = normalizeOperation(operation);
  if (typeof handler !== "function") throw new TypeError(`Socket handler for ${key} must be a function`);
  if (handlers.has(key)) throw new Error(`Quick Access socket operation is already registered: ${key}`);

  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

/**
 * Execute a registered operation on the deterministic active GM. Local GM
 * calls do not make a socket round trip. Remote calls reject on timeout or when
 * the GM-side handler throws.
 */
export async function executeAsActiveGM(operation, payload = {}, options = {}) {
  const key = normalizeOperation(operation);
  const activeGM = getActiveGM();
  if (!activeGM) throw integrationError("no-active-gm", "No active GM is available");

  if (activeGM.id === globalThis.game?.user?.id) {
    return invokeHandler(key, payload, {
      requestId: null,
      requesterId: game.user.id,
      requestUser: game.user,
      activeGM,
      isRemote: false
    });
  }

  if (!globalThis.game?.socket?.emit) {
    throw integrationError("socket-unavailable", "Foundry socket is unavailable");
  }

  registerIntegrationSocket();

  const requestId = makeRequestId();
  const timeoutMs = Math.max(1_000, Number(options?.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const message = {
    type: REQUEST_TYPE,
    requestId,
    operation: key,
    payload: cloneForSocket(payload),
    requesterId: game.user.id,
    activeGMId: activeGM.id,
    createdAt: Date.now()
  };

  try {
    await createSocketProof(REQUEST_PROOF_KIND, requestId, message, game.user);
  } catch (error) {
    throw integrationError(error?.code ?? "identity-proof-failed", `Could not authorize Quick Access GM operation: ${error?.message ?? error}`);
  }

  const response = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingRequests.delete(requestId);
      void clearSocketProof(game.user, REQUEST_PROOF_KIND, requestId);
      reject(integrationError("timeout", `Quick Access GM operation timed out: ${key}`));
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      operation: key,
      activeGMId: activeGM.id
    });
  });

  try {
    game.socket.emit(SOCKET_CHANNEL, message);
  } catch (error) {
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    void clearSocketProof(game.user, REQUEST_PROOF_KIND, requestId);
    if (pending) {
      globalThis.clearTimeout(pending.timeout);
      pending.reject(integrationError("socket-emit-failed", `Could not send Quick Access GM operation: ${error?.message ?? error}`));
    }
  }

  return response;
}

export function hasSocketHandler(operation) {
  try {
    return handlers.has(normalizeOperation(operation));
  } catch (_error) {
    return false;
  }
}

async function handleSocketMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === RESPONSE_TYPE) {
    await handleResponse(message);
    return;
  }

  if (message.type !== REQUEST_TYPE) return;
  if (!isValidRequestMessage(message)) return;
  if (!game.user?.isGM || message.activeGMId !== game.user.id) return;

  // Ignore requests sent to a GM who ceased being the deterministic active GM
  // before the packet arrived.
  const activeGM = getActiveGM();
  if (!activeGM || activeGM.id !== game.user.id) return;

  const requester = findUser(message.requesterId);
  if (!requester?.active) return;

  const proof = verifySocketProof(requester, REQUEST_PROOF_KIND, message.requestId, message, {
    ttlMs: DEFAULT_TIMEOUT_MS + PROOF_GRACE_MS
  });
  if (!proof.ok) return;
  if (!consumeSocketProof(requester.id, REQUEST_PROOF_KIND, message.requestId)) return;
  await clearSocketProof(requester, REQUEST_PROOF_KIND, message.requestId);

  let response;
  try {
    const result = await invokeHandler(message.operation, message.payload, {
      requestId: message.requestId,
      requesterId: requester.id,
      requestUser: requester,
      activeGM,
      isRemote: true
    });
    response = { ok: true, result: cloneForSocket(result) };
  } catch (error) {
    console.error(`${MODULE_ID} | integration socket operation failed`, message.operation, error);
    response = {
      ok: false,
      error: {
        code: String(error?.code ?? "operation-failed"),
        message: String(error?.message ?? error ?? "Operation failed")
      }
    };
  }

  const responseMessage = {
    type: RESPONSE_TYPE,
    requestId: message.requestId,
    recipientId: requester.id,
    activeGMId: game.user.id,
    createdAt: Date.now(),
    ...response
  };

  try {
    await createSocketProof(RESPONSE_PROOF_KIND, message.requestId, responseMessage, game.user);
    scheduleSocketProofCleanup(game.user, RESPONSE_PROOF_KIND, message.requestId, PROOF_GRACE_MS);
    game.socket.emit(SOCKET_CHANNEL, responseMessage);
  } catch (error) {
    console.error(`${MODULE_ID} | integration socket response could not be authenticated`, message.operation, error);
  }
}

async function handleResponse(message) {
  if (!isValidResponseMessage(message)) return;
  if (message.recipientId !== globalThis.game?.user?.id) return;
  const pending = pendingRequests.get(message.requestId);
  if (!pending || message.activeGMId !== pending.activeGMId) return;

  const activeGM = findUser(message.activeGMId);
  if (!activeGM?.isGM || !activeGM.active) return;
  const proof = verifySocketProof(activeGM, RESPONSE_PROOF_KIND, message.requestId, message, {
    ttlMs: DEFAULT_TIMEOUT_MS + PROOF_GRACE_MS
  });
  if (!proof.ok) return;
  if (!consumeSocketProof(activeGM.id, RESPONSE_PROOF_KIND, message.requestId)) return;

  pendingRequests.delete(message.requestId);
  globalThis.clearTimeout(pending.timeout);
  void clearSocketProof(game.user, REQUEST_PROOF_KIND, message.requestId);

  if (message.ok) {
    pending.resolve(message.result);
    return;
  }

  pending.reject(integrationError(
    message.error?.code ?? "operation-failed",
    message.error?.message ?? `Quick Access GM operation failed: ${pending.operation}`
  ));
}

async function invokeHandler(operation, payload, context) {
  const handler = handlers.get(operation);
  if (!handler) throw integrationError("unknown-operation", `Unknown Quick Access socket operation: ${operation}`);
  return handler(payload, Object.freeze({ ...context, operation }));
}

function isValidRequestMessage(message) {
  try {
    normalizeRequestId(message.requestId);
    normalizeOperation(message.operation);
  } catch (_error) {
    return false;
  }
  return typeof message.requesterId === "string"
    && typeof message.activeGMId === "string"
    && Number.isFinite(Number(message.createdAt));
}

function isValidResponseMessage(message) {
  try {
    normalizeRequestId(message.requestId);
  } catch (_error) {
    return false;
  }
  return typeof message.recipientId === "string"
    && typeof message.activeGMId === "string"
    && typeof message.ok === "boolean"
    && Number.isFinite(Number(message.createdAt));
}

function normalizeOperation(operation) {
  const key = String(operation ?? "").trim();
  if (!OPERATION_PATTERN.test(key)) {
    throw new TypeError(`Invalid Quick Access socket operation id: ${key || "<empty>"}`);
  }
  return key;
}

function normalizeRequestId(value) {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{5,127}$/i.test(id)) throw new TypeError(`Invalid Quick Access socket request id: ${id || "<empty>"}`);
  return id;
}

function findUser(id) {
  const users = globalThis.game?.users;
  return users?.get?.(id) ?? Array.from(users ?? []).find((user) => user?.id === id) ?? null;
}

function makeRequestId() {
  if (globalThis.foundry?.utils?.randomID) return foundry.utils.randomID(24);
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneForSocket(value) {
  if (value === undefined) return null;
  if (globalThis.foundry?.utils?.deepClone) {
    try {
      return foundry.utils.deepClone(value);
    } catch (_error) {
      // Fall through to JSON cloning for plain integration payloads.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw integrationError("non-serializable-payload", `Integration payload is not serializable: ${error?.message ?? error}`);
  }
}

function integrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
