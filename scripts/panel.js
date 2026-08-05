import { MAX_SLOTS } from "./constants.js";
import { getEncumbrance } from "./encumbrance.js";
import { getQuickCapacity, getStoredSlots, buildSlots } from "./quick-access.js";
import { buildExpandedWalletLine, buildWalletControl, isWalletExpanded } from "./wallet.js";
import { findOriginalCurrencyContainers, findOriginalGearTopControls, findPrimaryGearContainer } from "./sheet-adapter/forbidden-lands-v1.js";
import { qaLocalize } from "./i18n.js";
import { formatNumber } from "./utils.js";

export function buildPanel(app, actor) {
  const { capacity, agilityMax, sleightOfHand } = getQuickCapacity(actor);
  const storedSlots = getStoredSlots(actor);
  const hiddenCount = storedSlots.slice(capacity).filter(Boolean).length;

  const panel = document.createElement("section");
  panel.classList.add("fblqa-panel");
  panel.dataset.actorId = actor.id;
  panel.setAttribute(
    "aria-label",
    qaLocalize("Panel.Aria", "Вес, быстрый доступ и валюта. Быстрый доступ: {capacity}/{maxSlots} слотов, Agility {agilityMax} + Sleight of Hand {sleightOfHand}", { capacity, maxSlots: MAX_SLOTS, agilityMax, sleightOfHand })
  );

  const line = document.createElement("div");
  line.classList.add("fblqa-line");

  const leftControls = document.createElement("div");
  leftControls.classList.add("fblqa-left-controls");
  leftControls.append(buildEncumbranceBox(actor));

  const walletExpanded = isWalletExpanded(actor);

  line.append(leftControls);
  line.append(buildSlots(app, actor, capacity, storedSlots));
  if (!walletExpanded) line.append(buildWalletControl(app, actor));
  panel.append(line);

  if (walletExpanded) panel.append(buildExpandedWalletLine(app, actor));

  if (hiddenCount > 0) {
    const warning = document.createElement("p");
    warning.classList.add("fblqa-warning");
    warning.textContent = qaLocalize("Panel.HiddenOverLimit", "Сверх лимита скрыто: {count}.", { count: hiddenCount });
    panel.append(warning);
  }

  return panel;
}

function buildEncumbranceBox(actor) {
  const { value, max, over } = getEncumbrance(actor);

  const box = document.createElement("div");
  box.classList.add("fblqa-encumbrance");
  if (over) box.classList.add("fblqa-overencumbered");
  box.title = qaLocalize("Panel.Encumbrance", "Переносимый / максимальный вес");
  box.setAttribute("aria-label", qaLocalize("Panel.Encumbrance", "Переносимый / максимальный вес"));

  const current = document.createElement("span");
  current.classList.add("fblqa-encumbrance-current");
  current.textContent = formatNumber(value);

  const separator = document.createElement("span");
  separator.classList.add("fblqa-encumbrance-separator");
  separator.textContent = "/";

  const maximum = document.createElement("span");
  maximum.classList.add("fblqa-encumbrance-max");
  maximum.textContent = formatNumber(max);

  box.append(current, separator, maximum);
  return box;
}

export function hideOriginalGearTopControls(gearTab, panel) {
  // The module renders replacements, then hides the original currency and encumbrance controls.
  for (const element of findOriginalCurrencyContainers(gearTab, panel)) {
    element.classList.add("fblqa-original-hidden");
  }

  for (const element of findOriginalGearTopControls(gearTab, panel)) {
    element.classList.add("fblqa-original-hidden");
  }
}

export function compactOriginalGearSpacing(gearTab, panel) {
  if (!gearTab || !panel) return;

  const gears = findPrimaryGearContainer(gearTab, panel);
  if (!gears) return;

  gears.classList.add("fblqa-gears-compacted");

  const firstVisible = [...gears.children].find((element) => {
    return !element.classList.contains("fblqa-original-hidden") && element.offsetParent !== null;
  });

  if (firstVisible) firstVisible.classList.add("fblqa-first-visible-gear-block");
}
