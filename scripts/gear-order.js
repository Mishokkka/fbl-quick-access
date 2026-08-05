import { FLAG_GEAR_ORDER, MODULE_ID } from "./constants.js";
import { collectGearRowGroups, getItemIdFromRow, resolveItemFromRow } from "./dom-items.js";
import { readDropData, getDroppedItemId } from "./drag-data.js";
import { getItemCarryState } from "./item-utils.js";
import { findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { normalizeText, rerenderSheet } from "./utils.js";

/**
 * Saves only presentation order. Item data, carry state and encumbrance are left
 * to the Forbidden Lands system. The flag is a flat item-id priority list; each
 * visible Gear section applies the same priority list to its own rows.
 */
export function setupGearOrdering(app, actor, gearTab, panel) {
  const gears = findPrimaryGearContainer(gearTab, panel);
  if (!gears) return;

  applySavedGearOrder(actor, gears);
  markCardViewHeaders(gears, gearTab.classList.contains("fblqa-card-view-active"));
  if (canModifyActor(actor)) attachGearOrderDnD(app, actor, gears);
}

export function applySavedGearOrder(actor, gears) {
  const order = getStoredGearOrder(actor);
  if (!order.length) return;

  for (const group of collectGearRowGroups(actor, gears, { includeCards: false })) {
    const indexed = group.rows.map((row, index) => ({
      row,
      index,
      itemId: resolveItemFromRow(actor, row)?.id ?? getItemIdFromRow(row)
    }));

    indexed.sort((a, b) => {
      const ai = getOrderIndex(order, a.itemId);
      const bi = getOrderIndex(order, b.itemId);
      if (ai !== bi) return ai - bi;
      return a.index - b.index;
    });

    for (const entry of indexed) group.container.append(entry.row);
  }
}

function attachGearOrderDnD(app, actor, gears) {
  const rows = collectOrderingTargets(actor, gears);

  for (const row of rows) {
    if (row.dataset.fblqaOrderReady === "true") continue;
    row.dataset.fblqaOrderReady = "true";

    row.draggable = true;

    row.addEventListener("dragstart", (event) => {
      const item = resolveItemFromRow(actor, row);
      if (!item) return;

      // Keep the payload compatible with the Forbidden Lands sheet. The system
      // expects normal Item drag data to move items between Equipped, Backpack
      // and Dropped. The fblqaGearOrder marker lets this module recognize only
      // its own row-reorder drags when the drop target is in the same section.
      event.dataTransfer?.setData("text/plain", JSON.stringify({
        type: "Item",
        id: item.id,
        itemId: item.id,
        uuid: item.uuid,
        actorUuid: actor.uuid,
        fblqaGearOrder: true
      }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";

      row.classList.add("fblqa-gear-order-dragging");
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("fblqa-gear-order-dragging");
      clearDropMarkers(gears);
    });

    row.addEventListener("dragover", (event) => {
      const draggedItemId = getDraggedItemId(event);
      const targetItemId = getItemIdFromRow(row);
      if (!draggedItemId || !targetItemId || draggedItemId === targetItemId) return;
      if (!areRowsInSameOrderGroup(actor, gears, draggedItemId, targetItemId)) return;

      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      markDropPosition(row, event);
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("fblqa-drop-before", "fblqa-drop-after");
    });

    row.addEventListener("drop", async (event) => {
      const draggedItemId = getDraggedItemId(event);
      const targetItemId = getItemIdFromRow(row);
      if (!draggedItemId || !targetItemId || draggedItemId === targetItemId) return;
      if (!areRowsInSameOrderGroup(actor, gears, draggedItemId, targetItemId)) return;

      event.preventDefault();
      event.stopPropagation();

      const insertAfter = shouldInsertAfter(row, event);
      await saveReorderedGroup(app, actor, gears, draggedItemId, targetItemId, insertAfter);
    });
  }
}

function collectOrderingTargets(actor, gears) {
  const cardRows = [...gears.querySelectorAll(".fblqa-gear-card")]
    .filter((row) => row instanceof HTMLElement)
    .filter((row) => resolveItemFromRow(actor, row));

  if (cardRows.length) return cardRows;

  return collectGearRowGroups(actor, gears, { includeCards: false })
    .flatMap((group) => group.rows)
    .filter((row) => !row.classList.contains("fblqa-card-source-hidden"));
}

async function saveReorderedGroup(app, actor, gears, draggedItemId, targetItemId, insertAfter) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  const group = findGroupContainingItem(actor, gears, targetItemId);
  if (!group) return;

  const groupIds = getGroupItemIds(actor, group.rows);
  if (!groupIds.includes(draggedItemId) || !groupIds.includes(targetItemId)) return;

  const nextGroupIds = groupIds.filter((id) => id !== draggedItemId);
  const targetIndex = nextGroupIds.indexOf(targetItemId);
  nextGroupIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedItemId);

  const current = getStoredGearOrder(actor);
  const next = [
    ...nextGroupIds,
    ...current.filter((id) => !nextGroupIds.includes(id))
  ];

  await actor.setFlag(MODULE_ID, FLAG_GEAR_ORDER, next);
  rerenderSheet(app);
}

function findGroupContainingItem(actor, gears, itemId) {
  return collectGearRowGroups(actor, gears, { includeCards: true })
    .find((group) => getGroupItemIds(actor, group.rows).includes(itemId));
}

function areRowsInSameOrderGroup(actor, gears, draggedItemId, targetItemId) {
  const group = findGroupContainingItem(actor, gears, targetItemId);
  if (!group) return false;
  const ids = getGroupItemIds(actor, group.rows);
  if (!ids.includes(draggedItemId) || !ids.includes(targetItemId)) return false;

  const draggedRow = findRowForItem(actor, gears, draggedItemId);
  const targetRow = findRowForItem(actor, gears, targetItemId);
  const draggedItem = actor.items.get(draggedItemId);
  const targetItem = actor.items.get(targetItemId);

  // Do not steal native Forbidden Lands category moves. If the source and
  // target live in different Equipped/Backpack/Dropped sections, let the
  // system drop handler handle the carry-state update.
  if (!isSameCarryState(draggedItem, targetItem)) return false;
  if (!isSameVisualSection(draggedRow, targetRow, gears)) return false;

  return true;
}

function getGroupItemIds(actor, rows) {
  return rows
    .map((row) => resolveItemFromRow(actor, row)?.id ?? "")
    .filter(Boolean);
}

function findRowForItem(actor, gears, itemId) {
  return collectGearRowGroups(actor, gears, { includeCards: true })
    .flatMap((group) => group.rows)
    .find((row) => resolveItemFromRow(actor, row)?.id === itemId) ?? null;
}

function isSameCarryState(a, b) {
  const aState = getItemCarryState(a);
  const bState = getItemCarryState(b);
  if (!aState || !bState) return true;
  return aState === bState;
}

function isSameVisualSection(a, b, gears) {
  if (!a || !b) return true;
  const aSection = getVisualSectionKey(a, gears);
  const bSection = getVisualSectionKey(b, gears);
  if (!aSection || !bSection) return true;
  return aSection === bSection;
}

function getVisualSectionKey(row, gears) {
  const structural = getStructuralSectionKey(row, gears);
  if (structural) return structural;

  const marker = getPreviousSectionMarker(row, gears);
  if (marker) return marker;

  return "";
}

function getStructuralSectionKey(row, gears) {
  const boundary = row.closest?.("[data-group], [data-section], [data-category], [data-location], [data-carry], [data-equipped], .equipped, .backpack, .dropped, .ground");
  if (boundary && boundary !== gears && gears.contains(boundary)) {
    const data = boundary.dataset ?? {};
    const values = [
      data.group,
      data.section,
      data.category,
      data.location,
      data.carry,
      data.equipped,
      ...[...boundary.classList ?? []]
    ];
    const key = normalizeSectionValues(values);
    if (key) return key;
  }

  return "";
}

function getPreviousSectionMarker(row, gears) {
  let current = row;

  while (current && current !== gears) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      const key = getSectionKeyFromElement(sibling);
      if (key) return key;
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }

  return "";
}

function getSectionKeyFromElement(element) {
  if (!(element instanceof HTMLElement)) return "";
  if (element.matches?.(".item, [data-item-id], [data-itemid], .fblqa-gear-card")) return "";

  const values = [
    element.dataset?.group,
    element.dataset?.section,
    element.dataset?.category,
    element.dataset?.location,
    element.dataset?.carry,
    ...[...element.classList ?? []],
    element.textContent ?? ""
  ];

  return normalizeSectionValues(values);
}

function normalizeSectionValues(values) {
  const joined = normalizeText(values.filter(Boolean).join(" "));
  if (!joined) return "";
  if (/(^|\s|[-_])(equipped|equip|worn|экип|надет)(\s|[-_]|$)/i.test(joined)) return "equipped";
  if (/(^|\s|[-_])(backpack|bag|inventory|carried|рюкзак|снаряж)(\s|[-_]|$)/i.test(joined)) return "backpack";
  if (/(^|\s|[-_])(dropped|ground|floor|брош|сброш|земл)(\s|[-_]|$)/i.test(joined)) return "dropped";
  if (/(^|\s|[-_])(extensions?|prosthetics?|prosthes(?:is|es)|implants?|протез|имплант)(\s|[-_]|$)/i.test(joined)) return "extensions";
  return "";
}

function getStoredGearOrder(actor) {
  const order = actor.getFlag(MODULE_ID, FLAG_GEAR_ORDER);
  return Array.isArray(order) ? order.filter((id) => typeof id === "string" && id) : [];
}

function getOrderIndex(order, itemId) {
  const index = order.indexOf(itemId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getDraggedItemId(event) {
  const data = readDropData(event, { warn: false });
  if (!data) return "";
  if (data.type === "FBLQAGearOrder") return getDroppedItemId(data);
  if (data.type !== "Item" || data.fblqaGearOrder !== true) return "";
  return getDroppedItemId(data);
}

function markDropPosition(row, event) {
  clearDropMarkers(row.ownerDocument ?? document);
  row.classList.add(shouldInsertAfter(row, event) ? "fblqa-drop-after" : "fblqa-drop-before");
}

function shouldInsertAfter(row, event) {
  const rect = row.getBoundingClientRect();
  if (row.classList.contains("fblqa-gear-card")) {
    return event.clientX > rect.left + rect.width / 2;
  }
  return event.clientY > rect.top + rect.height / 2;
}

function clearDropMarkers(root) {
  for (const element of root.querySelectorAll?.(".fblqa-drop-before, .fblqa-drop-after") ?? []) {
    element.classList.remove("fblqa-drop-before", "fblqa-drop-after");
  }
}

function markCardViewHeaders(gears, enabled) {
  // Card view keeps the section header itself, but all table-column labels
  // become visual noise once rows are replaced by cards. The system markup has
  // changed names across versions, so this deliberately combines class, sort
  // attribute and text checks instead of relying on one selector.
  const columnTextPattern = /(type|attribute|weight|тип|атрибут|вес)/i;
  const sectionTextPattern = /(equipped|backpack|dropped|экип|снаряж|рюкзак|брош|сброш)/i;

  for (const header of gears.querySelectorAll(".items-header, .item-header, thead tr, .items-list > header, .inventory-list > header")) {
    if (!(header instanceof HTMLElement)) continue;
    header.classList.toggle("fblqa-card-header", enabled);

    for (const child of header.children) {
      if (!(child instanceof HTMLElement)) continue;

      const text = normalizeText(child.textContent ?? "");
      const classMatch = child.matches?.(
        ".item-type, .gear-type, .type, [class*='type'], .item-attribute, .gear-attribute, .attribute, [class*='attribute'], .item-weight, .gear-weight, .weight, [class*='weight']"
      );
      const sortMatch = [...child.querySelectorAll?.("[data-sort]") ?? [], child]
        .some((element) => columnTextPattern.test(String(element?.dataset?.sort ?? "")));
      const textMatch = columnTextPattern.test(text) && !sectionTextPattern.test(text);

      child.classList.toggle("fblqa-card-column-hidden", enabled && (classMatch || sortMatch || textMatch));
    }
  }
}
