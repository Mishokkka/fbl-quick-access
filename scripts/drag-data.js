import { MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";

export function readDropData(event, { warn = true } = {}) {
  const foundryData = normalizeDropData(readFoundryDropData(event));
  if (foundryData) return foundryData;

  for (const type of ["application/json", "text/plain"]) {
    const raw = event?.dataTransfer?.getData?.(type);
    if (!raw) continue;

    try {
      return normalizeDropData(JSON.parse(raw));
    } catch (error) {
      if (warn) console.warn(`${MODULE_ID} | could not parse ${type} drop data`, raw, error);
    }
  }

  return null;
}

export function readFoundryDropData(event) {
  if (!globalThis.TextEditor?.getDragEventData) return null;

  try {
    const data = TextEditor.getDragEventData(event);
    return data && typeof data === "object" ? data : null;
  } catch (_error) {
    return null;
  }
}

export function normalizeDropData(data) {
  if (!data || typeof data !== "object") return null;

  const normalized = {
    ...data,
    type: data.type ?? (data.uuid || data.itemId || data.id ? "Item" : ""),
    id: data.id ?? data.itemId ?? "",
    itemId: data.itemId ?? data.id ?? "",
    itemUuid: data.itemUuid ?? data.uuid ?? "",
    uuid: data.uuid ?? data.itemUuid ?? "",
    actorId: data.actorId ?? "",
    actorUuid: data.actorUuid ?? "",
    slotIndex: data.slotIndex,
    fblqaGearOrder: data.fblqaGearOrder === true
  };

  return normalized.type ? normalized : null;
}

export function isItemDropData(data) {
  return Boolean(data && (data.type === "Item" || data.uuid || data.itemId || data.id));
}

export function getDroppedItemId(data) {
  if (!data) return "";
  return data.itemId ?? data.id ?? "";
}

export async function resolveDroppedItem(actor, data, { sameActorOnly = true, warn = true } = {}) {
  if (!isItemDropData(data)) return null;

  if (data.uuid) {
    const document = await fromUuid(data.uuid);
    if (document?.documentName === "Item") {
      if (!sameActorOnly || document.parent?.uuid === actor?.uuid) return document;
      if (warn) ui.notifications?.warn(qaLocalize("Drag.SameActorOnly", "Перетащи предмет из инвентаря этого же персонажа."));
      return null;
    }
  }

  const itemId = getDroppedItemId(data);
  if (itemId && actor?.items?.get?.(itemId)) return actor.items.get(itemId);

  if (warn) ui.notifications?.warn(qaLocalize("Drag.UnrecognizedItem", "Не удалось распознать предмет. Перетащи строку предмета из Gear этого персонажа."));
  return null;
}
