import { MODULE_ID, SETTINGS } from "./constants.js";
import { canModifyActor } from "../permissions.js";
import { getActorAttributeState } from "../actor-data.js";
import { escapeHtml } from "../utils.js";

export function localize(key, fallbackOrData = undefined, data = undefined) {
  const fullKey = key.startsWith("FBLEC.") ? key : `FBLEC.${key}`;
  const hasFallback = typeof fallbackOrData === "string";
  const fallback = hasFallback ? fallbackOrData : fullKey;
  const formatData = hasFallback ? data : fallbackOrData;
  const localized = formatData ? game.i18n.format(fullKey, formatData) : game.i18n.localize(fullKey);
  const value = localized && localized !== fullKey ? localized : fallback;
  return interpolateText(value, formatData);
}

function interpolateText(template, data = undefined) {
  if (!data || typeof data !== "object") return template;
  return String(template).replace(/\{([^}]+)\}/g, (match, key) => {
    const value = data[key.trim()];
    return value === undefined || value === null ? match : String(value);
  });
}

export const escapeHTML = escapeHtml;

export function normalizeConditionName(name) {
  return String(name || "").trim().toLocaleLowerCase();
}

export function namesIncludeCondition(names, name) {
  const normalized = normalizeConditionName(name);
  return Array.from(names || []).some(candidate => normalizeConditionName(candidate) === normalized);
}

export function isNamedSpecialCondition(item, definition) {
  if (!item || !definition?.names) return false;
  return namesIncludeCondition(definition.names, item.name);
}

export function clampNumber(value, min, max) {
  const number = Number.isFinite(value) ? value : parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function parseFirstInteger(value, fallback = 0) {
  const match = String(value ?? "").match(/-?\d+/);
  return match ? parseInt(match[0], 10) : fallback;
}

export function parseCounterPair(value, fallbackX = 0, fallbackY = 0) {
  if (value && typeof value === "object") {
    return [
      parseFirstInteger(value.current ?? value.x, fallbackX),
      parseFirstInteger(value.permanent ?? value.y, fallbackY)
    ];
  }
  const [x, y] = String(value ?? "").split("/");
  return [parseFirstInteger(x, fallbackX), parseFirstInteger(y, fallbackY)];
}

export function isPermanentTime(value) {
  return /permanent|постоян/i.test(String(value ?? ""));
}

export function makeCustomCondition(data = {}, fallbackOrder = 0) {
  const parsedOrder = Number(data.order);
  return {
    id: data.id || foundry.utils.randomID(),
    name: data.name ?? "",
    time: data.time ?? "0",
    notes: data.notes ?? "",
    desc: data.desc ?? "",
    order: Number.isFinite(parsedOrder) ? parsedOrder : fallbackOrder
  };
}

export function normalizeCustomConditionList(list) {
  let changed = false;
  const normalized = (Array.isArray(list) ? list : []).map((entry, index) => {
    const condition = makeCustomCondition(entry, index * 10);
    if (!entry?.id || entry?.order === undefined) changed = true;
    return condition;
  });
  return { list: normalized, changed };
}

export function getActorAttributePath(actor, attributeName) {
  const state = getActorAttributeState(actor, attributeName);
  return state.hasValue ? state.valuePath : null;
}

export async function applyActorAttributeDamage(actor, damages = {}, documentOptions = {}) {
  if (!actor || !damages || typeof damages !== "object") return [];

  const update = {};
  const applied = [];

  for (const [attributeName, amountRaw] of Object.entries(damages)) {
    const amount = Math.max(0, parseFirstInteger(amountRaw, 0));
    if (!amount) continue;

    const path = getActorAttributePath(actor, attributeName);
    if (!path) continue;

    const previous = Number(foundry.utils.getProperty(actor, path));
    if (!Number.isFinite(previous)) continue;

    const value = Math.max(0, previous - amount);
    update[path] = value;
    applied.push({ attribute: attributeName, path, amount, previous, value });
  }

  if (Object.keys(update).length) await actor.update(update, documentOptions);
  return applied;
}

export function canUserEditActor(actor) {
  if (game.user.isGM) return true;
  const playersCanEdit = game.settings.get(MODULE_ID, SETTINGS.PLAYERS_CAN_EDIT);
  return Boolean(playersCanEdit && canModifyActor(actor));
}

export function shouldPostChatMessages() {
  return Boolean(game.settings.get(MODULE_ID, SETTINGS.CHAT_MESSAGES));
}

export async function createChatMessage(data) {
  if (!shouldPostChatMessages()) return null;
  return ChatMessage.create(data);
}

export async function rollToMessage(roll, data) {
  if (!shouldPostChatMessages()) return null;
  return roll.toMessage(data);
}
