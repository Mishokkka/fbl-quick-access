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
import {
  buildSpecialCounterMigrationUpdate,
  getAddictionState,
  isAddictionCondition,
  needsAddictionModifierSync,
  updateAddictionModifiers
} from "./features/special-counters.js";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function getFlagData(document, scope, key) {
  const data = document?.flags?.[scope];
  if (!data) return undefined;
  return foundry.utils.getProperty(data, key);
}

function setIfMissing(update, document, key, value) {
  if (value === undefined) return false;
  if (document.getFlag?.(MODULE_ID, key) !== undefined) return false;
  update[flagUpdatePath(key)] = foundry.utils.deepClone(value);
  return true;
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

async function migrateLegacyActorFlags(actor) {
  const legacy = actor?.flags?.[LEGACY_MODULE_ID];
  if (!legacy) return false;

  const update = {};
  setIfMissing(update, actor, FLAGS.LIST, foundry.utils.getProperty(legacy, LEGACY_FLAGS.LIST));
  setIfMissing(update, actor, FLAGS.LAYOUT_COLUMNS, foundry.utils.getProperty(legacy, LEGACY_FLAGS.LAYOUT_COLUMNS));
  update[`flags.-=${LEGACY_MODULE_ID}`] = null;

  await actor.update(update, { render: false });
  return true;
}

async function migrateLegacyItemFlags(actor) {
  const itemUpdates = [];
  const mapping = [
    [LEGACY_FLAGS.ORDER, FLAGS.ORDER],
    [LEGACY_FLAGS.NOTES, FLAGS.NOTES],
    [LEGACY_FLAGS.TREATMENT_STATUS, FLAGS.TREATMENT_STATUS],
    [LEGACY_FLAGS.TREATMENT_DATA, FLAGS.TREATMENT_DATA],
    [LEGACY_FLAGS.ADDICTION_STATE, FLAGS.ADDICTION_STATE],
    [LEGACY_FLAGS.ADDICTION_MODIFIER_KEYS, FLAGS.ADDICTION_MODIFIER_KEYS],
    [LEGACY_FLAGS.HEAT_VALUE, FLAGS.HEAT_VALUE],
    [LEGACY_FLAGS.MOR_STATE, FLAGS.MOR_STATE]
  ];

  for (const item of actor.items ?? []) {
    const legacy = item?.flags?.[LEGACY_MODULE_ID];
    if (!legacy) continue;

    const update = { _id: item.id, [`flags.-=${LEGACY_MODULE_ID}`]: null };
    let hasData = false;

    for (const [legacyKey, currentKey] of mapping) {
      const value = foundry.utils.getProperty(legacy, legacyKey);
      if (value === undefined) continue;
      if (item.getFlag?.(MODULE_ID, currentKey) !== undefined) continue;
      update[flagUpdatePath(currentKey)] = foundry.utils.deepClone(value);
      hasData = true;
    }

    if (hasData || legacy) itemUpdates.push(update);
  }

  if (!itemUpdates.length) return false;
  await actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false });
  return true;
}


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
  const injuries = Array.from(actor.items ?? []).filter(item => item.type === "criticalInjury");
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
      if (isArcEntry(item.name) !== arcGroup) continue;
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
    await actor.update({ [flagUpdatePath(FLAGS.LIST)]: list }, { render: false });
  }
  if (itemUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false });
  }

  return { changed: customChanged || itemUpdates.length > 0, list };
}

export async function migrateActorData(actor) {
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return false;

  let changed = false;

  if (await migrateLegacyActorFlags(actor)) changed = true;
  if (await migrateLegacyItemFlags(actor)) changed = true;

  const customNormalization = normalizeCustomConditionList(foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAGS.LIST) || []));
  let customConditions = customNormalization.list;
  if (customNormalization.changed) {
    await actor.update({ [flagUpdatePath(FLAGS.LIST)]: customConditions }, { render: false });
    changed = true;
  }

  const ordering = await ensureConditionItemOrders(actor, customConditions);
  customConditions = ordering.list;
  if (ordering.changed) changed = true;

  const itemUpdates = actor.items
    .filter(item => item.type === "criticalInjury")
    .map(item => buildSpecialCounterMigrationUpdate(item))
    .filter(Boolean);

  if (itemUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false });
    changed = true;
  }

  const addictionItems = actor.items.filter(item => item.type === "criticalInjury" && isAddictionCondition(item));
  for (const item of addictionItems) {
    const state = getAddictionState(item);
    if (!needsAddictionModifierSync(item, state)) continue;
    await updateAddictionModifiers(item, state, { render: false });
    changed = true;
  }

  return changed;
}

export async function runWorldMigration() {
  if (!game.user.isGM) return;

  const current = Number(game.settings.get(MODULE_ID, SETTINGS.MIGRATION_VERSION) || 0);
  if (current >= MIGRATION_VERSION) return;

  await migrateLegacyWorldSettings();

  let changedActors = 0;
  for (const actor of game.actors) {
    try {
      if (await migrateActorData(actor)) changedActors += 1;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to migrate expanded condition data for actor ${actor?.name}`, err);
    }
  }

  await game.settings.set(MODULE_ID, SETTINGS.MIGRATION_VERSION, MIGRATION_VERSION);
  if (changedActors > 0) {
    ui.notifications.info(localize("Notifications.MigrationComplete", "Expanded Conditions migration complete. Actors updated: {count}.", { count: changedActors }));
  }
}
