import { MODULE_ID, flagUpdatePath } from "./constants.js";
import { CONDITION_DEFINITIONS } from "./condition-definitions.js";

const KINDS = new Set(["heat", "mor", "addiction", "wash", "arc"]);
const normalize = value => String(value ?? "").trim().toLocaleLowerCase();

/** Legacy names are only a fallback until a persistent kind has been assigned. */
export function getConditionKind(item) {
  const stored = item?.getFlag?.(MODULE_ID, "conditions.kind") ?? item?.flags?.[MODULE_ID]?.conditions?.kind;
  if (KINDS.has(stored)) return stored;
  const name = normalize(item?.name);
  if (CONDITION_DEFINITIONS.heat.names.some(value => normalize(value) === name)) return "heat";
  if (["\u043c\u043e\u0440", "mor"].includes(name)) return "mor";
  if (name.includes("\u0437\u0430\u0432\u0438\u0441\u0438\u043c\u043e\u0441\u0442\u044c") || name.includes("addiction")) return "addiction";
  if (CONDITION_DEFINITIONS.wash.names.some(value => normalize(value) === name)) return "wash";
  if (name.includes("[arc]") || name.includes("[\u0430\u0440\u043a\u0430]")) return "arc";
  return "";
}

export function getWashStage(item) {
  const stored = item?.getFlag?.(MODULE_ID, "conditions.washStage") ?? item?.flags?.[MODULE_ID]?.conditions?.washStage;
  return CONDITION_DEFINITIONS.wash.names.find(value => normalize(value) === normalize(stored ?? item?.name)) ?? null;
}

export function conditionKindUpdate(item) {
  if (item?.type !== "criticalInjury") return null;
  const kind = getConditionKind(item);
  if (!kind) return null;
  const update = { _id: item.id };
  if (item.getFlag?.(MODULE_ID, "conditions.kind") !== kind) update[flagUpdatePath("conditions.kind")] = kind;
  const stage = kind === "wash" ? getWashStage(item) : null;
  if (stage && item.getFlag?.(MODULE_ID, "conditions.washStage") !== stage) update[flagUpdatePath("conditions.washStage")] = stage;
  return Object.keys(update).length > 1 ? update : null;
}
