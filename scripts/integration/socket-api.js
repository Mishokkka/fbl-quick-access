import { MODULE_ID } from "../constants.js";
import {
  clearSocketProof,
  consumeSocketProof,
  createSocketProof,
  scheduleSocketProofCleanup,
  verifySocketProofWithRetry
} from "../socket-auth.js";
import { findGameUser, makeSocketRequestId, normalizeSocketRequestId } from "../socket-utils.js";
import { enqueueActorMutation } from "../operation-queue.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TYPE = "integration-api-request";
const RESPONSE_TYPE = "integration-api-response";
const REQUEST_PROOF_KIND = "integrationRequest";
const RESPONSE_PROOF_KIND = "integrationResponse";
const DEFAULT_TIMEOUT_MS = 30_000;
const PROOF_GRACE_MS = 60_000;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;

const handlers = new Map();
const addressedOperations = new Set();
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
  game.socket.on(SOCKET_CHANNEL, (message, senderId) => {
    void handleSocketMessage(message, senderId);
  });
  socketRegistered = true;
  return true;
}

/**
 * Register a privileged operation that can be executed by the active GM.
 * Returns an unregister callback. Duplicate operation ids are rejected rather
 * than silently replacing another module's handler.
 */
export function registerSocketHandler(operation, handler, { addressed = false } = {}) {
  const key = normalizeOperation(operation);
  if (typeof handler !== "function") throw new TypeError(`Socket handler for ${key} must be a function`);
  if (handlers.has(key)) throw new Error(`Quick Access socket operation is already registered: ${key}`);

  handlers.set(key, handler);
  if (addressed) addressedOperations.add(key);
  return () => {
    if (handlers.get(key) === handler) {
      handlers.delete(key);
      addressedOperations.delete(key);
    }
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

  const socket = globalThis.game?.socket;
  if (!socket?.emit) {
    throw integrationError("socket-unavailable", "Foundry socket is unavailable");
  }
  if (socket.connected === false) throw integrationError("socket-unavailable", "Foundry socket is disconnected");

  registerIntegrationSocket();

  const requestId = makeSocketRequestId();
  const addressed = addressedOperations.has(key);
  const requester = game.user;
  const timeoutMs = Math.max(1_000, Number(options?.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const message = {
    type: REQUEST_TYPE,
    requestId,
    operation: key,
    payload: cloneForSocket(payload),
    requesterId: requester.id,
    activeGMId: activeGM.id,
    createdAt: Date.now()
  };

  const rejectRequest = error => finishPendingRequest(requestId)?.reject(error);
  const disconnected = () => integrationError("outcome-unknown", `Foundry disconnected during ${key}`);
  const response = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      rejectRequest(integrationError("timeout", `Quick Access GM operation timed out: ${key}`));
    }, timeoutMs);
    const onDisconnect = typeof socket.on === "function" && typeof socket.off === "function"
      ? () => rejectRequest(disconnected())
      : null;
    pendingRequests.set(requestId, {
      resolve, reject, timeout, addressed, socket, onDisconnect, proofWritten: false,
      operation: key, activeGMId: activeGM.id, requester
    });
    if (onDisconnect) socket.on("disconnect", onDisconnect);
  });

  const sendRequest = () => {
    if (socket.connected === false) {
      rejectRequest(disconnected());
      return;
    }
    try {
      if (addressed) socket.emit(SOCKET_CHANNEL, message, { recipients: [activeGM.id] });
      else socket.emit(SOCKET_CHANNEL, message);
    } catch (error) {
      rejectRequest(integrationError("socket-emit-failed", `Could not send Quick Access GM operation: ${error?.message ?? error}`));
    }
  };

  if (addressed) sendRequest();
  else {
    void createSocketProof(REQUEST_PROOF_KIND, requestId, message, requester).then(() => {
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        // The flag write can finish after the request has already been cancelled.
        void clearSocketProof(requester, REQUEST_PROOF_KIND, requestId);
        return;
      }
      pending.proofWritten = true;
      sendRequest();
    }, error => {
      rejectRequest(integrationError(error?.code ?? "identity-proof-failed", `Could not authorize Quick Access GM operation: ${error?.message ?? error}`));
    });
  }

  return response;
}

function finishPendingRequest(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return null;
  pendingRequests.delete(requestId);
  globalThis.clearTimeout(pending.timeout);
  if (pending.onDisconnect) pending.socket.off("disconnect", pending.onDisconnect);
  if (pending.proofWritten) void clearSocketProof(pending.requester, REQUEST_PROOF_KIND, requestId);
  return pending;
}

export function hasSocketHandler(operation) {
  try {
    return handlers.has(normalizeOperation(operation));
  } catch (_error) {
    return false;
  }
}

/** Route an Actor operation to the active GM or serialize it locally for an owner. */
export async function executeActorOperation(actor, operation, payload, apply) {
  const remoteGM = () => {
    const gm = getActiveGM();
    return gm && gm.id !== game.user?.id;
  };
  const request = { ...payload, actorUuid: actor.uuid, actorId: actor.id };
  if (!remoteGM()) {
    const reroute = Symbol("active GM changed");
    const result = await enqueueActorMutation(actor, () => {
      if (remoteGM()) return reroute;
      const isWorldActor = !actor.isToken && (!actor.uuid || actor.uuid === `Actor.${actor.id}`);
      const live = isWorldActor && game.actors?.get ? game.actors.get(actor.id) : actor;
      if (!live) throw integrationError("missing-actor", "The Actor was removed");
      if (live.pack || (!game.user?.isGM && !live.isOwner)) throw integrationError("no-actor-permission", "Actor changes require ownership");
      return apply(live, payload, game.user);
    });
    if (result !== reroute) return result;
  }
  return executeAsActiveGM(operation, request);
}

/** Authenticate and resolve the live document once the Actor's turn begins. */
export function handleActorOperation(payload, context, apply, { characterOnly = true } = {}) {
  const reference = payload?.actorUuid || payload?.actorId;
  if (typeof reference !== "string" || !reference) throw new TypeError("Missing Actor reference");
  return enqueueActorMutation(reference, async () => {
    const worldActorId = payload.actorUuid ? /^Actor\.([^.]+)$/.exec(reference)?.[1] : reference;
    const actor = worldActorId && game.actors?.get
      ? game.actors.get(worldActorId)
      : await globalThis.fromUuid?.(reference);
    const user = context.requestUser;
    const ownsActor = typeof actor?.testUserPermission === "function"
      ? actor.testUserPermission(user, "OWNER")
      : Number(actor?.ownership?.[user?.id] ?? actor?.ownership?.default ?? 0) >= 3;
    if (!actor || actor.pack || actor.documentName !== "Actor" || (characterOnly && actor.type !== "character")
      || !user || user.active === false || (!user.isGM && !ownsActor)) {
      throw integrationError("no-actor-permission", characterOnly ? "Actor changes require ownership of a character" : "Actor changes require ownership");
    }
    if (context.activeGM && getActiveGM()?.id !== game.user?.id) {
      throw integrationError("no-active-gm", "The active GM changed");
    }
    return apply(actor, payload, user);
  });
}

async function handleSocketMessage(message, senderId) {
  if (!message || typeof message !== "object") return;

  if (message.type === RESPONSE_TYPE) {
    await handleResponse(message, senderId);
    return;
  }

  if (message.type !== REQUEST_TYPE) return;
  if (!isValidRequestMessage(message)) return;
  if (!game.user?.isGM || message.activeGMId !== game.user.id) return;

  // Ignore requests sent to a GM who ceased being the deterministic active GM
  // before the packet arrived.
  const activeGM = getActiveGM();
  if (!activeGM || activeGM.id !== game.user.id) return;

  const requester = findGameUser(message.requesterId);
  if (!requester?.active) return;

  const addressed = addressedOperations.has(message.operation);
  if (addressed) {
    // Foundry v13 appends the sender id on the server, outside the payload.
    if (senderId !== requester.id) return;
  } else {
    const proof = await verifySocketProofWithRetry(requester, REQUEST_PROOF_KIND, message.requestId, message, {
      ttlMs: DEFAULT_TIMEOUT_MS + PROOF_GRACE_MS
    });
    if (!proof.ok) return;
  }
  if (!consumeSocketProof(requester.id, REQUEST_PROOF_KIND, message.requestId)) return;
  if (!addressed) await clearSocketProof(requester, REQUEST_PROOF_KIND, message.requestId);

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
    if (Array.isArray(error?.appliedDamage)) response.error.appliedDamage = cloneForSocket(error.appliedDamage);
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
    if (addressed) game.socket.emit(SOCKET_CHANNEL, responseMessage, { recipients: [requester.id] });
    else {
      await createSocketProof(RESPONSE_PROOF_KIND, message.requestId, responseMessage, game.user);
      scheduleSocketProofCleanup(game.user, RESPONSE_PROOF_KIND, message.requestId, PROOF_GRACE_MS);
      game.socket.emit(SOCKET_CHANNEL, responseMessage);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | integration socket response could not be authenticated`, message.operation, error);
  }
}

async function handleResponse(message, senderId) {
  if (!isValidResponseMessage(message)) return;
  if (message.recipientId !== globalThis.game?.user?.id) return;
  const pending = pendingRequests.get(message.requestId);
  if (!pending || message.activeGMId !== pending.activeGMId) return;

  const activeGM = findGameUser(message.activeGMId);
  if (!activeGM?.isGM || !activeGM.active) return;
  if (pending.addressed) {
    if (senderId !== activeGM.id) return;
  } else {
    const proof = await verifySocketProofWithRetry(activeGM, RESPONSE_PROOF_KIND, message.requestId, message, {
      ttlMs: DEFAULT_TIMEOUT_MS + PROOF_GRACE_MS
    });
    if (!proof.ok) return;
  }
  if (!consumeSocketProof(activeGM.id, RESPONSE_PROOF_KIND, message.requestId)) return;

  if (!finishPendingRequest(message.requestId)) return;

  if (message.ok) {
    pending.resolve(message.result);
    return;
  }

  const error = integrationError(
    message.error?.code ?? "operation-failed",
    message.error?.message ?? `Quick Access GM operation failed: ${pending.operation}`
  );
  if (Array.isArray(message.error?.appliedDamage)) error.appliedDamage = message.error.appliedDamage;
  pending.reject(error);
}

async function invokeHandler(operation, payload, context) {
  const handler = handlers.get(operation);
  if (!handler) throw integrationError("unknown-operation", `Unknown Quick Access socket operation: ${operation}`);
  return handler(payload, Object.freeze({ ...context, operation }));
}

function isValidRequestMessage(message) {
  try {
    normalizeSocketRequestId(message.requestId);
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
    normalizeSocketRequestId(message.requestId);
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
