import { MODULE_ID } from "./constants.js";
import { findActorSheetRoot } from "./sheet-adapter/forbidden-lands-v1.js";

const TALENT_RANK_INPUT = 'input[name="system.rank"]';
const TALENT_TYPE_SELECT = 'select[name="system.type"]';

/**
 * Forbidden Lands deliberately hides the Rank field for Kin talents because
 * the core rules treat them as unranked. Some tables use ranked Kin talents
 * (for example the Reforged Power option), so restore the native-looking field
 * only when the system template omitted it.
 *
 * The render hook runs after the native ItemSheet listeners are attached.
 * Therefore the injected input owns its small update listener instead of
 * relying on FormApplication's already-bound change handlers.
 */
export function ensureKinTalentRankField(app, item, root) {
  if (item?.type !== "talent") return false;

  const headerStats = root?.querySelector?.(".header-stats");
  if (!headerStats) return false;

  const typeSelect = headerStats.querySelector?.(TALENT_TYPE_SELECT);
  if (!typeSelect) return false;

  const talentType = String(typeSelect.value ?? item.system?.type ?? "").trim().toLowerCase();
  if (talentType !== "kin") return false;

  // Future system versions or another module may already expose the field.
  // In that case leave the native/third-party implementation untouched.
  if (headerStats.querySelector?.(TALENT_RANK_INPUT)) return false;

  const doc = headerStats.ownerDocument ?? globalThis.document;
  if (!doc?.createElement) return false;

  const label = doc.createElement("label");
  label.classList.add("fblqa-kin-talent-rank-label");
  label.textContent = globalThis.game?.i18n?.localize?.("TALENT.RANK") || "Rank";

  const rank = doc.createElement("div");
  rank.classList.add("rank", "fblqa-kin-talent-rank");

  const input = doc.createElement("input");
  input.name = "system.rank";
  input.type = "text";
  input.value = item.system?.rank == null ? "" : String(item.system.rank);
  input.disabled = app?.options?.editable === false || item.isOwner === false;

  input.addEventListener("change", async (event) => {
    const control = event.currentTarget;
    if (control?.disabled) return;

    try {
      await item.update({ "system.rank": control.value });
    } catch (error) {
      console.error(`${MODULE_ID} | failed to update Kin talent rank`, error);
      control.value = item.system?.rank == null ? "" : String(item.system.rank);
    }
  });

  rank.append(input);

  // Match the native talent-sheet order: Type, then Rank label and input.
  // Inserting both after the select in reverse order yields label -> field.
  typeSelect.insertAdjacentElement("afterend", rank);
  typeSelect.insertAdjacentElement("afterend", label);
  return true;
}

function renderKinTalentRank(app, htmlOrElement) {
  try {
    if (globalThis.game?.system?.id !== "forbidden-lands") return;

    const item = app?.item ?? app?.document ?? app?.object;
    if (item?.documentName !== "Item" || item.type !== "talent") return;

    const root = findActorSheetRoot(htmlOrElement);
    if (!root) return;

    ensureKinTalentRankField(app, item, root);
  } catch (error) {
    console.error(`${MODULE_ID} | Kin talent rank render failed`, error);
  }
}

Hooks.on("renderItemSheet", renderKinTalentRank);
Hooks.on("renderApplicationV2", renderKinTalentRank);
