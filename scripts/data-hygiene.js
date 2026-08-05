import { FLAG_GEAR_ORDER, FLAG_SLOTS, MODULE_ID } from "./constants.js";

export function pruneQuickAccessReferences(slots, existingIds) {
  const ids = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  return (Array.isArray(slots) ? slots : []).map((id) => (typeof id === "string" && ids.has(id) ? id : null));
}

export function pruneGearOrderReferences(order, existingIds) {
  const ids = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const seen = new Set();
  return (Array.isArray(order) ? order : []).filter((id) => {
    if (typeof id !== "string" || !id || !ids.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export async function pruneActorReferences(actor) {
  if (!actor?.items || typeof actor.getFlag !== "function" || typeof actor.setFlag !== "function") {
    return { changed: false, slotsChanged: false, orderChanged: false };
  }

  const existingIds = new Set(Array.from(actor.items, (item) => item.id).filter(Boolean));
  const slots = actor.getFlag(MODULE_ID, FLAG_SLOTS);
  const order = actor.getFlag(MODULE_ID, FLAG_GEAR_ORDER);
  const nextSlots = pruneQuickAccessReferences(slots, existingIds);
  const nextOrder = pruneGearOrderReferences(order, existingIds);
  const slotsChanged = JSON.stringify(Array.isArray(slots) ? slots : []) !== JSON.stringify(nextSlots);
  const orderChanged = JSON.stringify(Array.isArray(order) ? order : []) !== JSON.stringify(nextOrder);

  if (slotsChanged) await actor.setFlag(MODULE_ID, FLAG_SLOTS, nextSlots);
  if (orderChanged) await actor.setFlag(MODULE_ID, FLAG_GEAR_ORDER, nextOrder);

  return { changed: slotsChanged || orderChanged, slotsChanged, orderChanged };
}

export async function pruneWorldActorReferences() {
  if (!game.user?.isGM) return { actorsChecked: 0, actorsChanged: 0 };

  let actorsChecked = 0;
  let actorsChanged = 0;
  for (const actor of game.actors ?? []) {
    if (actor?.type !== "character") continue;
    actorsChecked += 1;
    const result = await pruneActorReferences(actor);
    if (result.changed) actorsChanged += 1;
  }
  return { actorsChecked, actorsChanged };
}

export async function handleDeletedActorItem(item, options, userId) {
  if (userId && game.user?.id !== userId) return;
  const actor = item?.parent;
  if (actor?.documentName !== "Actor" || actor.type !== "character") return;
  await pruneActorReferences(actor);
}
