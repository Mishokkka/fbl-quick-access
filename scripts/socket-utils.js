const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,127}$/i;

export function normalizeSocketRequestId(value) {
  const id = String(value ?? "").trim();
  if (!REQUEST_ID_PATTERN.test(id)) {
    const error = new TypeError(`Invalid Quick Access socket request id: ${id || "<empty>"}`);
    error.code = "invalid-request-id";
    throw error;
  }
  return id;
}

export function isValidSocketRequestId(value) {
  try {
    normalizeSocketRequestId(value);
    return true;
  } catch (_error) {
    return false;
  }
}

export function makeSocketRequestId(length = 24) {
  const randomID = globalThis.foundry?.utils?.randomID;
  if (typeof randomID === "function") return normalizeSocketRequestId(randomID(Math.max(6, Math.floor(Number(length) || 24))));

  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return normalizeSocketRequestId(uuid);

  return normalizeSocketRequestId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

export function findGameUser(id, users = globalThis.game?.users) {
  return users?.get?.(id) ?? Array.from(users ?? []).find((user) => user?.id === id) ?? null;
}
