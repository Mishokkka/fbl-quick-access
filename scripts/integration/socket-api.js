import { MODULE_ID } from "../constants.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TYPE = "integration-api-request";
const RESPONSE_TYPE = "integration-api-response";
const DEFAULT_TIMEOUT_MS = 30_000;
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
  const response = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(integrationError("timeout", `Quick Access GM operation timed out: ${key}`));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timeout, operation: key });
  });

  game.socket.emit(SOCKET_CHANNEL, {
    type: REQUEST_TYPE,
    requestId,
    operation: key,
    payload: cloneForSocket(payload),
    requesterId: game.user.id,
    activeGMId: activeGM.id,
    createdAt: Date.now()
  });

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
    handleResponse(message);
    return;
  }

  if (message.type !== REQUEST_TYPE) return;
  if (!game.user?.isGM || message.activeGMId !== game.user.id) return;

  // Ignore requests sent to a GM who ceased being the deterministic active GM
  // before the packet arrived.
  const activeGM = getActiveGM();
  if (!activeGM || activeGM.id !== game.user.id) return;

  const requester = game.users?.get?.(message.requesterId) ?? null;
  let response;
  try {
    const result = await invokeHandler(message.operation, message.payload, {
      requestId: message.requestId,
      requesterId: message.requesterId,
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

  game.socket.emit(SOCKET_CHANNEL, {
    type: RESPONSE_TYPE,
    requestId: message.requestId,
    recipientId: message.requesterId,
    activeGMId: game.user.id,
    ...response
  });
}

function handleResponse(message) {
  if (message.recipientId !== globalThis.game?.user?.id) return;
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;

  pendingRequests.delete(message.requestId);
  globalThis.clearTimeout(pending.timeout);

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

function normalizeOperation(operation) {
  const key = String(operation ?? "").trim();
  if (!OPERATION_PATTERN.test(key)) {
    throw new TypeError(`Invalid Quick Access socket operation id: ${key || "<empty>"}`);
  }
  return key;
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
