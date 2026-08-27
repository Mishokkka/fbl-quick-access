import { ITEM_TOOLTIP_DELAY_MS } from "./constants.js";
import { collectItemRows, resolveItemFromRow } from "./dom-items.js";
import { buildItemTooltipHtml } from "./item-utils.js";
import { findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";

let itemTooltipElement = null;
let itemTooltipTimer = null;
let itemTooltipHideTimer = null;
let itemTooltipAnchor = null;
let itemTooltipPointer = { x: 0, y: 0 };
let itemTooltipRequest = 0;
let itemTooltipPositionFrame = 0;
let itemTooltipSize = { width: 0, height: 0 };
let itemTooltipResizeObserver = null;

export function registerTooltipListeners() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideItemTooltip();
  });

  document.addEventListener("mousemove", (event) => {
    itemTooltipPointer = { x: event.clientX, y: event.clientY };
    scheduleItemTooltipPosition();
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
    keyboardAnchor.setAttribute("role", "button");
    keyboardAnchor.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = findItemForTooltip(actor, row);
      if (!item) return;
      event.preventDefault();
      hideItemTooltip();
      item.sheet?.render(true);
    });
  }

  // Use one pointer boundary for the whole item row. Attaching hover handlers
  // to nested image/name/card elements causes enter/leave races while the cursor
  // crosses children and can leave the first tooltip active over later items.
  const pointerAnchor = row instanceof HTMLElement ? row : anchors[0];
  if (pointerAnchor instanceof HTMLElement) {
    pointerAnchor.classList.add("fblqa-tooltip-anchor");
    pointerAnchor.addEventListener("mouseenter", (event) => scheduleItemTooltip(actor, row, pointerAnchor, event));
    pointerAnchor.addEventListener("mouseleave", scheduleItemTooltipHide);
  }

  if (keyboardAnchor instanceof HTMLElement && keyboardAnchor !== pointerAnchor) {
    keyboardAnchor.classList.add("fblqa-tooltip-anchor");
    keyboardAnchor.addEventListener("focus", (event) => scheduleItemTooltip(actor, row, keyboardAnchor, event));
    keyboardAnchor.addEventListener("blur", scheduleItemTooltipHide);
  } else if (keyboardAnchor instanceof HTMLElement) {
    keyboardAnchor.addEventListener("focus", (event) => scheduleItemTooltip(actor, row, keyboardAnchor, event));
    keyboardAnchor.addEventListener("blur", scheduleItemTooltipHide);
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

export function planTooltipTransition(previousAnchor, nextAnchor, wasVisible) {
  return {
    replaceVisibleContent: previousAnchor !== nextAnchor,
    delayMs: wasVisible ? 0 : ITEM_TOOLTIP_DELAY_MS
  };
}

function scheduleItemTooltip(actor, row, anchor, event) {
  const item = findItemForTooltip(actor, row);
  if (!item) return;

  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = null;
  clearTimeout(itemTooltipTimer);

  const previousAnchor = itemTooltipAnchor;
  const wasVisible = Boolean(itemTooltipElement?.classList.contains("is-visible"));
  const transition = planTooltipTransition(previousAnchor, anchor, wasVisible);
  const request = ++itemTooltipRequest;
  if (transition.replaceVisibleContent) {
    removeTooltipDescription(previousAnchor);
    if (itemTooltipElement) {
      itemTooltipElement.classList.remove("is-visible");
      itemTooltipElement.innerHTML = "";
    }
  }
  itemTooltipAnchor = anchor;

  if (event?.clientX || event?.clientY) {
    itemTooltipPointer = { x: event.clientX, y: event.clientY };
  } else {
    const rect = anchor.getBoundingClientRect();
    itemTooltipPointer = { x: rect.right, y: rect.top };
  }

  const delay = transition.delayMs;
  itemTooltipTimer = window.setTimeout(async () => {
    if (request !== itemTooltipRequest || itemTooltipAnchor !== anchor) return;

    const html = await buildItemTooltipHtml(item);
    if (request !== itemTooltipRequest || itemTooltipAnchor !== anchor || !anchor.isConnected) return;

    const tooltip = ensureItemTooltipElement();
    tooltip.innerHTML = html;
    tooltip.classList.add("is-visible");
    measureItemTooltip();
    addTooltipDescription(anchor, tooltip.id);
    scheduleItemTooltipPosition();
  }, delay);
}

function scheduleItemTooltipHide() {
  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = window.setTimeout(hideItemTooltip, 120);
}

export function hideItemTooltip() {
  itemTooltipRequest += 1;
  clearTimeout(itemTooltipTimer);
  clearTimeout(itemTooltipHideTimer);
  itemTooltipHideTimer = null;
  itemTooltipTimer = null;
  removeTooltipDescription(itemTooltipAnchor);
  itemTooltipAnchor = null;
  if (itemTooltipPositionFrame) {
    cancelAnimationFrame(itemTooltipPositionFrame);
    itemTooltipPositionFrame = 0;
  }

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

  if (typeof ResizeObserver === "function") {
    itemTooltipResizeObserver = new ResizeObserver(() => {
      measureItemTooltip();
      scheduleItemTooltipPosition();
    });
    itemTooltipResizeObserver.observe(itemTooltipElement);
  }

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

function measureItemTooltip() {
  if (!itemTooltipElement?.classList.contains("is-visible")) return;
  const rect = itemTooltipElement.getBoundingClientRect();
  itemTooltipSize = { width: rect.width, height: rect.height };
}

function scheduleItemTooltipPosition() {
  if (!itemTooltipElement?.classList.contains("is-visible") || itemTooltipPositionFrame) return;
  itemTooltipPositionFrame = requestAnimationFrame(() => {
    itemTooltipPositionFrame = 0;
    positionItemTooltip();
  });
}

function positionItemTooltip() {
  if (!itemTooltipElement?.classList.contains("is-visible")) return;

  const margin = 10;
  const offset = 14;
  const { width, height } = itemTooltipSize;
  let left = itemTooltipPointer.x + offset;
  let top = itemTooltipPointer.y + offset;

  if (left + width + margin > window.innerWidth) {
    left = itemTooltipPointer.x - width - offset;
  }

  if (top + height + margin > window.innerHeight) {
    top = window.innerHeight - height - margin;
  }

  left = Math.max(margin, left);
  top = Math.max(margin, top);

  itemTooltipElement.style.left = `${left}px`;
  itemTooltipElement.style.top = `${top}px`;
}

function findItemForTooltip(actor, row) {
  return resolveItemFromRow(actor, row);
}
