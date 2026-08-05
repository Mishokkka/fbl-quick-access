import { normalizeText } from "./utils.js";

export const ITEM_ROW_SELECTOR = ".fblqa-gear-card, [data-item-id], [data-itemid], [data-id], .item";
export const SOURCE_ITEM_ROW_SELECTOR = "[data-item-id], [data-itemid], [data-id], .item";

export function getItemIdFromRow(row) {
  if (!row) return "";

  const direct = row.dataset?.itemId
    ?? row.dataset?.itemid
    ?? row.dataset?.id
    ?? row.getAttribute?.("data-item-id")
    ?? row.getAttribute?.("data-itemid")
    ?? row.getAttribute?.("data-id");

  if (direct) return direct;

  const nested = row.querySelector?.("[data-item-id], [data-itemid], [data-id]");
  return nested?.dataset?.itemId
    ?? nested?.dataset?.itemid
    ?? nested?.dataset?.id
    ?? nested?.getAttribute?.("data-item-id")
    ?? nested?.getAttribute?.("data-itemid")
    ?? nested?.getAttribute?.("data-id")
    ?? "";
}

export function getItemNameFromRow(row) {
  if (!row) return "";

  const element = row.querySelector?.(".item-name, .item-title, .name, h4, td:first-child");
  const text = element?.textContent ?? row.textContent ?? "";
  return normalizeText(text)
    .replace(/type\s+attribute\s+weight/gi, "")
    .trim();
}

export function resolveItemFromRow(actor, row, { allowNameFallback = true } = {}) {
  const itemId = getItemIdFromRow(row);
  if (itemId && actor?.items?.get?.(itemId)) return actor.items.get(itemId);

  if (!allowNameFallback) return null;
  return resolveUniqueItemByRowName(actor, row);
}

export function resolveUniqueItemByRowName(actor, row) {
  const rowName = getItemNameFromRow(row);
  if (!rowName) return null;

  const normalized = normalizeText(rowName);
  const matches = [...(actor?.items ?? [])].filter((item) => normalizeText(item.name) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

export function collectItemRows(root, {
  includeCards = true,
  ignoredRoot = null,
  excludeGeneratedGearCardGrid = true,
  allowHiddenExternalRows = false
} = {}) {
  if (!root) return [];

  const selector = includeCards ? ITEM_ROW_SELECTOR : SOURCE_ITEM_ROW_SELECTOR;
  return [...root.querySelectorAll(selector)]
    .filter((row) => row instanceof HTMLElement)
    .filter((row) => !ignoredRoot?.contains?.(row))
    .filter((row) => !row.closest(".fblqa-panel"))
    .filter((row) => includeCards || !row.closest(".fblqa-gear-card-grid"))
    .filter((row) => !excludeGeneratedGearCardGrid || !isGeneratedGearCardGridElement(row))
    .filter((row) => allowHiddenExternalRows || !isExternalOrHiddenSourceRow(row));
}

export function collectGearRowGroups(actor, gears, { includeCards = true, allowNameFallback = true } = {}) {
  const rows = collectItemRows(gears, { includeCards })
    .filter((row) => resolveItemFromRow(actor, row, { allowNameFallback }));

  const grouped = new Map();
  for (const row of rows) {
    const container = getRowGroupContainer(row, gears);
    if (!container || container.classList?.contains("fblqa-gear-card-grid")) continue;

    if (!grouped.has(container)) grouped.set(container, []);
    grouped.get(container).push(row);
  }

  return [...grouped.entries()].map(([container, groupRows]) => ({ container, rows: groupRows }));
}

export function getRowGroupContainer(row, gears) {
  if (isGearCard(row)) return row.closest(".fblqa-gear-card-grid") ?? gears;

  return row.closest(".items-list, .inventory-list, ol, ul, tbody")
    ?? row.parentElement
    ?? gears;
}

export function isGearCard(row) {
  return Boolean(row?.classList?.contains("fblqa-gear-card"));
}

export function isGearSourceRow(row) {
  return Boolean(row?.matches?.(SOURCE_ITEM_ROW_SELECTOR)) && !isGearCard(row);
}

export function isExternalOrHiddenSourceRow(row) {
  if (row?.closest?.(".fblecp-extensions-category")) return false;
  return row?.classList?.contains("fblecp-installed-item-hidden")
    || row?.dataset?.fblecpInstalledHidden === "1"
    || Boolean(row?.closest?.(".fblecp-installed-item-hidden, [data-fblecp-installed-hidden='1']"));
}

function isGeneratedGearCardGridElement(row) {
  return row.classList?.contains("fblqa-gear-card-grid")
    || row.classList?.contains("fblqa-gear-card-grid-wrap")
    || row.classList?.contains("fblqa-gear-card-grid-row");
}
