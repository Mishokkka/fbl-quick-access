import { MODULE_ID, FLAG_SLOTS } from "../constants.js";
import { getQuickCapacity, getStoredSlots, normalizeSlots } from "../quick-access.js";
import { getItemCarryState, getItemWeightValue, isAllowedQuickItem } from "../item-utils.js";
import { canModifyActor } from "../permissions.js";
import { createObjectOperationQueue } from "../operation-queue.js";
import { readEquipmentHands } from "../equipment-hands.js";

export const EQUIPMENT_API_VERSION = 1;
const HANDS_FLAG = "equipmentHands";
const RECEIPTS_FLAG = "equipmentReceipts";
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
  return readEquipmentHands(actor);
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
    inventory: Array.from(actor.items.values()).filter(isAllowedQuickItem).map(describeItem),
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

function captureCommand(action) {
  if (!action || typeof action !== "object") throw new TypeError("Equipment action is required.");
  return Object.fromEntries(["type", "hand", "itemId", "index", "from", "to", "receiptId"]
    .filter(key => action[key] !== undefined).map(key => [key, action[key]]));
}

function receipts(actor) {
  const stored = actor.getFlag(MODULE_ID, RECEIPTS_FLAG);
  return Array.isArray(stored) ? stored : [];
}

/** Read a bounded operation receipt; it is committed in the same write as the grips. */
export function getEquipmentReceipt(actor, id) {
  assertActor(actor);
  const receipt = receipts(actor).find(entry => entry?.id === id);
  return receipt ? structuredClone(receipt) : null;
}

function planCommand(actor, state, command) {
  const hands = { ...state.hands };
  const slots = getStoredSlots(actor);
  const update = {};
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < state.slots.length;
  switch (command.type) {
    case "hold": {
      assertHand(command.hand);
      const item = actor.items.get(command.itemId);
      const held = Object.values(state.hands).includes(command.itemId);
      if (typeof command.itemId !== "string" || !item || !isAllowedQuickItem(item) ||
          (!held && !state.slots.some(s => s.itemId === command.itemId && s.canHold))) {
        throw new Error("Only an existing eligible item in an available Quick Access slot or already held can be held.");
      }
      const targets = command.hand === "both" ? ["left", "right"] : [command.hand];
      stowItem(hands, command.itemId);
      for (const hand of targets) stowItem(hands, hands[hand]);
      for (const hand of targets) hands[hand] = command.itemId;
      break;
    }
    case "stow":
      assertHand(command.hand);
      if (command.hand === "both") hands.left = hands.right = null;
      else stowItem(hands, hands[command.hand]);
      break;
    case "swapHands":
      [hands.left, hands.right] = [hands.right, hands.left];
      break;
    case "clearSlot":
      if (!validIndex(command.index)) throw new RangeError("Invalid Quick Access slot index.");
      if (slots[command.index] != null) slots[command.index] = null;
      break;
    case "assignSlot": {
      if (!validIndex(command.index) || command.index >= state.capacity) throw new RangeError("Invalid available slot index.");
      const item = actor.items.get(command.itemId);
      if (!item || !isAllowedQuickItem(item)) throw new Error("Only an eligible inventory item can be assigned.");
      while (slots.length <= command.index) slots.push(null);
      // Move a binding instead of duplicating the same inventory item.
      for (let index = 0; index < slots.length; index++) if (slots[index] === item.id) slots[index] = null;
      slots[command.index] = item.id;
      break;
    }
    case "swapSlots":
      if (!validIndex(command.from) || !validIndex(command.to) || command.to >= state.capacity) throw new RangeError("Invalid slot indices.");
      while (slots.length <= Math.max(command.from, command.to)) slots.push(null);
      [slots[command.from], slots[command.to]] = [slots[command.to], slots[command.from]];
      break;
    case "undo": {
      const receipt = getEquipmentReceipt(actor, command.receiptId);
      if (!receipt?.changed || receipt.command?.type === "undo") throw new Error("No equipment operation to undo.");
      for (const key of ["hands", "slots"]) {
        if (!(key in receipt.after)) continue;
        const current = key === "hands" ? state.hands : getStoredSlots(actor);
        if (JSON.stringify(current) !== JSON.stringify(receipt.after[key])) throw new Error("Equipment changed since the operation; undo is unsafe.");
        const ids = key === "hands" ? Object.values(receipt.before[key]) : receipt.before[key];
        if (ids.some(id => typeof id === "string" && !actor.items.get(id))) throw new Error("An item was removed; undo is unsafe.");
        if (key === "hands") Object.assign(hands, receipt.before.hands);
        else slots.splice(0, slots.length, ...receipt.before.slots);
      }
      break;
    }
    default: throw new TypeError("Unknown equipment action.");
  }
  if (JSON.stringify(hands) !== JSON.stringify(state.hands)) update[`flags.${MODULE_ID}.${HANDS_FLAG}`] = hands;
  if (JSON.stringify(slots) !== JSON.stringify(getStoredSlots(actor))) update[`flags.${MODULE_ID}.${FLAG_SLOTS}`] = slots;
  return { hands, slots, update, changed: Boolean(Object.keys(update).length) };
}

/** Validate and preview exactly the same transition that the writer will execute. */
export function previewEquipmentAction(actor, action) {
  assertActor(actor);
  const state = getEquipmentState(actor);
  const { hands, slots, changed } = planCommand(actor, state, captureCommand(action));
  return { hands, slots, changed, displaced: [...new Set(Object.values(state.hands))]
    .filter(id => id && !Object.values(hands).includes(id)).map(id => describeItem(actor.items.get(id))) };
}

/** Execute narrow commands, optionally with a durable idempotency receipt. */
export async function performEquipmentAction(actor, action, { expectedRevision, operationId } = {}) {
  assertActor(actor);
  const command = captureCommand(action);
  if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(operationId))) throw new TypeError("Invalid equipment operation id.");
  return enqueue(actor, async () => {
    assertActor(actor);
    if (!canModifyActor(actor)) throw new Error("No permission to modify this character.");
    const previous = operationId ? getEquipmentReceipt(actor, operationId) : null;
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(command)) throw new Error("Operation id was already used for another command.");
      return { changed: previous.changed, state: getEquipmentState(actor), receipt: previous, replayed: true };
    }
    const state = getEquipmentState(actor);
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error("Equipment changed. Refresh the snapshot before trying again.");
    }
    const { hands, slots, update, changed } = planCommand(actor, state, command);
    let receipt = null;
    if (operationId && changed) {
      const before = {}, after = {};
      if (`flags.${MODULE_ID}.${HANDS_FLAG}` in update) { before.hands = state.hands; after.hands = hands; }
      if (`flags.${MODULE_ID}.${FLAG_SLOTS}` in update) { before.slots = getStoredSlots(actor); after.slots = slots; }
      receipt = { id: operationId, command, changed, before, after };
      update[`flags.${MODULE_ID}.${RECEIPTS_FLAG}`] = [...receipts(actor).slice(-31), receipt];
    }
    if (changed) {
      // Foundry can cancel an update without rejecting its Promise.
      const updatedActor = await actor.update(update, { render: false, fblqaEquipmentOnly: true });
      if (!updatedActor) {
        throw new Error("Equipment update was cancelled. Refresh the snapshot before trying again.");
      }
      const saved = getEquipmentState(actor);
      const savedReceipt = operationId ? getEquipmentReceipt(actor, operationId) : null;
      if ((`flags.${MODULE_ID}.${HANDS_FLAG}` in update && JSON.stringify(saved.hands) !== JSON.stringify(hands)) ||
          (`flags.${MODULE_ID}.${FLAG_SLOTS}` in update && JSON.stringify(getStoredSlots(actor)) !== JSON.stringify(slots)) ||
          (receipt && JSON.stringify(savedReceipt) !== JSON.stringify(receipt))) {
        throw new Error("Equipment changed during the update. Refresh the snapshot before trying again.");
      }
    }
    return { changed, state: getEquipmentState(actor), ...(receipt ? { receipt } : {}) };
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
