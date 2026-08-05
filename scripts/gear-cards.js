import { GEAR_CARD_VIEW_STORAGE_PREFIX, MODULE_ID } from "./constants.js";
import { collectGearRowGroups, resolveItemFromRow } from "./dom-items.js";
import { findConsumablesRow, findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";
import { qaLocalize } from "./i18n.js";
import { getItemWeightValue } from "./item-utils.js";
import { canModifyActor } from "./permissions.js";
import { escapeHtml, formatNumber, rerenderSheet } from "./utils.js";

/**
 * Client-side view preference. It is intentionally not stored on the actor:
 * card/table layout is a UI choice, not character data.
 */
export function isGearCardView(actor) {
  return localStorage.getItem(getStorageKey(actor)) === "cards";
}

/**
 * Replaces the system dice icon in the consumables row with the Gear view
 * checkbox. The checkbox stays near the bottom controls, leaving the top quick
 * access line for weight, slots and wallet only.
 */
export function setupGearViewConsumableToggle(app, actor, gearTab) {
  const consumables = findConsumablesRow(gearTab);
  if (!consumables) return;

  // If the same DOM is processed again, keep the existing checkbox and only
  // resync its state. There is no dice icon left after the first replacement.
  const existing = consumables.querySelector(".fblqa-consumable-toggle-slot");
  if (existing) {
    const input = existing.querySelector("input[type='checkbox']");
    if (input) input.checked = isGearCardView(actor);
    return;
  }

  const diceIcon = consumables.querySelector(".consumable i.fa-dice, .consumable .fa-dice, i.fa-dice");
  if (!diceIcon) return;

  const slot = document.createElement("span");
  slot.classList.add("fblqa-consumable-toggle-slot");
  slot.title = qaLocalize("GearCards.ViewAsCards", "Вид Gear карточками");
  slot.append(buildGearViewCheckbox(app, actor, gearTab));

  diceIcon.replaceWith(slot);
}

function buildGearViewCheckbox(app, actor, gearTab) {
  const label = document.createElement("label");
  label.classList.add("fblqa-card-view-checkbox");
  label.title = qaLocalize("GearCards.ViewAsCards", "Вид Gear карточками");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = isGearCardView(actor);
  input.setAttribute("aria-label", qaLocalize("GearCards.ViewAsCards", "Вид Gear карточками"));

  const mark = document.createElement("i");
  mark.classList.add("fas", "fa-check", "fblqa-card-view-checkbox-mark");
  mark.setAttribute("aria-hidden", "true");

  input.addEventListener("change", (event) => {
    const enabled = event.currentTarget.checked;
    localStorage.setItem(getStorageKey(actor), enabled ? "cards" : "table");

    const refreshed = game.modules
      ?.get?.(MODULE_ID)
      ?.api
      ?.refreshGearPresentation?.(app, actor, gearTab);

    if (!refreshed) rerenderSheet(app);
  });

  label.append(input, mark);
  return label;
}

export function setupGearCardView(app, actor, gearTab, panel) {
  cleanupGeneratedCards(gearTab);

  const enabled = isGearCardView(actor);
  gearTab.classList.toggle("fblqa-card-view-active", enabled);

  const gears = findPrimaryGearContainer(gearTab, panel);
  if (!gears) return;

  for (const row of gears.querySelectorAll(".fblqa-card-source-hidden")) {
    row.classList.remove("fblqa-card-source-hidden");
  }

  if (!enabled) return;

  const groups = collectGearRowGroups(actor, gears, { includeCards: false });
  for (const group of groups) {
    const cards = group.rows
      .map((row) => buildGearCard(app, actor, row))
      .filter(Boolean);

    if (!cards.length) continue;

    const grid = document.createElement("div");
    grid.classList.add("fblqa-gear-card-grid");
    for (const card of cards) grid.append(card);

    for (const row of group.rows) row.classList.add("fblqa-card-source-hidden");
    insertCardGrid(group.container, grid);
  }
}

function getStorageKey(actor) {
  return `${GEAR_CARD_VIEW_STORAGE_PREFIX}.${actor?.uuid ?? actor?.id ?? "unknown"}`;
}

function cleanupGeneratedCards(root) {
  for (const element of root.querySelectorAll(".fblqa-gear-card-grid-wrap, .fblqa-gear-card-grid-row, .fblqa-gear-card-grid")) {
    if (element.classList.contains("fblqa-gear-card-grid") && !element.parentElement?.classList.contains("fblqa-gear-card-grid-wrap")) {
      element.remove();
      continue;
    }
    if (!element.closest(".fblqa-gear-card-grid")) element.remove();
  }
}

function insertCardGrid(container, grid) {
  const tag = container.tagName?.toLowerCase();

  if (tag === "ol" || tag === "ul") {
    const wrapper = document.createElement("li");
    wrapper.classList.add("fblqa-gear-card-grid-wrap");
    wrapper.append(grid);
    container.append(wrapper);
    return;
  }

  if (tag === "tbody" || tag === "thead" || tag === "tfoot") {
    const row = document.createElement("tr");
    row.classList.add("fblqa-gear-card-grid-row");
    const cell = document.createElement("td");
    cell.colSpan = 99;
    cell.append(grid);
    row.append(cell);
    container.append(row);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.classList.add("fblqa-gear-card-grid-wrap");
  wrapper.append(grid);
  container.append(wrapper);
}

function buildGearCard(app, actor, sourceRow) {
  const item = resolveItemFromRow(actor, sourceRow);
  if (!item) return null;

  const card = document.createElement("article");
  const extensionMeta = getProstheticsExtensionMeta(sourceRow);
  card.classList.add("fblqa-gear-card", "item");
  if (extensionMeta) card.classList.add("fblqa-gear-card-extension");
  card.dataset.itemId = item.id;
  if (extensionMeta) card.dataset.fblecpExtension = "1";

  const canModify = canModifyActor(actor);
  card.draggable = canModify;

  if (canModify) {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", JSON.stringify({
        type: "Item",
        id: item.id,
        itemId: item.id,
        uuid: item.uuid,
        actorUuid: actor.uuid
      }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
    });
  }

  const iconWrap = document.createElement("div");
  iconWrap.classList.add("fblqa-gear-card-icon-wrap");

  const img = document.createElement("img");
  img.classList.add("fblqa-gear-card-img");
  img.src = item.img ?? "icons/svg/item-bag.svg";
  img.alt = item.name;
  img.draggable = false;
  iconWrap.append(img);

  const body = document.createElement("div");
  body.classList.add("fblqa-gear-card-body");

  const top = document.createElement("div");
  top.classList.add("fblqa-gear-card-top");

  const name = document.createElement("span");
  name.classList.add("fblqa-gear-card-name", "item-name");
  name.textContent = item.name;

  top.append(name);

  const bottom = document.createElement("div");
  bottom.classList.add("fblqa-gear-card-bottom");

  if (extensionMeta) {
    bottom.append(
      buildCardStat(qaLocalize("GearCards.StatType", "ТИП"), extensionMeta.kind || getShortType(item)),
      buildCardStat(qaLocalize("GearCards.StatSlot", "СЛОТ"), extensionMeta.slot || "—"),
      buildCardStat(qaLocalize("GearCards.StatWeight", "ВЕС"), extensionMeta.weight || formatNumber(getItemWeightValue(item)))
    );
  } else {
    bottom.append(
      buildCardStat(qaLocalize("GearCards.StatType", "ТИП"), getShortType(item)),
      buildCardStat(qaLocalize("GearCards.StatWeight", "ВЕС"), formatNumber(getItemWeightValue(item))),
      buildCardStat(qaLocalize("GearCards.StatBonusShort", "Б"), getItemBonus(item))
    );

  }
  body.append(top, bottom);
  card.append(iconWrap, body);
  return card;
}

function buildCardStat(label, value) {
  const cell = document.createElement("span");
  cell.classList.add("fblqa-gear-card-stat");

  const labelElement = document.createElement("strong");
  labelElement.classList.add("fblqa-gear-card-stat-label");
  labelElement.textContent = `${label}:`;

  const valueElement = document.createElement("span");
  valueElement.classList.add("fblqa-gear-card-stat-value");
  valueElement.textContent = value;

  cell.append(labelElement, valueElement);
  return cell;
}

function getShortType(item) {
  const map = {
    weapon: "W",
    armor: "A",
    gear: "G",
    rawMaterial: "R"
  };
  return map[item.type] ?? String(item.type ?? "?").charAt(0).toUpperCase();
}

function getItemBonus(item) {
  const value = item.system?.bonus?.value ?? item.system?.bonus ?? 0;
  const number = Number(value);
  if (Number.isFinite(number)) return formatNumber(number);
  return escapeHtml(String(value || 0));
}

function getProstheticsExtensionMeta(row) {
  if (!row?.closest?.(".fblecp-extensions-category")) return null;

  const textOf = (selector) => compactCardText(row.querySelector?.(selector)?.textContent ?? "");
  const kind = textOf(".fblecp-extension-kind, td:nth-child(2)");
  const slot = textOf(".fblecp-extension-slot, td:nth-child(3)");
  const weight = textOf("td:nth-child(4)");

  return { kind, slot, weight };
}

function compactCardText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
