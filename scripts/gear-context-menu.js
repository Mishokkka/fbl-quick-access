import { MODULE_ID } from "./constants.js";
import { collectItemRows, resolveItemFromRow } from "./dom-items.js";
import { qaLocalize } from "./i18n.js";
import { findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { confirmDangerAction } from "./dialogs.js";

const MENU_CLASS = "fblqa-gear-context-menu";
const MENU_ITEM_SELECTOR = ".fblqa-gear-card, [data-item-id], [data-itemid], [data-id], .item";
const CHAT_ACTION_SELECTORS = Object.freeze([
  ".item-chat",
  ".item-message",
  "[data-action='chat']",
  "[data-action='itemChat']",
  "[data-action='post']",
  "[data-action='toChat']",
  "a[title*='Chat']",
  "button[title*='Chat']",
  "a[title*='чат']",
  "button[title*='чат']"
]);

let activeMenu = null;
let activeCleanup = null;

export function setupGearContextMenu(app, actor, gearTab, panel) {
  const gears = findPrimaryGearContainer(gearTab, panel);
  if (!gears) return;

  gearTab.classList.add("fblqa-gear-context-enabled");
  markContextMenuRows(actor, gears);

  if (gears.dataset.fblqaContextMenuReady === "true") return;
  gears.dataset.fblqaContextMenuReady = "true";

  gears.addEventListener("contextmenu", (event) => {
    const row = findContextMenuRow(event.target, gears);
    if (!row) return;

    const item = resolveItemFromRow(actor, row);
    if (!item) return;

    event.preventDefault();
    event.stopPropagation();

    openGearContextMenu({ app, actor, item, row, gears, x: event.clientX, y: event.clientY });
  });
}

function markContextMenuRows(actor, gears) {
  for (const row of collectItemRows(gears, { includeCards: true })) {
    if (!resolveItemFromRow(actor, row)) continue;
    row.classList.add("fblqa-gear-menu-row");

    const controls = row.querySelector(":scope > .item-controls") ?? row.querySelector(".item-controls");
    if (controls instanceof HTMLElement) controls.classList.add("fblqa-gear-row-controls-collapsed");

    const chatControl = findNativeChatControl(row);
    if (chatControl) chatControl.classList.add("fblqa-gear-chat-control-hidden");
  }
}

function findContextMenuRow(target, gears) {
  if (!(target instanceof Element)) return null;

  const row = target.closest(MENU_ITEM_SELECTOR);
  if (!(row instanceof HTMLElement)) return null;
  if (!gears.contains(row)) return null;
  if (row.closest(".fblqa-panel")) return null;
  if (row.classList.contains("fblqa-card-source-hidden")) return null;
  if (row.classList.contains("fblqa-gear-card-grid") || row.classList.contains("fblqa-gear-card-grid-wrap")) return null;

  return row;
}

function openGearContextMenu({ app, actor, item, row, gears, x, y }) {
  closeGearContextMenu();

  const menu = document.createElement("nav");
  menu.classList.add(MENU_CLASS);
  menu.setAttribute("role", "menu");
  menu.dataset.itemId = item.id ?? "";

  menu.append(
    buildMenuButton({
      icon: "fa-edit",
      label: qaLocalize("GearMenu.Edit", "Редактировать"),
      action: () => editGearItem(item, row)
    }),
    buildMenuButton({
      icon: "fa-comment",
      label: qaLocalize("GearMenu.PostToChat", "Показать в чате"),
      action: () => postGearItemToChat(actor, item, row, gears)
    }),
    buildMenuButton({
      icon: "fa-copy",
      label: qaLocalize("GearMenu.Duplicate", "Дублировать"),
      disabled: !canModifyActor(actor),
      action: () => duplicateGearItem(app, actor, item)
    }),
    buildMenuButton({
      icon: "fa-trash",
      label: qaLocalize("GearMenu.Delete", "Удалить"),
      danger: true,
      disabled: !canModifyActor(actor),
      action: () => deleteGearItem(app, actor, item, row)
    }),
    buildMenuButton({
      icon: "fa-exchange-alt",
      label: qaLocalize("GearMenu.Transfer", "Передать"),
      disabled: !canModifyActor(actor),
      action: () => transferGearItem(actor, item)
    })
  );

  document.body.append(menu);
  positionMenu(menu, x, y);

  const closeOnOutside = (event) => {
    if (menu.contains(event.target)) return;
    closeGearContextMenu();
  };
  const closeOnEscape = (event) => {
    if (event.key === "Escape") closeGearContextMenu();
  };

  window.addEventListener("resize", closeGearContextMenu, true);
  window.addEventListener("scroll", closeGearContextMenu, true);
  document.addEventListener("mousedown", closeOnOutside, true);
  document.addEventListener("contextmenu", closeOnOutside, true);
  document.addEventListener("keydown", closeOnEscape, true);

  activeMenu = menu;
  activeCleanup = () => {
    window.removeEventListener("resize", closeGearContextMenu, true);
    window.removeEventListener("scroll", closeGearContextMenu, true);
    document.removeEventListener("mousedown", closeOnOutside, true);
    document.removeEventListener("contextmenu", closeOnOutside, true);
    document.removeEventListener("keydown", closeOnEscape, true);
  };
}

function buildMenuButton({ icon, label, action, danger = false, disabled = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("fblqa-gear-menu-button");
  if (danger) button.classList.add("fblqa-gear-menu-button-danger");
  button.disabled = disabled;
  button.setAttribute("role", "menuitem");

  const iconElement = document.createElement("i");
  iconElement.classList.add("fas", icon, "fblqa-gear-menu-icon");
  iconElement.setAttribute("aria-hidden", "true");

  const labelElement = document.createElement("span");
  labelElement.classList.add("fblqa-gear-menu-label");
  labelElement.textContent = label;

  button.append(iconElement, labelElement);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeGearContextMenu();
    if (disabled) return;
    await action();
  });

  return button;
}

function positionMenu(menu, x, y) {
  const margin = 6;
  menu.style.left = `${Math.max(margin, x)}px`;
  menu.style.top = `${Math.max(margin, y)}px`;

  const rect = menu.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - rect.width - margin);
  const top = Math.min(rect.top, window.innerHeight - rect.height - margin);

  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

export function closeGearContextMenu() {
  activeCleanup?.();
  activeCleanup = null;
  activeMenu?.remove();
  activeMenu = null;
}


function findNativeChatControl(row) {
  const direct = findNativeActionControl(row, CHAT_ACTION_SELECTORS);
  if (direct) return direct;

  const icon = row.querySelector?.(".fa-comment, .fa-comment-alt, .fa-message, .fa-comments");
  const control = icon?.closest?.("button, a");
  return control instanceof HTMLElement ? control : null;
}

function postGearItemToChat(actor, item, row, gears) {
  let control = findNativeChatControl(row);

  if (!control && gears) {
    const sourceRow = collectItemRows(gears, {
      includeCards: false,
      allowHiddenExternalRows: true
    }).find((candidate) => resolveItemFromRow(actor, candidate, { allowNameFallback: false })?.id === item.id);
    if (sourceRow) control = findNativeChatControl(sourceRow);
  }

  if (control) {
    control.click();
    return;
  }

  ui.notifications?.warn?.(qaLocalize("GearMenu.PostToChatUnavailable", "Не удалось найти системную кнопку публикации предмета в чат."));
}

function editGearItem(item, row) {
  const editControl = findNativeActionControl(row, [
    ".item-edit",
    "[data-action='edit']",
    "[data-action='itemEdit']",
    "a[title*='Edit']",
    "button[title*='Edit']",
    "a[title*='Редакт']",
    "button[title*='Редакт']"
  ]);
  if (editControl) {
    editControl.click();
    return;
  }

  item.sheet?.render(true);
}

async function duplicateGearItem(app, actor, item) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  try {
    const source = item.toObject();
    delete source._id;
    source.name = qaLocalize("GearMenu.DuplicateName", "{name} (копия)", { name: item.name });
    await actor.createEmbeddedDocuments("Item", [source]);
  } catch (error) {
    console.error(`${MODULE_ID} | could not duplicate item`, error);
    ui.notifications?.error(qaLocalize("GearMenu.DuplicateFailed", "Не удалось дублировать предмет."));
  }
}

async function deleteGearItem(app, actor, item, row) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  const confirmed = await confirmDeleteGearItem(item);
  if (!confirmed) return;

  const liveItem = actor.items?.get?.(item.id);
  if (!liveItem) return;

  const appRoot = extractElement(app?.element);
  const liveRow = resolveLiveItemRow(
    actor,
    liveItem,
    row,
    collectItemRows(appRoot ?? document)
  );

  const deleteControl = findNativeActionControl(liveRow, [
    ".item-delete",
    "[data-action='delete']",
    "[data-action='itemDelete']",
    "a[title*='Delete']",
    "button[title*='Delete']",
    "a[title*='Удал']",
    "button[title*='Удал']"
  ]);
  if (deleteControl) {
    deleteControl.click();
    return;
  }

  try {
    await liveItem.delete();
  } catch (error) {
    console.error(`${MODULE_ID} | could not delete item`, error);
    ui.notifications?.error(qaLocalize("GearMenu.DeleteFailed", "Не удалось удалить предмет."));
  }
}

async function confirmDeleteGearItem(item) {
  const itemName = String(item?.name ?? qaLocalize("GearMenu.UnknownItem", "предмет"));
  return confirmDangerAction({
    title: qaLocalize("GearMenu.DeleteConfirmTitle", "Удалить предмет?"),
    heading: qaLocalize("GearMenu.DeleteConfirmHeading", "Подтверждение удаления"),
    message: qaLocalize("GearMenu.DeleteConfirmContent", "Удалить «{name}»?", { name: itemName }),
    warning: qaLocalize("GearMenu.DeleteConfirmWarning", "Это действие нельзя отменить."),
    confirmLabel: qaLocalize("GearMenu.DeleteConfirmYes", "Удалить"),
    cancelLabel: qaLocalize("GearMenu.DeleteConfirmNo", "Отмена"),
    icon: "fas fa-trash"
  });
}



export function resolveLiveItemRow(actor, liveItem, suppliedRow, candidateRows = []) {
  const matchesLiveItem = (candidate) => Boolean(
    candidate?.isConnected
    && resolveItemFromRow(actor, candidate)?.id === liveItem?.id
  );

  if (matchesLiveItem(suppliedRow)) return suppliedRow;
  return candidateRows.find(matchesLiveItem) ?? null;
}

function findNativeActionControl(row, selectors) {
  if (!(row instanceof HTMLElement)) return null;
  for (const selector of selectors) {
    const control = row.querySelector?.(selector);
    if (control instanceof HTMLElement) return control;
  }
  return null;
}

async function transferGearItem(actor, item) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return;
  }

  const api = getItemPilesApi();
  if (!api) {
    ui.notifications?.warn(qaLocalize("GearMenu.ItemPilesMissing", "Модуль Item Piles не активен."));
    return;
  }

  if (typeof api.giveItem === "function") {
    try {
      await api.giveItem(item);
    } catch (error) {
      console.error(`${MODULE_ID} | Item Piles giveItem failed`, error);
      ui.notifications?.error(qaLocalize("GearMenu.TransferFailed", "Не удалось передать предмет через Item Piles."));
    }
    return;
  }

  if (typeof api.requestTrade === "function") {
    ui.notifications?.info(qaLocalize("GearMenu.GiveItemUnavailable", "В этой версии Item Piles нет giveItem(item); открыт обычный запрос обмена без предвыбранного предмета."));
    try {
      await api.requestTrade();
    } catch (error) {
      console.error(`${MODULE_ID} | Item Piles requestTrade failed`, error);
      ui.notifications?.error(qaLocalize("GearMenu.TransferFailed", "Не удалось передать предмет через Item Piles."));
    }
    return;
  }

  ui.notifications?.warn(qaLocalize("GearMenu.ItemPilesApiMissing", "API передачи Item Piles недоступен."));
}

function getItemPilesApi() {
  const itemPilesModule = game.modules?.get?.("item-piles");
  if (itemPilesModule && itemPilesModule.active === false) return null;

  return game.itempiles?.API
    ?? game.itempiles?.api
    ?? itemPilesModule?.api
    ?? null;
}

function extractElement(value) {
  if (value instanceof HTMLElement) return value;
  if (value?.[0] instanceof HTMLElement) return value[0];
  if (value?.element instanceof HTMLElement) return value.element;
  return null;
}
