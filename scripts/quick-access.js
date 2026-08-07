import { FLAG_SLOTS, MAX_SLOTS, MODULE_ID } from "./constants.js";
import { readDropData, resolveDroppedItem } from "./drag-data.js";
import { getItemWeightLabel, isAllowedQuickItem, isQuickAccessItemType } from "./item-utils.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { getActorAttributeMaximum } from "./actor-data.js";
import { firstFiniteNumber, rerenderSheet } from "./utils.js";

export function getQuickCapacity(actor) {
  const system = actor.system ?? {};

  const agilityMax = getActorAttributeMaximum(actor, "agility");

  const sleightOfHand = firstFiniteNumber(
    system.skill?.["sleight-of-hand"]?.value,
    system.skills?.["sleight-of-hand"]?.value,
    system.skill?.sleightOfHand?.value,
    system.skills?.sleightOfHand?.value,
    0
  );

  const rawCapacity = Math.floor(agilityMax + sleightOfHand);
  const capacity = Math.min(MAX_SLOTS, Math.max(0, rawCapacity));

  return { capacity, agilityMax, sleightOfHand };
}

export function getStoredSlots(actor) {
  const value = actor.getFlag(MODULE_ID, FLAG_SLOTS);
  return Array.isArray(value) ? value.map((entry) => entry ?? null) : [];
}

export function normalizeSlots(actor, capacity) {
  const stored = getStoredSlots(actor);
  const normalized = [...stored];

  while (normalized.length < capacity) normalized.push(null);

  return normalized;
}

export async function saveSlots(actor, slots) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  await actor.setFlag(MODULE_ID, FLAG_SLOTS, slots.map((entry) => entry ?? null));
}

async function removeSlot(actor, index) {
  const slots = getStoredSlots(actor);
  slots[index] = null;
  await saveSlots(actor, slots);
}

export function buildSlots(app, actor, capacity, storedSlots) {
  const slotsWrap = document.createElement("div");
  slotsWrap.classList.add("fblqa-slots");
  slotsWrap.title = qaLocalize("QuickAccess.Title", "Быстрый доступ: {capacity}/{maxSlots} слотов", { capacity, maxSlots: MAX_SLOTS });

  // Keep large quick-access bars balanced. Without an explicit column count,
  // flex-wrap can produce 6/4 at ten slots. Five and five reads better.
  const columns = getQuickSlotColumns(capacity);
  if (columns > 0) slotsWrap.style.setProperty("--fblqa-slot-columns", String(columns));
  if (capacity > 6) slotsWrap.classList.add("fblqa-slots-balanced");

  for (let index = 0; index < capacity; index += 1) {
    const itemId = storedSlots[index] ?? null;
    const item = itemId ? actor.items.get(itemId) : null;
    slotsWrap.append(buildSlot(app, actor, index, itemId, item));
  }

  if (capacity === 0) {
    const empty = document.createElement("p");
    empty.classList.add("fblqa-zero");
    empty.textContent = qaLocalize("QuickAccess.NoSlots", "Нет слотов. Проверь Agility и Sleight of Hand.");
    slotsWrap.append(empty);
  }

  return slotsWrap;
}


function getQuickSlotColumns(capacity) {
  if (capacity <= 0) return 0;
  if (capacity <= 6) return capacity;
  return Math.ceil(capacity / 2);
}

function buildSlot(app, actor, index, itemId, item) {
  const slot = document.createElement("div");
  slot.classList.add("fblqa-slot");
  slot.dataset.slotIndex = String(index);

  const canModify = canModifyActor(actor);

  if (canModify) {
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      slot.classList.add("fblqa-drop-target");
    });

    slot.addEventListener("dragleave", () => {
      slot.classList.remove("fblqa-drop-target");
    });

    slot.addEventListener("drop", async (event) => {
      event.preventDefault();
      slot.classList.remove("fblqa-drop-target");
      await handleDrop(app, actor, event, index);
    });
  }

  if (!itemId) {
    const label = document.createElement("span");
    label.classList.add("fblqa-empty");
    label.textContent = qaLocalize("QuickAccess.Empty", "Пусто");
    slot.append(label);
    return slot;
  }

  if (!item) {
    slot.classList.add("fblqa-missing");

    const label = document.createElement("span");
    label.classList.add("fblqa-missing-label");
    label.textContent = qaLocalize("QuickAccess.ItemDeleted", "Предмет удалён");

    const removeButton = makeRemoveButton(app, actor, index);
    slot.append(label, removeButton);
    return slot;
  }

  slot.classList.add("fblqa-filled");
  if (!isAllowedQuickItem(item)) slot.classList.add("fblqa-overweight");

  slot.draggable = canModify;
  slot.title = qaLocalize("QuickAccess.ItemTitle", "{name}\nВес: {weight}\nДвойной клик: открыть предмет", { name: item.name, weight: getItemWeightLabel(item) });

  if (canModify) {
    slot.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type: "FBLQuickAccess",
        actorId: actor.id,
        actorUuid: actor.uuid,
        slotIndex: index,
        itemId: item.id,
        itemUuid: item.uuid
      }));
      event.dataTransfer.effectAllowed = "move";
    });
  }

  const openItem = (event) => {
    event?.preventDefault?.();
    item.sheet?.render(true);
  };

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.classList.add("fblqa-slot-open");
  openButton.setAttribute("aria-label", qaLocalize("QuickAccess.OpenItem", "Открыть предмет: {name}", { name: item.name }));
  openButton.title = slot.title;
  openButton.addEventListener("click", openItem);
  slot.addEventListener("dblclick", (event) => {
    if (event.target?.closest?.(".fblqa-remove")) return;
    openItem(event);
  });

  const img = document.createElement("img");
  img.classList.add("fblqa-img");
  img.src = item.img ?? "icons/svg/item-bag.svg";
  img.alt = item.name;

  const name = document.createElement("span");
  name.classList.add("fblqa-name");
  name.textContent = item.name;

  openButton.append(img, name);
  const removeButton = makeRemoveButton(app, actor, index);
  slot.append(openButton, removeButton);
  return slot;
}

function makeRemoveButton(app, actor, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("fblqa-remove");
  button.textContent = "×";
  button.title = qaLocalize("QuickAccess.Remove", "Убрать из быстрого доступа");
  button.setAttribute("aria-label", button.title);
  button.disabled = !canModifyActor(actor);

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canModifyActor(actor)) {
      warnCannotModifyActor();
      return;
    }
    await removeSlot(actor, index);
    rerenderSheet(app);
  });

  return button;
}

async function handleDrop(app, actor, event, targetIndex) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  const data = readDropData(event);
  if (!data) return;

  const capacity = getQuickCapacity(actor).capacity;
  if (targetIndex < 0 || targetIndex >= capacity) return;

  const slots = normalizeSlots(actor, capacity);

  if (data.type === "FBLQuickAccess") {
    await moveQuickSlot(app, actor, slots, data, targetIndex);
    return;
  }

  const item = await resolveDroppedItem(actor, data);
  if (!item) return;

  if (!isAllowedQuickItem(item)) {
    const reason = isQuickAccessItemType(item)
      ? qaLocalize("QuickAccess.WeightReject", "в быстрый доступ можно класть только предметы весом Normal или меньше")
      : qaLocalize("QuickAccess.TypeReject", "в быстрый доступ можно класть только Weapon, Armor, Gear и Raw Material");
    ui.notifications?.warn(`${item.name}: ${reason}.`);
    return;
  }

  // A single item can only occupy one Quick Access slot.
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i] === item.id && i !== targetIndex) slots[i] = null;
  }

  slots[targetIndex] = item.id;
  await saveSlots(actor, slots);
  rerenderSheet(app);
}

async function moveQuickSlot(app, actor, slots, data, targetIndex) {
  if (data.actorId !== actor.id && data.actorUuid !== actor.uuid) {
    ui.notifications?.warn(qaLocalize("QuickAccess.ForeignSlot", "Этот слот принадлежит другому персонажу."));
    return;
  }

  const sourceIndex = Number(data.slotIndex);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= slots.length) return;

  const movingItemId = slots[sourceIndex] ?? data.itemId;
  if (!movingItemId || !actor.items.get(movingItemId)) return;

  const oldTarget = slots[targetIndex] ?? null;
  slots[targetIndex] = movingItemId;

  if (sourceIndex !== targetIndex) {
    slots[sourceIndex] = oldTarget;
  }

  await saveSlots(actor, slots);
  rerenderSheet(app);
}
