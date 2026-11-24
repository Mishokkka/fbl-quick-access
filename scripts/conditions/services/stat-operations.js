import { executeActorOperation, handleActorOperation, hasSocketHandler, registerSocketHandler } from "../../integration/socket-api.js";
import { decrementFirstInteger } from "../../new-day.js";
import { FLAGS, MODULE_ID, SETTINGS, flagDeletePath, flagUpdatePath } from "../constants.js";
import { conditionKindUpdate, getConditionKind, getWashStage } from "../condition-kind.js";
import { buildHeatModifierUpdate, isAddictionCondition, isHeatCondition, isMorCondition, parseHeatValue } from "../features/special-counters.js";
import { isWashCondition, removeOtherWashStates, transitionWashLevelInternal } from "../features/wash.js";
import { isPermanentTime, makeCustomCondition, normalizeCustomConditionList, parseStatDuration } from "../utils.js";
import { getConditionItem, updateConditionDocument, verifyConditionWrite } from "./condition-writes.js";

const STAT_OPERATION = "conditions.stat";
const OPTIONS = { render: false };
const EDIT_FIELDS = new Set(["name", "time", "notes", "desc"]);

export function initializeStatOperations() {
  if (hasSocketHandler(STAT_OPERATION)) return;
  registerSocketHandler(STAT_OPERATION, (payload, context) => handleActorOperation(payload, context, applyStatOperation));
}

export function runStatOperation(actor, command) {
  return executeActorOperation(actor, STAT_OPERATION, command, applyStatOperation);
}

export function readStatConditions(actor) {
  return normalizeCustomConditionList(actor.getFlag(MODULE_ID, FLAGS.LIST)).list;
}

function injuries(actor) {
  return Array.from(actor.items?.values?.() ?? actor.items ?? []).filter(item => item.type === "criticalInjury");
}

function adjustStatDuration(value, adjust) {
  const duration = parseStatDuration(value);
  if (!duration) return null;
  const afterNumber = Math.max(0, adjust(duration.count));
  if (!Number.isSafeInteger(afterNumber)) return null;
  const text = `${duration.prefix}${afterNumber}${duration.unit}`;
  return { afterNumber, afterText: decrementFirstInteger(text, 0)?.afterText ?? text };
}

async function writeActor(actor, update) {
  await updateConditionDocument(actor, update, OPTIONS);
}

async function writeItem(actor, item, update) {
  await updateConditionDocument(item, update, OPTIONS, () => getConditionItem(actor, item.id));
}

/** Apply a STAT command after entering the Actor's queue. */
export async function applyStatOperation(actor, command, user = globalThis.game?.user) {
  if (command.kind !== "item-created" && !user?.isGM && !game.settings.get(MODULE_ID, SETTINGS.PLAYERS_CAN_EDIT)) {
    throw new Error("STAT editing is disabled");
  }
  if (command.kind === "layout") {
    if (![1, 2].includes(command.columns)) throw new TypeError("Invalid STAT layout");
    await writeActor(actor, { [flagUpdatePath(FLAGS.LAYOUT_COLUMNS)]: command.columns });
    return { changed: true };
  }
  if (command.kind === "order") return applyRowOrder(actor, command.rows);
  if (command.kind.startsWith("custom-") || command.kind === "normalize") return applyCustomOperation(actor, command);

  const item = getConditionItem(actor, command.itemId);
  if (item?.type !== "criticalInjury") return { changed: false };
  return applyInjuryOperation(actor, item, command);
}

async function applyCustomOperation(actor, { kind, id, field, value, delta }) {
  const { list, changed } = normalizeCustomConditionList(actor.getFlag(MODULE_ID, FLAGS.LIST));
  const index = list.findIndex(condition => condition.id === id);
  if (kind === "normalize") {
    if (!changed) return { changed: false };
  } else if (kind === "custom-add") {
    const lastOrder = Math.max(0, ...list.map(entry => entry.order), ...injuries(actor).map(item => Number(item.getFlag(MODULE_ID, FLAGS.ORDER) ?? item.sort) || 0));
    list.push(makeCustomCondition({}, lastOrder + 10));
  } else if (index < 0) return { changed: false };
  else if (kind === "custom-remove") list.splice(index, 1);
  else if (kind === "custom-edit" && EDIT_FIELDS.has(field) && typeof value === "string") list[index][field] = value;
  else if (kind === "custom-time" && [-1, 1].includes(delta)) {
    const duration = adjustStatDuration(list[index].time, value => value + delta);
    if (!duration) return { changed: false, reason: "unresolved-duration" };
    list[index].time = duration.afterText;
  } else throw new TypeError("Invalid STAT list action");

  await writeActor(actor, { [flagUpdatePath(FLAGS.LIST)]: list });
  return { changed: true };
}

async function applyRowOrder(actor, rows) {
  const custom = readStatConditions(actor);
  const customById = new Map(custom.map(condition => [condition.id, condition]));
  const items = new Map(injuries(actor).map(item => [item.id, item]));
  const seen = new Set();
  if (!Array.isArray(rows) || rows.length !== custom.length + items.size) return { changed: false, reason: "stale-order" };
  const itemUpdates = [];
  let customChanged = false;
  for (const [index, { kind, id }] of rows.entries()) {
    const key = `${kind}:${id}`;
    const document = kind === "custom" ? customById.get(id) : kind === "item" ? items.get(id) : null;
    if (!document || seen.has(key)) return { changed: false, reason: "stale-order" };
    seen.add(key);
    const order = index * 10;
    if (kind === "custom" && document.order !== order) {
      document.order = order;
      customChanged = true;
    } else if (kind === "item" && document.getFlag(MODULE_ID, FLAGS.ORDER) !== order) {
      itemUpdates.push({ _id: id, [flagUpdatePath(FLAGS.ORDER)]: order });
    }
  }
  if (customChanged) await writeActor(actor, { [flagUpdatePath(FLAGS.LIST)]: custom.sort((a, b) => a.order - b.order) });
  if (itemUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", structuredClone(itemUpdates), OPTIONS);
    for (const { _id, ...update } of itemUpdates) verifyConditionWrite(getConditionItem(actor, _id), update);
  }
  return { changed: customChanged || itemUpdates.length > 0 };
}

async function applyInjuryOperation(actor, item, { kind, value, delta, action }) {
  if (kind === "item-created") {
    const kindUpdate = conditionKindUpdate(item);
    if (kindUpdate) {
      const { _id, ...update } = kindUpdate;
      await writeItem(actor, item, update);
    }
    const live = getConditionItem(actor, item.id);
    if (getConditionKind(live) === "heat") await writeItem(actor, live, buildHeatModifierUpdate(parseHeatValue(live)));
    if (isWashCondition(live)) await removeOtherWashStates(actor, live);
  } else if (kind === "item-delete") {
    await item.delete(OPTIONS);
    if (getConditionItem(actor, item.id)) throw new Error("STAT item was not deleted");
  } else if (kind === "item-name" && typeof value === "string") await writeItem(actor, item, { name: value });
  else if (kind === "item-notes" && typeof value === "string") await writeItem(actor, item, { [flagUpdatePath(FLAGS.NOTES)]: value });
  else if (kind === "stabilize") {
    if (item.system.lethal !== "yes") return { changed: false };
    await writeItem(actor, item, { "system.lethal": "no" });
  }
  else if ((kind === "healing-time" || kind === "lethal-limit") && [-1, 1].includes(delta)) {
    const field = kind === "healing-time" ? "healingTime" : "limit";
    const duration = adjustStatDuration(item.system?.[field] || "0", value => value + delta);
    if (!duration) return { changed: false, reason: "unresolved-duration" };
    if (field === "healingTime" && delta < 0 && duration.afterNumber === 0 && isWashCondition(item)) {
      return { ...await transitionWashLevelInternal(actor, getWashStage(item) ?? item.name, OPTIONS), refreshRows: true };
    }
    await writeItem(actor, item, { [`system.${field}`]: duration.afterText });
  } else if (kind === "treatment" || kind === "treatment-reset") return applyTreatment(actor, item, kind, action);
  else throw new TypeError("Invalid STAT item action");
  return { changed: true };
}

async function applyTreatment(actor, item, kind, action) {
  const data = item.getFlag(MODULE_ID, FLAGS.TREATMENT_DATA) ?? {};
  if (kind === "treatment-reset") {
    const update = { [flagDeletePath(FLAGS.TREATMENT_STATUS)]: null, [flagDeletePath(FLAGS.TREATMENT_DATA)]: null };
    if (data.originalHealingTime !== undefined) update["system.healingTime"] = data.originalHealingTime;
    await writeItem(actor, item, update);
    return { changed: true };
  }
  if (!["fail", "normal", "prof"].includes(action)) throw new TypeError("Invalid treatment action");
  if (item.system.lethal === "yes" || isPermanentTime(item.system.healingTime) || isWashCondition(item)
    || isHeatCondition(item) || isMorCondition(item) || isAddictionCondition(item)) return { changed: false };
  if (item.getFlag(MODULE_ID, FLAGS.TREATMENT_STATUS)) return { changed: false, reason: "treated" };
  const original = String(data.originalHealingTime ?? item.system.healingTime ?? "0");
  const duration = decrementFirstInteger(original, 0)
    ? adjustStatDuration(original, value => action === "fail" ? value * 2 : action === "prof" ? Math.ceil(value / 2) : value)
    : null;
  if (!duration && /\d/.test(original)) return { changed: false, reason: "unresolved-duration" };
  const adjusted = duration?.afterText ?? original;
  const update = {
    [flagUpdatePath(FLAGS.TREATMENT_STATUS)]: action,
    [flagUpdatePath(FLAGS.TREATMENT_DATA)]: { originalHealingTime: original, adjustedHealingTime: adjusted, action }
  };
  if (duration) update["system.healingTime"] = adjusted;
  await writeItem(actor, item, update);
  return { changed: true };
}
