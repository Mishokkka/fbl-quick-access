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
import { conditionKindUpdate, getConditionKind } from "./condition-kind.js";
import { clearDocumentFlagNullVerified, clonePlainJson, createCodedError, plainValuesEqual, readDocumentFlag, setDocumentFlagVerified } from "../document-writes.js";
import { getProperty } from "../actor-data.js";
import { enqueueActorMutationOperation } from "../operation-queue.js";
import {
  buildSpecialCounterMigrationUpdate,
  buildHeatModifierUpdate,
  getAddictionState,
  isAddictionCondition,
  needsAddictionModifierSync,
  needsHeatModifierSync,
  parseHeatValue,
  updateAddictionModifiers
} from "./features/special-counters.js";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function getActorItemById(actor, itemId) {
  if (!actor?.items || !itemId) return null;
  if (typeof actor.items.get === "function") return actor.items.get(itemId) ?? null;
  return Array.from(actor.items).find((item) => item?.id === itemId) ?? null;
}

function assertPersistedMigration(condition, message) {
  if (!condition) throw createCodedError("migration-write-not-persisted", message);
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
  if (Object.keys(update).length) {
    await actor.update(clonePlainJson(update), { render: false });
    assertMigrationFields(actor, update);
  }
  await actor.update({ [`flags.-=${LEGACY_MODULE_ID}`]: null }, { render: false });
  assertPersistedMigration(actor.flags?.[LEGACY_MODULE_ID] === undefined, `Legacy actor flags were not removed for ${actor.id}`);
  return true;
}

async function migrateLegacyItemFlags(actor) {
  const itemUpdates = [];
  const cleanupUpdates = [];
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

    const update = { _id: item.id };

    for (const [legacyKey, currentKey] of mapping) {
      const value = foundry.utils.getProperty(legacy, legacyKey);
      if (value === undefined) continue;
      if (item.getFlag?.(MODULE_ID, currentKey) !== undefined) continue;
      update[flagUpdatePath(currentKey)] = foundry.utils.deepClone(value);
    }

    if (Object.keys(update).length > 1) itemUpdates.push(update);
    cleanupUpdates.push({ _id: item.id, [`flags.-=${LEGACY_MODULE_ID}`]: null });
  }

  if (!cleanupUpdates.length) return false;
  await persistItemMigration(actor, itemUpdates);
  await actor.updateEmbeddedDocuments("Item", cleanupUpdates, { render: false });
  for (const update of cleanupUpdates) {
    const item = getActorItemById(actor, update._id);
    assertPersistedMigration(!item || item.flags?.[LEGACY_MODULE_ID] === undefined, `Legacy item flags were not removed for ${update._id}`);
  }
  return true;
}

function assertMigrationFields(document, fields) {
  for (const [path, expected] of Object.entries(fields)) {
    assertPersistedMigration(plainValuesEqual(getProperty(document._source ?? document, path), expected),
      `Migration did not preserve ${path} on ${document.id}`);
  }
}

async function persistItemMigration(actor, itemUpdates) {
  if (!itemUpdates.length) return;
  await actor.updateEmbeddedDocuments("Item", clonePlainJson(itemUpdates), { render: false });
  for (const { _id, ...fields } of itemUpdates) {
    const item = getActorItemById(actor, _id);
    if (item) assertMigrationFields(item, fields);
  }
}


const ORDER_MIGRATION = "conditions.pendingOrderMigration";
const COUNTER_MIGRATION = "conditions.pendingCounterMigration";

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
  const pending = readDocumentFlag(actor, MODULE_ID, ORDER_MIGRATION);
  const orders = pending ?? planConditionOrders(list, injuries);
  if (!orders.custom.length && !orders.items.length) return { changed: false, list };
  const options = { render: false };
  if (!pending) await setDocumentFlagVerified(actor, MODULE_ID, ORDER_MIGRATION, orders, options, { replace: true });
  await applyConditionOrders(actor, list, orders);
  return { changed: true, list };
}

export async function finishPendingConditionOrders(actor, list) {
  const pending = readDocumentFlag(actor, MODULE_ID, ORDER_MIGRATION);
  if (pending) await applyConditionOrders(actor, list, pending);
}

async function applyConditionOrders(actor, list, orders) {
  const options = { render: false };
  const customOrders = new Map(orders.custom);
  let customChanged = false;
  for (const condition of list) {
    const order = customOrders.get(condition.id);
    if (order === undefined || Number(condition.order) === order) continue;
    condition.order = order;
    customChanged = true;
  }
  if (customChanged) await setDocumentFlagVerified(actor, MODULE_ID, FLAGS.LIST, list, options);

  const itemOrders = orders.items.filter(([id, order]) => {
    const item = getActorItemById(actor, id);
    return item && item.getFlag?.(MODULE_ID, FLAGS.ORDER) !== order;
  });
  if (itemOrders.length) {
    const updates = itemOrders.map(([id, order]) => ({ _id: id, [flagUpdatePath(FLAGS.ORDER)]: order }));
    await actor.updateEmbeddedDocuments("Item", updates, options);
    for (const [id, order] of itemOrders) {
      const item = getActorItemById(actor, id);
      assertPersistedMigration(!item || item.getFlag?.(MODULE_ID, FLAGS.ORDER) === order,
        `Item condition order was not persisted for ${id}`);
    }
  }
  await clearDocumentFlagNullVerified(actor, MODULE_ID, ORDER_MIGRATION, options);
}

function planConditionOrders(list, injuries) {
  const orders = { custom: [], items: [] };
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
        if (Number(entry.condition.order) !== order) orders.custom.push([entry.condition.id, order]);
      } else if (entry.item.getFlag?.(MODULE_ID, FLAGS.ORDER) !== order) {
        orders.items.push([entry.item.id, order]);
      }
    });
  }
  return orders;
}

export async function migrateActorData(actor) {
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return false;

  let changed = await enqueueActorMutationOperation(actor, async () => {
    const actorMigrated = await migrateLegacyActorFlags(actor);
    const itemsMigrated = await migrateLegacyItemFlags(actor);
    const normalized = normalizeCustomConditionList(foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAGS.LIST) || []));
    if (normalized.changed) {
      await actor.update({ [flagUpdatePath(FLAGS.LIST)]: normalized.list }, { render: false });
      assertPersistedMigration(
        plainValuesEqual(actor.getFlag?.(MODULE_ID, FLAGS.LIST), normalized.list),
        `Normalized custom conditions were not persisted for ${actor.id}`
      );
    }
    const ordering = await ensureConditionItemOrders(actor, normalized.list);
    const countersMigrated = await migrateCounterTimers(actor);
    return actorMigrated || itemsMigrated || normalized.changed || ordering.changed || countersMigrated;
  });

  const addictionItems = Array.from(actor.items ?? []).filter(item => item.type === "criticalInjury" && isAddictionCondition(item));
  for (const item of addictionItems) {
    const state = getAddictionState(item);
    if (!needsAddictionModifierSync(item, state)) continue;
    await updateAddictionModifiers(item, state, { render: false });
    assertPersistedMigration(!needsAddictionModifierSync(item, state), `Addiction modifier sync was not persisted for ${item.id}`);
    changed = true;
  }

  for (const item of Array.from(actor.items ?? []).filter(item => item.type === "criticalInjury" && getConditionKind(item) === "heat")) {
    const value = parseHeatValue(item);
    if (!needsHeatModifierSync(item, value)) continue;
    await item.update(buildHeatModifierUpdate(value), { render: false });
    assertPersistedMigration(!needsHeatModifierSync(item, value), `Heat modifier sync was not persisted for ${item.id}`);
    changed = true;
  }

  return changed;
}

async function migrateCounterTimers(actor) {
  const options = { render: false };
  const finish = async plan => {
    const counters = plan.filter(({ id, kind, timer }) => {
      const item = getActorItemById(actor, id);
      return item && getConditionKind(item) === kind && item.system?.healingTime === timer;
    }).map(({ id, fields }) => ({ _id: id, ...Object.fromEntries(fields) }));
    await persistItemMigration(actor, counters.filter(({ _id, ...fields }) => {
      const item = getActorItemById(actor, _id);
      return Object.entries(fields).some(([path, expected]) => !plainValuesEqual(getProperty(item._source ?? item, path), expected));
    }));
    await persistItemMigration(actor, counters.map(({ _id }) => ({ _id, "system.healingTime": "" })));
    await clearDocumentFlagNullVerified(actor, MODULE_ID, COUNTER_MIGRATION, options);
  };

  const pending = readDocumentFlag(actor, MODULE_ID, COUNTER_MIGRATION);
  if (pending) await finish(pending);
  const plan = [];
  for (const item of Array.from(actor.items ?? [])) {
    if (item.type !== "criticalInjury") continue;
    const update = buildSpecialCounterMigrationUpdate(item);
    if (update) {
      const { _id: id, ...fields } = update;
      plan.push({ id, fields: Object.entries(fields), kind: getConditionKind(item), timer: item.system.healingTime });
    }
  }
  if (!plan.length) return Boolean(pending);
  await setDocumentFlagVerified(actor, MODULE_ID, COUNTER_MIGRATION, plan, options, { replace: true });
  await finish(plan);
  return true;
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
    if (actor?.type !== "character") continue;
    try {
      const kindUpdates = Array.from(actor.items ?? []).map(conditionKindUpdate).filter(Boolean);
      if (kindUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", kindUpdates, { render: false });
        for (const update of kindUpdates) {
          const item = getActorItemById(actor, update._id);
          assertPersistedMigration(!item || !conditionKindUpdate(item), `Condition kind was not persisted for ${update._id}`);
        }
      }
      const actorMigrated = await migrateActorData(actor);
      if (actorMigrated || kindUpdates.length) changedActors += 1;
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
