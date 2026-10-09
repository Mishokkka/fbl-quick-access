import { MODULE_ID, FLAG_SLOTS } from "../constants.js";
import { getQuickCapacity, getStoredSlots, normalizeSlots } from "../quick-access.js";
import { getItemCarryState, getItemWeightValue, isAllowedQuickItem } from "../item-utils.js";
import { canModifyActor } from "../permissions.js";
import { createObjectOperationQueue } from "../operation-queue.js";

export const EQUIPMENT_API_VERSION = 1;
const HANDS_FLAG = "equipmentHands";
const enqueue = createObjectOperationQueue();

function assertActor(actor) {
  if (actor?.documentName !== "Actor" || actor.type !== "character" ||
      typeof actor.getFlag !== "function" || typeof actor.items?.get !== "function") {
    throw new TypeError("Equipment API requires a character Actor document.");
  }
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  if (!canModifyActor(actor) && !actor.testUserPermission?.(game.user, observer)) {
    throw new Error("No permission to view this character's equipment.");
  }
}

function describeItem(item) {
  if (!item) return null;
  return {
    id: item.id, uuid: item.uuid ?? null, name: item.name ?? "",
    img: item.img ?? "icons/svg/item-bag.svg", type: item.type,
    weight: getItemWeightValue(item), carryState: getItemCarryState(item)
  };
}

function readHands(actor) {
  const stored = actor.getFlag(MODULE_ID, HANDS_FLAG);
  const resolve = (id) => typeof id === "string" && actor.items.get(id) ? id : null;
  return { left: resolve(stored?.left), right: resolve(stored?.right) };
}

/** Return detached, serializable equipment data without changing legacy flags. */
export function getEquipmentState(actor) {
  assertActor(actor);
  const { capacity } = getQuickCapacity(actor);
  const stored = normalizeSlots(actor, capacity);
  const hands = readHands(actor);
  const slots = stored.map((value, index) => {
    const itemId = typeof value === "string" && value ? value : null;
    const item = itemId ? actor.items.get(itemId) : null;
    return {
      index, available: index < capacity, itemId, item: describeItem(item),
      missing: Boolean(itemId && !item),
      canHold: Boolean(index < capacity && item && isAllowedQuickItem(item))
    };
  });
  return {
    version: EQUIPMENT_API_VERSION, actorUuid: actor.uuid ?? null,
    editable: canModifyActor(actor), capacity, slots, hands,
    heldItems: {
      left: describeItem(actor.items.get(hands.left)),
      right: describeItem(actor.items.get(hands.right))
    },
    // A comparison token, not a database lock. Include eligibility and capacity.
    revision: JSON.stringify([actor.uuid ?? null, capacity, slots.map(s => [s.itemId, s.missing, s.canHold]), hands])
  };
}

function assertHand(hand, allowBoth = true) {
  if (!["left", "right", ...(allowBoth ? ["both"] : [])].includes(hand)) {
    throw new TypeError("hand must be left, right or both.");
  }
}

function stowItem(hands, itemId) {
  if (!itemId) return;
  for (const hand of ["left", "right"]) if (hands[hand] === itemId) hands[hand] = null;
}

/** Execute a narrow equipment command against live state and normal Actor permissions. */
export async function performEquipmentAction(actor, action, { expectedRevision } = {}) {
  assertActor(actor);
  if (!action || typeof action !== "object") throw new TypeError("Equipment action is required.");
  // Capture the request before waiting in the queue; callers cannot mutate it later.
  const command = { type: action.type, hand: action.hand, itemId: action.itemId, index: action.index };
  return enqueue(actor, async () => {
    assertActor(actor);
    if (!canModifyActor(actor)) throw new Error("No permission to modify this character.");
    const state = getEquipmentState(actor);
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error("Equipment changed. Refresh the snapshot before trying again.");
    }
    const hands = { ...state.hands };
    const update = {};
    switch (command.type) {
      case "hold": {
        assertHand(command.hand);
        if (typeof command.itemId !== "string" || !state.slots.some(s => s.itemId === command.itemId && s.canHold)) {
          throw new Error("Only an existing eligible item in an available Quick Access slot can be held.");
        }
        // Replacing one half of a two-handed grip releases the entire old grip.
        const targets = command.hand === "both" ? ["left", "right"] : [command.hand];
        stowItem(hands, command.itemId);
        for (const hand of targets) stowItem(hands, hands[hand]);
        for (const hand of targets) hands[hand] = command.itemId;
        break;
      }
      case "stow": {
        assertHand(command.hand);
        if (command.hand === "both") hands.left = hands.right = null;
        else stowItem(hands, hands[command.hand]);
        break;
      }
      case "swapHands": {
        [hands.left, hands.right] = [hands.right, hands.left];
        break;
      }
      case "clearSlot": {
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= state.slots.length) {
          throw new RangeError("Invalid Quick Access slot index.");
        }
        const slots = getStoredSlots(actor);
        if (slots[command.index] != null) {
          slots[command.index] = null;
          update[`flags.${MODULE_ID}.${FLAG_SLOTS}`] = slots;
        }
        break;
      }
      default: throw new TypeError("Unknown equipment action.");
    }
    if (JSON.stringify(hands) !== JSON.stringify(state.hands)) {
      update[`flags.${MODULE_ID}.${HANDS_FLAG}`] = hands;
    }
    const changed = Boolean(Object.keys(update).length);
    if (changed) {
      // Foundry can cancel an update without rejecting its Promise.
      const updatedActor = await actor.update(update);
      if (!updatedActor) {
        throw new Error("Equipment update was cancelled. Refresh the snapshot before trying again.");
      }
    }
    return { changed, state: getEquipmentState(actor) };
  });
}

/** Document hooks cover sheet/API/external edits, including render-suppressed writes. */
export function registerEquipmentHooks() {
  const notify = (actor) => {
    if (actor?.documentName === "Actor" && actor.type === "character") {
      Hooks.callAll("fblQuickAccess.equipmentChanged", actor);
    }
  };
  Hooks.on("updateActor", notify);
  for (const name of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(name, (item) => notify(item?.parent));
  }
}
