import { getProperty } from "./actor-data.js";
import { MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { getActiveGM } from "./integration/socket-api.js";
import { escapeHtml } from "./utils.js";

export function isUnknownWriteOutcome(error) {
  return globalThis.game?.socket?.connected === false || [
    "outcome-unknown", "condition-outcome-unknown", "timeout", "ETIMEDOUT", "ECONNRESET", "socket-emit-failed"
  ].includes(error?.code) || error?.name === "TimeoutError" || /\btimed out\b/i.test(error?.message ?? "");
}

export async function runDocumentWrite(write) {
  const socket = globalThis.game?.socket;
  const unknown = () => Object.assign(new Error(qaLocalize("Writes.Unknown", "The outcome is unknown. Check the sheet before trying again.")), {
    code: "outcome-unknown"
  });
  if (socket?.connected === false) throw unknown();
  if (typeof socket?.on !== "function" || typeof socket?.off !== "function") return write();

  let onDisconnect;
  const disconnected = new Promise((_resolve, reject) => { onDisconnect = () => reject(unknown()); });
  socket.on("disconnect", onDisconnect);
  try {
    const writing = Promise.resolve().then(() => {
      if (socket.connected === false) throw unknown();
      return write();
    });
    writing.catch(() => {});
    return await Promise.race([writing, disconnected]);
  } finally {
    socket.off("disconnect", onDisconnect);
  }
}

export function documentValuesEqual(actual, expected) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object"
    || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key =>
    Object.hasOwn(actual, key) && documentValuesEqual(actual[key], expected[key]));
}

export function getDocumentWriteMismatches(document, expected) {
  // ActiveEffects can mask stored system values until the effect is removed.
  const source = document?._source ?? document;
  return Object.entries(expected).filter(([path, value]) =>
    !source || !documentValuesEqual(getProperty(source, path), value)).map(([path]) => path);
}

export function readActorFlag(actor, key) {
  return actor?.getFlag?.(MODULE_ID, key) ?? getProperty(actor?.flags?.[MODULE_ID], key) ?? null;
}

export function whisperToGM(message) {
  if (globalThis.game?.socket?.connected === false || !globalThis.ChatMessage?.create) return;
  const gm = getActiveGM() ?? (globalThis.game?.user?.isGM ? game.user
    : Array.from(globalThis.game?.users ?? []).find(user => user?.isGM));
  if (!gm?.id) return;
  void Promise.resolve().then(() => ChatMessage.create({ content: `<p>${escapeHtml(message)}</p>`, whisper: [gm.id] }))
    .catch(error => console.error(`${MODULE_ID} | could not whisper the write failure to the GM`, error));
}
