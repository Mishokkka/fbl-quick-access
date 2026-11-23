import { getProperty } from "../../actor-data.js";
import { getActiveGM } from "../../integration/socket-api.js";
import { MODULE_ID } from "../constants.js";
import { escapeHTML, getActorAttributePath, localize, parseFirstInteger } from "../utils.js";

export function getConditionItem(actor, id) {
  return actor?.items?.get ? actor.items.get(id) : Array.from(actor?.items ?? []).find(item => item.id === id);
}

function conditionValuesEqual(actual, expected) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object"
    || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key =>
    Object.hasOwn(actual, key) && conditionValuesEqual(actual[key], expected[key]));
}

export function verifyConditionWrite(document, update) {
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    const leaf = parts.at(-1);
    const deletion = leaf.startsWith("-=");
    if (deletion) parts[parts.length - 1] = leaf.slice(2);
    if (!document || !conditionValuesEqual(getProperty(document, parts.join(".")), deletion ? undefined : value)) {
      throw new Error(`Condition write was not persisted (${path})`);
    }
  }
}

export async function updateConditionDocument(document, update, options, readLive = () => document) {
  const socket = globalThis.game?.socket;
  const unknown = () => Object.assign(new Error(localize("Notifications.ConditionOutcomeUnknown", "The outcome is unknown. Check the sheet manually before repeating.")), {
    code: "condition-outcome-unknown"
  });
  if (socket?.connected === false) throw unknown();
  const expected = foundry.utils.deepClone(update);
  const watchesDisconnect = typeof socket?.on === "function" && typeof socket?.off === "function";
  let disconnected, onDisconnect;
  if (watchesDisconnect) {
    disconnected = new Promise((_resolve, reject) => { onDisconnect = () => reject(unknown()); });
    socket.on("disconnect", onDisconnect);
  }
  try {
    const write = Promise.resolve().then(() => {
      if (socket?.connected === false) throw unknown();
      return document.update(update, options);
    });
    if (disconnected) await Promise.race([write, disconnected]);
    else await write;
  } finally {
    if (onDisconnect) socket.off("disconnect", onDisconnect);
  }
  verifyConditionWrite(readLive(), expected);
}

export async function applyActorAttributeDamage(actor, damages, options) {
  const update = {};
  const applied = [];
  for (const [attribute, rawAmount] of Object.entries(damages)) {
    const amount = Math.max(0, parseFirstInteger(rawAmount, 0));
    if (!amount) continue;
    const path = getActorAttributePath(actor, attribute);
    const previous = path ? Number(getProperty(actor, path)) : NaN;
    if (!Number.isFinite(previous)) throw new Error(`Missing or invalid ${attribute} value for condition damage`);
    const value = Math.max(0, previous - amount);
    if (value === previous) continue;
    update[path] = value;
    applied.push({ attribute, path, amount, previous, value });
  }
  if (applied.length) await updateConditionDocument(actor, update, options);
  return applied;
}

export function reportPartialConditionWrite(actor, item, damage, cause) {
  const unknown = globalThis.game?.socket?.connected === false || ["timeout", "condition-outcome-unknown", "ETIMEDOUT"].includes(cause?.code);
  const attributes = damage.map(({ attribute, previous, value }) => `${attribute} ${previous} → ${value}`).join(", ");
  const details = { actor: actor.name, item: item.name, attributes };
  const message = unknown
    ? localize("Notifications.ConditionDamageUnknown", "{actor} — {item}: damage was recorded ({attributes}), but the condition update is unconfirmed. Check the sheet manually before repeating.", details)
    : localize("Notifications.ConditionDamagePartial", "{actor} — {item}: damage was recorded ({attributes}), but the condition update failed. Check the sheet manually before repeating.", details);
  globalThis.ui?.notifications?.error?.(escapeHTML(message));
  const gm = getActiveGM() ?? (globalThis.game?.user?.isGM ? game.user : null);
  if (gm && globalThis.game?.socket?.connected !== false && globalThis.ChatMessage?.create) {
    void Promise.resolve().then(() => ChatMessage.create({ content: escapeHTML(message), whisper: [gm.id] }))
      .catch(error => console.error(`${MODULE_ID} | partial condition report failed`, error));
  }
  return Object.assign(new Error(message, { cause }), { notified: true,
    code: unknown ? "condition-outcome-unknown" : "condition-partial-failure" });
}
