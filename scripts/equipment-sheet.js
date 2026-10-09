import { MODULE_ID } from "./constants.js";
import { buildSlots, getQuickCapacity, getStoredSlots } from "./quick-access.js";
import { qaLocalize } from "./i18n.js";
import { isForbiddenLandsCharacter } from "./utils.js";
import { findActorSheetRoot, findGearTab } from "./sheet-adapter/forbidden-lands-v1.js";

/** Refresh equipment without rebuilding the sheet or disturbing wallet controls. */
export function refreshEquipmentSheets(actor, changes) {
  const flags = changes?.flags?.[MODULE_ID];
  const relevant = ["slots", "equipmentHands"].some(key =>
    Object.hasOwn(changes ?? {}, `flags.${MODULE_ID}.${key}`) || Object.hasOwn(flags ?? {}, key));
  if (!relevant || !isForbiddenLandsCharacter(actor)) return;
  for (const app of Object.values(actor.apps ?? {})) {
    const root = findActorSheetRoot(app?.element);
    const gearTab = root ? findGearTab(root) : null;
    const panel = gearTab?.querySelector(".fblqa-panel");
    if (!panel) continue;
    const { capacity } = getQuickCapacity(actor);
    const slots = getStoredSlots(actor);
    panel.querySelector(".fblqa-slots")?.replaceWith(buildSlots(app, actor, capacity, slots));
    panel.querySelector(".fblqa-warning")?.remove();
    const hiddenCount = slots.slice(capacity).filter(Boolean).length;
    if (hiddenCount) {
      const warning = document.createElement("p");
      warning.className = "fblqa-warning";
      warning.textContent = qaLocalize("Panel.HiddenOverLimit", "Сверх лимита скрыто: {count}.", { count: hiddenCount });
      panel.append(warning);
    }
  }
}
