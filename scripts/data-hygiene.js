import { FLAG_GEAR_ORDER, FLAG_SLOTS, MODULE_ID } from "./constants.js";
import { getActiveGM } from "./integration/socket-api.js";

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
  if (!actor?.items || typeof actor.getFlag !== "function") {
    return { changed: false, slotsChanged: false, orderChanged: false };
  }

  // Most actors never use either presentation flag. Read the tiny flags first so
  // world startup does not enumerate every embedded Item for those actors.
  const slots = actor.getFlag(MODULE_ID, FLAG_SLOTS);
  const order = actor.getFlag(MODULE_ID, FLAG_GEAR_ORDER);
  const hasSlotReferences = Array.isArray(slots) && slots.some((id) => typeof id === "string" && id);
  const hasOrderReferences = Array.isArray(order) && order.some((id) => typeof id === "string" && id);

  // With no actual Item ids we can still normalize malformed legacy values
  // without touching actor.items at all. This keeps the old hygiene semantics
  // while preserving the fast startup path for the common case.
  if (!hasSlotReferences && !hasOrderReferences) {
    const nextSlots = pruneQuickAccessReferences(slots, new Set());
    const nextOrder = pruneGearOrderReferences(order, new Set());
    return persistPrunedActorReferences(actor, slots, order, nextSlots, nextOrder);
  }

  const existingIds = new Set(Array.from(actor.items, (item) => item.id).filter(Boolean));
  const nextSlots = pruneQuickAccessReferences(slots, existingIds);
  const nextOrder = pruneGearOrderReferences(order, existingIds);
  return persistPrunedActorReferences(actor, slots, order, nextSlots, nextOrder);
}

async function persistPrunedActorReferences(actor, slots, order, nextSlots, nextOrder) {
  const slotsChanged = JSON.stringify(Array.isArray(slots) ? slots : []) !== JSON.stringify(nextSlots);
  const orderChanged = JSON.stringify(Array.isArray(order) ? order : []) !== JSON.stringify(nextOrder);

  if (slotsChanged || orderChanged) {
    if (typeof actor.update === "function") {
      const updateData = {};
      if (slotsChanged) updateData[`flags.${MODULE_ID}.${FLAG_SLOTS}`] = nextSlots;
      if (orderChanged) updateData[`flags.${MODULE_ID}.${FLAG_GEAR_ORDER}`] = nextOrder;
      // These flags only remove references to Items that are already gone. The
      // Item deletion itself performs the user-visible render, and ready-time
      // maintenance has no open UI to refresh.
      await actor.update(updateData, { render: false });
    } else if (typeof actor.setFlag === "function") {
      // Compatibility fallback for lightweight test doubles / unusual Actor wrappers.
      if (slotsChanged) await actor.setFlag(MODULE_ID, FLAG_SLOTS, nextSlots);
      if (orderChanged) await actor.setFlag(MODULE_ID, FLAG_GEAR_ORDER, nextOrder);
    }
  }

  return { changed: slotsChanged || orderChanged, slotsChanged, orderChanged };
}

export async function pruneWorldActorReferences() {
  const activeGM = getActiveGM();
  if (!game.user?.isGM || activeGM?.id !== game.user.id) {
    return { actorsChecked: 0, actorsChanged: 0 };
  }

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
