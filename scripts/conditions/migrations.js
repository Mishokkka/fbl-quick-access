import {
  FLAGS,
  LEGACY_FLAGS,
  LEGACY_MODULE_ID,
  LEGACY_SETTINGS,
  MIGRATION_VERSION,
  MODULE_ID,
  SETTINGS,
  flagUpdatePath
} from "./constants.js";
import { localize, normalizeCustomConditionList } from "./utils.js";
import { getActiveGM } from "../integration/socket-api.js";
import { enqueueActorMutation } from "../operation-queue.js";
import { conditionKindUpdate, getConditionKind } from "./condition-kind.js";
import { getConditionItem, verifyConditionWrite } from "./services/condition-writes.js";
import {
  buildHeatModifierUpdate,
  getAddictionState,
  isAddictionCondition,
  migrateSpecialCounter,
  needsAddictionModifierSync,
  parseHeatValue,
  updateAddictionModifiers
} from "./features/special-counters.js";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function getLegacyWorldSetting(key) {
  const worldStorage = game.settings.storage?.get?.("world");
  const document = worldStorage?.get?.(`${LEGACY_MODULE_ID}.${key}`);
  if (!document) return undefined;
  if (hasOwn(document, "value")) return document.value;
  if (hasOwn(document, "_source") && hasOwn(document._source, "value")) return document._source.value;
  return undefined;
}

async function migrateLegacyWorldSettings() {
  const mapping = [
    [LEGACY_SETTINGS.FEATURE_HEAT, SETTINGS.FEATURE_HEAT],
    [LEGACY_SETTINGS.FEATURE_MOR, SETTINGS.FEATURE_MOR],
    [LEGACY_SETTINGS.FEATURE_ADDICTION, SETTINGS.FEATURE_ADDICTION],
    [LEGACY_SETTINGS.FEATURE_WASH, SETTINGS.FEATURE_WASH],
    [LEGACY_SETTINGS.CHAT_MESSAGES, SETTINGS.CHAT_MESSAGES],
    [LEGACY_SETTINGS.PLAYERS_CAN_EDIT, SETTINGS.PLAYERS_CAN_EDIT],
    [LEGACY_SETTINGS.WASH_STATE_UUIDS, SETTINGS.WASH_STATE_UUIDS]
  ];

  for (const [legacyKey, currentKey] of mapping) {
    const value = getLegacyWorldSetting(legacyKey);
    if (value !== undefined) await game.settings.set(MODULE_ID, currentKey, value);
  }
}

async function migrateLegacyFlags(document, readLive, mapping) {
  const legacy = document.flags?.[LEGACY_MODULE_ID];
  if (!legacy) return false;

  const expected = {}, writes = {}, removed = {};
  for (const [oldKey, newKey] of mapping) {
    const value = legacy[oldKey];
    if (value === undefined) continue;
    if (document.getFlag?.(MODULE_ID, newKey) === undefined) {
      const path = flagUpdatePath(newKey);
      expected[path] = foundry.utils.deepClone(value);
      writes[path] = foundry.utils.deepClone(expected[path]);
    }
    removed[`flags.${LEGACY_MODULE_ID}.-=${oldKey}`] = null;
  }
  const removedKeys = Object.keys(removed).length;
  if (!removedKeys) return false;

  const options = { render: false };
  if (Object.keys(writes).length) await document.update(writes, options);
  const live = readLive();
  verifyConditionWrite(live, expected);
  const cleanup = removedKeys === Object.keys(legacy).length ? { [`flags.-=${LEGACY_MODULE_ID}`]: null } : removed;
  await live.update(structuredClone(cleanup), options);
  verifyConditionWrite(readLive(), cleanup);
  return true;
}

const actorFlags = [[LEGACY_FLAGS.LIST, FLAGS.LIST], [LEGACY_FLAGS.LAYOUT_COLUMNS, FLAGS.LAYOUT_COLUMNS]];
const itemFlags = [
  [LEGACY_FLAGS.ORDER, FLAGS.ORDER],
  [LEGACY_FLAGS.NOTES, FLAGS.NOTES],
  [LEGACY_FLAGS.TREATMENT_STATUS, FLAGS.TREATMENT_STATUS],
  [LEGACY_FLAGS.TREATMENT_DATA, FLAGS.TREATMENT_DATA],
  [LEGACY_FLAGS.ADDICTION_STATE, FLAGS.ADDICTION_STATE],
  [LEGACY_FLAGS.ADDICTION_MODIFIER_KEYS, FLAGS.ADDICTION_MODIFIER_KEYS],
  [LEGACY_FLAGS.HEAT_VALUE, FLAGS.HEAT_VALUE],
  [LEGACY_FLAGS.MOR_STATE, FLAGS.MOR_STATE]
];

function isArcEntry(name) {
  const value = String(name || "").toUpperCase();
  return value.includes("[\u0410\u0420\u041a\u0410]") || value.includes("[ARC]");
}

/**
 * Persist a unique order for every STAT row. Foundry can reorder embedded
 * documents after an update when several items all use sort=0. Explicit
 * module order flags keep an edited row in place and make rerenders stable.
 */
export async function ensureConditionItemOrders(actor, customConditions = []) {
  if (!actor || actor.documentName !== "Actor") {
    return { changed: false, list: Array.isArray(customConditions) ? customConditions : [] };
  }

  const list = foundry.utils.deepClone(Array.isArray(customConditions) ? customConditions : []);
  const injuries = Array.from(actor.items?.values?.() ?? actor.items ?? []).filter(item => item.type === "criticalInjury");
  const itemUpdates = [];
  let customChanged = false;

  for (const arcGroup of [true, false]) {
    const entries = [];
    let stableIndex = 0;

    for (let index = 0; index < list.length; index += 1) {
      const condition = list[index];
      if (isArcEntry(condition.name) !== arcGroup) continue;
      entries.push({
        kind: "custom",
        condition,
        order: Number(condition.order ?? index * 10),
        stableIndex: stableIndex++
      });
    }

    for (let index = 0; index < injuries.length; index += 1) {
      const item = injuries[index];
      if ((getConditionKind(item) === "arc") !== arcGroup) continue;
      const explicit = item.getFlag?.(MODULE_ID, FLAGS.ORDER);
      const fallback = Number(item.sort ?? 10000 + index * 10);
      entries.push({
        kind: "item",
        item,
        order: Number(explicit ?? fallback),
        stableIndex: stableIndex++
      });
    }

    entries.sort((a, b) => {
      const orderDelta = (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0);
      return orderDelta || a.stableIndex - b.stableIndex;
    });

    entries.forEach((entry, index) => {
      const order = index * 10;
      if (entry.kind === "custom") {
        if (Number(entry.condition.order) !== order) {
          entry.condition.order = order;
          customChanged = true;
        }
        return;
      }

      if (Number(entry.item.getFlag?.(MODULE_ID, FLAGS.ORDER)) !== order) {
        itemUpdates.push({ _id: entry.item.id, [flagUpdatePath(FLAGS.ORDER)]: order });
      }
    });
  }

  if (customChanged) {
    const update = { [flagUpdatePath(FLAGS.LIST)]: list };
    await actor.update(structuredClone(update), { render: false });
    verifyConditionWrite(actor, update);
  }
  if (itemUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", structuredClone(itemUpdates), { render: false });
    for (const { _id, ...update } of itemUpdates) verifyConditionWrite(getConditionItem(actor, _id), update);
  }

  return { changed: customChanged || itemUpdates.length > 0, list };
}

export async function migrateActorData(actor) {
  if (!actor || actor.pack || actor.documentName !== "Actor" || actor.type !== "character") return false;
  return enqueueActorMutation(actor, () => migrateActorDataInternal(actor));
}

async function migrateActorDataInternal(actor) {
  let changed = false;
  if (await migrateLegacyFlags(actor, () => actor, actorFlags)) changed = true;
  const items = () => Array.from(actor.items?.values?.() ?? actor.items ?? []);
  for (const item of items()) {
    const readLive = () => getConditionItem(actor, item.id);
    if (await migrateLegacyFlags(item, readLive, itemFlags)) changed = true;
    const live = readLive();
    const kindUpdate = conditionKindUpdate(live);
    if (kindUpdate) {
      const { _id, ...update } = kindUpdate;
      await live.update(structuredClone(update), { render: false });
      verifyConditionWrite(readLive(), update);
      changed = true;
    }
    if (live?.type === "criticalInjury" && await migrateSpecialCounter(actor, live)) changed = true;
  }

  const customNormalization = normalizeCustomConditionList(foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAGS.LIST) || []));
  const customConditions = customNormalization.list;
  if (customNormalization.changed) {
    const update = { [flagUpdatePath(FLAGS.LIST)]: customConditions };
    await actor.update(structuredClone(update), { render: false });
    verifyConditionWrite(actor, update);
    changed = true;
  }

  const ordering = await ensureConditionItemOrders(actor, customConditions);
  if (ordering.changed) changed = true;

  const addictionItems = items().filter(item => item.type === "criticalInjury" && isAddictionCondition(item));
  for (const item of addictionItems) {
    const state = getAddictionState(item);
    if (!needsAddictionModifierSync(item, state)) continue;
    await updateAddictionModifiers(item, state, { render: false });
    changed = true;
  }

  for (const item of items().filter(item => item.type === "criticalInjury" && getConditionKind(item) === "heat")) {
    const update = buildHeatModifierUpdate(parseHeatValue(item));
    const current = item.system?.rollModifiers ?? {};
    const needsSync = Object.entries(update).some(([path, modifier]) => {
      const key = path.split(".").at(-1);
      if (key.startsWith("-=")) return current[key.slice(2)] !== undefined;
      return current[key]?.name !== modifier.name || String(current[key]?.value) !== modifier.value;
    });
    if (needsSync) {
      await item.update(structuredClone(update), { render: false });
      verifyConditionWrite(getConditionItem(actor, item.id), update);
      changed = true;
    }
  }

  return changed;
}

export async function runWorldMigration() {
  const activeGM = getActiveGM();
  if (!game.user?.isGM || activeGM?.id !== game.user.id) return;

  const current = Number(game.settings.get(MODULE_ID, SETTINGS.MIGRATION_VERSION) || 0);
  if (current >= MIGRATION_VERSION) return;

  let failures = 0;
  let changedActors = 0;

  try {
    // Version 7 already imported legacy preferences. A modifier-only upgrade
    // must not overwrite preferences changed since that import.
    if (current < 7) await migrateLegacyWorldSettings();
  } catch (error) {
    failures += 1;
    console.error(`${MODULE_ID} | Failed to migrate expanded condition world settings`, error);
  }

  for (const actor of game.actors) {
    try {
      if (await migrateActorData(actor)) changedActors += 1;
    } catch (error) {
      failures += 1;
      console.warn(`${MODULE_ID} | Failed to migrate expanded condition data for actor ${actor?.name}`, error);
    }
  }

  if (failures > 0) {
    ui.notifications.error(localize("Notifications.MigrationFailed", "Expanded Conditions migration was not completed. Failed operations: {count}. It will be retried on the next load.", { count: failures }));
    return;
  }

  await game.settings.set(MODULE_ID, SETTINGS.MIGRATION_VERSION, MIGRATION_VERSION);
  if (changedActors > 0) {
    ui.notifications.info(localize("Notifications.MigrationComplete", "Expanded Conditions migration complete. Actors updated: {count}.", { count: changedActors }));
  }
}
