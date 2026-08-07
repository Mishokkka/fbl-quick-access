import { ITEM_TOOLTIP_DELAY_MS } from "./constants.js";
import { collectItemRows, resolveItemFromRow } from "./dom-items.js";
import { buildItemTooltipHtml } from "./item-utils.js";
import { findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";

let itemTooltipElement = null;
let itemTooltipTimer = null;
let itemTooltipHideTimer = null;
let itemTooltipAnchor = null;
let itemTooltipPointer = { x: 0, y: 0 };

export function registerTooltipListeners() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideItemTooltip();
  });

  document.addEventListener("mousemove", (event) => {
    itemTooltipPointer = { x: event.clientX, y: event.clientY };
    positionItemTooltip();
  }, true);

  document.addEventListener("scroll", (event) => {
    if (itemTooltipElement?.contains?.(event.target)) return;
    hideItemTooltip();
  }, true);
  window.addEventListener("blur", hideItemTooltip);
}

export function setupGearItemTooltips(actor, gearTab, panel) {
  const gears = findPrimaryGearContainer(gearTab, panel);
  if (!gears) return;

  setupItemTooltipsInContainer(actor, gears, { ignoredRoot: panel });
}

export function setupCombatItemTooltips(actor, combatTab) {
  if (!combatTab) return;

  // The Combat tab has weapons and armor as real inventory items with data-item-id.
  // Critical injuries are intentionally skipped for now: their sheet has different
  // player-facing fields, and showing gear stats for them would be noise.
  const containers = [
    ...combatTab.querySelectorAll(".weapons .items, .armors .items")
  ].filter((element) => element instanceof HTMLElement);

  for (const container of containers) {
    setupItemTooltipsInContainer(actor, container);
  }
}

export function setupTalentItemTooltips(actor, talentTab) {
  if (!talentTab) return;

  // Talents and spells are embedded actor items too. The system has changed
  // small class names between releases, so use the whole tab and let
  // findItemForTooltip filter rows to actual actor-owned items.
  setupItemTooltipsInContainer(actor, talentTab);
}

function setupItemTooltipsInContainer(actor, container, { ignoredRoot = null } = {}) {
  const rows = collectItemRows(container, { ignoredRoot })
    .filter((row) => findItemForTooltip(actor, row));

  for (const row of rows) attachTooltipToRow(actor, row);
}

function attachTooltipToRow(actor, row) {
  if (row.dataset.fblqaTooltipReady === "true") return;
  row.dataset.fblqaTooltipReady = "true";

  row.addEventListener("dblclick", (event) => openItemFromRow(actor, row, event));

  const anchors = findTooltipAnchors(row);
  const keyboardAnchor = anchors.find((anchor) => !anchor.matches("a, button, input, select, textarea, [contenteditable='true']")) ?? anchors[0];
  if (keyboardAnchor instanceof HTMLElement && !keyboardAnchor.matches("a, button, input, select, textarea, [contenteditable='true']")) {
    keyboardAnchor.tabIndex = 0;
    keyboardAnchor.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const item = findItemForTooltip(actor, row);
      if (!item) return;
      event.preventDefault();
      hideItemTooltip();
      item.sheet?.render(true);
    });
  }

  for (const anchor of anchors) {
    anchor.classList.add("fblqa-tooltip-anchor");
    anchor.addEventListener("mouseenter", (event) => scheduleItemTooltip(actor, row, anchor, event));
    anchor.addEventListener("mouseleave", scheduleItemTooltipHide);
    anchor.addEventListener("focus", (event) => scheduleItemTooltip(actor, row, anchor, event));
    anchor.addEventListener("blur", scheduleItemTooltipHide);
  }
}

function findTooltipAnchors(row) {
  const selectors = [
    "img",
    ".fblqa-gear-card",
    ".fblqa-gear-card-name",
    ".item-name",
    ".item-title",
    ".name",
    "h4",
    "td:first-child",
    ".item-image"
  ];

  const anchors = [];
  for (const selector of selectors) {
    for (const element of row.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.closest("button, a.control, .item-controls, .fblqa-panel")) continue;
      anchors.push(element);
    }
  }

  if (row.classList?.contains("fblqa-gear-card")) anchors.unshift(row);
  if (!anchors.length && row instanceof HTMLElement) anchors.push(row);
  return [...new Set(anchors)];
}


function openItemFromRow(actor, row, event) {
  const target = event.target instanceof HTMLElement ? event.target : null;

  // Leave the system's edit/comment/delete controls alone. Double-clicking a
  // control should do what the control already does, not open another sheet.
  if (target?.closest("button, a, input, select, textarea, .item-controls, .fblqa-panel")) return;

  const item = findItemForTooltip(actor, row);
  if (!item) return;

  event.preventDefault();
  event.stopPropagation();
  hideItemTooltip();
  item.sheet?.render(true);
}

function scheduleItemTooltip(actor, row, anchor, event) {
  const item = findItemForTooltip(actor, row);
  if (!item) return;

  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = null;
  clearTimeout(itemTooltipTimer);
  removeTooltipDescription(itemTooltipAnchor);
  itemTooltipAnchor = anchor;

  if (event?.clientX || event?.clientY) {
    itemTooltipPointer = { x: event.clientX, y: event.clientY };
  } else {
    const rect = anchor.getBoundingClientRect();
    itemTooltipPointer = { x: rect.right, y: rect.top };
  }

  itemTooltipTimer = window.setTimeout(async () => {
    if (itemTooltipAnchor !== anchor) return;

    const html = await buildItemTooltipHtml(item);
    if (itemTooltipAnchor !== anchor || !anchor.isConnected) return;

    const tooltip = ensureItemTooltipElement();
    tooltip.innerHTML = html;
    tooltip.classList.add("is-visible");
    addTooltipDescription(anchor, tooltip.id);
    positionItemTooltip();
  }, ITEM_TOOLTIP_DELAY_MS);
}

function scheduleItemTooltipHide() {
  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = window.setTimeout(hideItemTooltip, 120);
}

export function hideItemTooltip() {
  clearTimeout(itemTooltipTimer);
  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = null;
  itemTooltipTimer = null;
  removeTooltipDescription(itemTooltipAnchor);
  itemTooltipAnchor = null;

  if (itemTooltipElement) {
    itemTooltipElement.classList.remove("is-visible");
    itemTooltipElement.innerHTML = "";
  }
}

function ensureItemTooltipElement() {
  if (itemTooltipElement) return itemTooltipElement;

  itemTooltipElement = document.createElement("aside");
  itemTooltipElement.id = "fblqa-item-tooltip";
  itemTooltipElement.classList.add("fblqa-item-tooltip");
  itemTooltipElement.setAttribute("role", "tooltip");
  itemTooltipElement.addEventListener("mouseenter", () => clearTimeout(itemTooltipHideTimer));
  itemTooltipElement.addEventListener("mouseleave", scheduleItemTooltipHide);
  document.body.append(itemTooltipElement);
  return itemTooltipElement;
}

function addTooltipDescription(anchor, tooltipId) {
  if (!(anchor instanceof HTMLElement) || !tooltipId) return;
  const ids = new Set(String(anchor.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean));
  ids.add(tooltipId);
  anchor.setAttribute("aria-describedby", [...ids].join(" "));
}

function removeTooltipDescription(anchor) {
  if (!(anchor instanceof HTMLElement) || !itemTooltipElement?.id) return;
  const ids = String(anchor.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter((id) => id && id !== itemTooltipElement.id);
  if (ids.length) anchor.setAttribute("aria-describedby", ids.join(" "));
  else anchor.removeAttribute("aria-describedby");
}

function positionItemTooltip() {
  if (!itemTooltipElement?.classList.contains("is-visible")) return;

  const margin = 10;
  const offset = 14;

  itemTooltipElement.style.left = "0px";
  itemTooltipElement.style.top = "0px";

  const rect = itemTooltipElement.getBoundingClientRect();
  let left = itemTooltipPointer.x + offset;
  let top = itemTooltipPointer.y + offset;

  if (left + rect.width + margin > window.innerWidth) {
    left = itemTooltipPointer.x - rect.width - offset;
  }

  if (top + rect.height + margin > window.innerHeight) {
    top = window.innerHeight - rect.height - margin;
  }

  left = Math.max(margin, left);
  top = Math.max(margin, top);

  itemTooltipElement.style.left = `${left}px`;
  itemTooltipElement.style.top = `${top}px`;
}

function findItemForTooltip(actor, row) {
  return resolveItemFromRow(actor, row);
}
