import { MODULE_ID } from "./constants.js";

/** Resolve manual grips without repairing or writing legacy data during reads. */
export function readEquipmentHands(actor) {
  const stored = actor.getFlag(MODULE_ID, "equipmentHands");
  const resolve = id => typeof id === "string" && actor.items.get(id) ? id : null;
  return { left: resolve(stored?.left), right: resolve(stored?.right) };
}

export function getEquipmentGrip(actor, itemId) {
  const hands = readEquipmentHands(actor);
  return hands.left === itemId && hands.right === itemId ? "2Р"
    : hands.left === itemId ? "Л" : hands.right === itemId ? "П" : "";
}
