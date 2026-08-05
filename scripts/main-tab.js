import { FLAG_COMPACT_BORDERS, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { findApplicationRoot, findConditionHeader, findSheetHeaderCandidates } from "./sheet-adapter/forbidden-lands-v1.js";
import { rerenderSheet } from "./utils.js";

/**
 * Visual cleanup for native Forbidden Lands sheet sections.
 *
 * We do not rewrite templates. The module only adds scoped classes after the
 * sheet renders, then CSS removes the heavy decorative border images.
 */
export function isDecorativeBordersCompact(actor) {
  // Default to the compact view, preserving the visual behavior established by
  // earlier module versions. Players can switch it off per actor from MAIN.
  return actor?.getFlag?.(MODULE_ID, FLAG_COMPACT_BORDERS) !== false;
}

export function applyDecorativeBorderMode(root, enabled) {
  if (!root) return;

  // Always wipe module visual-mode classes first. Foundry may reuse sheet DOM
  // nodes between tab renders, and stale classes were enough to keep compact
  // border cleanup active even after the toggle was switched off.
  clearDecorativeCompactState(root);

  if (enabled) {
    // Compact mode is opt-in and scoped to this root. Without this class the
    // CSS must leave vanilla Forbidden Lands decorative borders alone.
    root.classList.add("fblqa-borderless-sheet");
  } else {
    // Native mode is mostly a marker for defensive CSS and future debugging.
    // The important part is that all compact classes have already been removed.
    root.classList.add("fblqa-native-borders");
  }
}

export function compactMainTab(mainTab, enabled = true) {
  if (!mainTab) return;
  mainTab.classList.remove("fblqa-main-compact");
  if (enabled) mainTab.classList.add("fblqa-main-compact");
}

export function setupDecorativeBorderToggle(app, actor, mainTab) {
  if (!mainTab || !actor) return;

  const header = findConditionHeader(mainTab);
  if (!header) return;

  const existing = header.querySelector(".fblqa-border-toggle-wrap");
  if (existing) {
    const input = existing.querySelector("input[type='checkbox']");
    if (input) {
      input.checked = isDecorativeBordersCompact(actor);
      input.disabled = !canModifyActor(actor);
    }
    return;
  }

  header.classList.add("fblqa-conditions-heading-with-toggle");

  const wrapper = document.createElement("span");
  wrapper.classList.add("fblqa-border-toggle-wrap");
  wrapper.title = qaLocalize("MainTab.BorderToggleTitle", "Включено: компактный режим без декоративных рамок. Выключено: штатные декоративные рамки.");

  const label = document.createElement("label");
  label.classList.add("fblqa-border-toggle");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = isDecorativeBordersCompact(actor);
  input.disabled = !canModifyActor(actor);
  input.setAttribute("aria-label", qaLocalize("MainTab.BorderToggleAria", "Компактный режим без декоративных рамок листа"));

  const slider = document.createElement("span");
  slider.classList.add("fblqa-border-toggle-slider");

  input.addEventListener("change", async (event) => {
    if (!canModifyActor(actor)) {
      event.currentTarget.checked = isDecorativeBordersCompact(actor);
      warnCannotModifyActor();
      return;
    }

    const enabled = event.currentTarget.checked;
    try {
      await actor.setFlag(MODULE_ID, FLAG_COMPACT_BORDERS, enabled);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to save decorative border preference`, error);
    }
    rerenderSheet(app);
  });

  label.append(input, slider);
  wrapper.append(label);
  header.append(wrapper);
}

export function applyItemSheetNoBorders(root) {
  if (!root) return;

  // Item sheets do not use the actor CONDITIONS toggle. For them we remove
  // decorative frames entirely, including old compact frame classes from
  // reused Foundry DOM nodes.
  clearDecorativeCompactState(root);
  root.classList.add("fblqa-item-no-borders");

  for (const element of root.querySelectorAll(".border, [class~='border']")) {
    if (element instanceof HTMLElement) element.classList.add("fblqa-item-borderless");
  }
}

export function compactSheetHeader(root, enabled = true) {
  if (!root) return;
  clearSheetHeaderCompact(root);
  if (!enabled) return;

  for (const element of findSheetHeaderCandidates(root)) {
    if (!(element instanceof HTMLElement)) continue;
    element.classList.add("fblqa-sheet-head-compact");

    // Some Forbidden Lands decorations are applied to nested border elements,
    // not the outer header. Mark them too so CSS can neutralize the actual rule.
    for (const nested of element.querySelectorAll(".border, [class~='border']")) {
      if (nested instanceof HTMLElement) nested.classList.add("fblqa-sheet-head-compact");
    }
  }
}


function clearDecorativeCompactState(root) {
  const classes = ["fblqa-borderless-sheet", "fblqa-native-borders", "fblqa-sheet-head-compact", "fblqa-main-compact", "fblqa-item-no-borders", "fblqa-item-borderless"];
  const scope = findApplicationRoot(root) ?? root;

  // ApplicationV1 hooks can hand this module slightly different inner roots.
  // Clear only the current Foundry application scope, never the whole document.
  scope.classList?.remove(...classes);

  for (const element of scope.querySelectorAll?.(
    ".fblqa-borderless-sheet, .fblqa-native-borders, .fblqa-sheet-head-compact, .fblqa-main-compact, .fblqa-item-no-borders, .fblqa-item-borderless"
  ) ?? []) {
    element.classList.remove(...classes);
  }
}

function clearSheetHeaderCompact(root) {
  root.classList.remove("fblqa-sheet-head-compact");
  for (const element of root.querySelectorAll(".fblqa-sheet-head-compact")) {
    element.classList.remove("fblqa-sheet-head-compact");
  }
}
