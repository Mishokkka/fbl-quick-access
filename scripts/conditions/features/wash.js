import { MODULE_ID, SETTINGS } from "../constants.js";
import { CONDITION_DEFINITIONS } from "../condition-definitions.js";
import { isFeatureEnabled } from "../settings.js";
import { escapeHTML, localize, namesIncludeCondition, normalizeConditionName } from "../utils.js";

export function getWashDefinition() {
  return CONDITION_DEFINITIONS.wash || {
    names: ["Я в раю", "Хорошенько помытый", "Помытый", "Немытый", "Вонючка", "Грязнуля"],
    progression: {
      "Я в раю": "Помытый",
      "Хорошенько помытый": "Немытый",
      "Помытый": "Немытый",
      "Немытый": "Вонючка",
      "Вонючка": "Грязнуля"
    },
    exclusive: true
  };
}

export function getWashStateNames() {
  return Array.from(getWashDefinition().names || []);
}

export function isWashCondition(itemOrName) {
  if (!isFeatureEnabled(SETTINGS.FEATURE_WASH)) return false;
  const name = typeof itemOrName === "string" ? itemOrName : itemOrName?.name;
  return namesIncludeCondition(getWashStateNames(), name);
}

export function getWashDisplayName(name) {
  const normalized = normalizeConditionName(name);
  return getWashStateNames().find(candidate => normalizeConditionName(candidate) === normalized) || String(name || "").trim();
}

export function getNextWashName(currentName) {
  const progression = getWashDefinition().progression || {};
  const normalized = normalizeConditionName(currentName);
  for (const [from, to] of Object.entries(progression)) {
    if (normalizeConditionName(from) === normalized) return to;
  }
  return null;
}

export async function findWashConditionSource(name) {
  const normalized = normalizeConditionName(name);
  const configuredUuids = game.settings.get(MODULE_ID, SETTINGS.WASH_STATE_UUIDS) || {};
  const configuredUuid = configuredUuids[name] || configuredUuids[getWashDisplayName(name)] || configuredUuids[normalized];
  if (configuredUuid) {
    const document = await fromUuid(configuredUuid);
    if (document?.type === "criticalInjury") return document;
  }

  const worldItem = game.items.find(item => item.type === "criticalInjury" && normalizeConditionName(item.name) === normalized);
  if (worldItem) return worldItem;

  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    const index = await pack.getIndex({ fields: ["name", "type"] });
    const entry = index.find(entry => entry.type === "criticalInjury" && normalizeConditionName(entry.name) === normalized);
    if (entry) return pack.getDocument(entry._id);
  }

  return null;
}

export async function removeOtherWashStates(actor, activeItem) {
  if (!actor || !activeItem || activeItem.type !== "criticalInjury" || !isWashCondition(activeItem)) return;

  const idsToDelete = actor.items
    .filter(item => item.type === "criticalInjury" && item.id !== activeItem.id && isWashCondition(item))
    .map(item => item.id);

  if (!idsToDelete.length) return;

  await actor.deleteEmbeddedDocuments("Item", idsToDelete);
  ui.notifications.info(localize("Notifications.WashExclusive", "Wash state updated: “{name}” kept and older states removed.", { name: escapeHTML(activeItem.name) }));
}

export async function transitionWashLevel(actor, currentName, documentOptions = {}) {
  const suppressNotifications = Boolean(documentOptions?.fblqaSuppressNotifications);
  const safeDocumentOptions = { ...(documentOptions ?? {}) };
  delete safeDocumentOptions.fblqaSuppressNotifications;
  if (!isFeatureEnabled(SETTINGS.FEATURE_WASH)) return { changed: false, reason: "feature-disabled" };

  const nextName = getNextWashName(currentName);
  if (!nextName) return { changed: false, reason: "no-next-state" };

  const newItemSource = await findWashConditionSource(nextName);
  if (!newItemSource) {
    if (!suppressNotifications) ui.notifications.warn(localize("Notifications.WashMissing", "Could not find wash state “{name}”. Check world items, compendiums, or the hidden washStateUuids setting.", { name: escapeHTML(nextName) }));
    return { changed: false, reason: "source-missing", previousName: getWashDisplayName(currentName), nextName };
  }

  const itemData = newItemSource.toObject();
  delete itemData._id;

  let createdItems;
  try {
    createdItems = await actor.createEmbeddedDocuments("Item", [itemData], {
      ...safeDocumentOptions,
      // The createItem hook normally enforces wash exclusivity. During an
      // explicit transition this function owns the whole create -> cleanup
      // sequence, so suppress the hook to avoid two concurrent deletions of the
      // same embedded Item collection.
      fblqaWashTransition: true
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not create replacement wash state`, error);
    if (!suppressNotifications) ui.notifications.error(localize("Notifications.WashTransitionFailed", "Could not change wash state to “{name}”. The previous state was kept.", { name: escapeHTML(nextName) }));
    return { changed: false, reason: "create-failed", previousName: getWashDisplayName(currentName), nextName };
  }

  const createdIds = new Set((createdItems ?? []).map((item) => item.id));
  const staleIds = actor.items
    .filter((item) => item.type === "criticalInjury" && isWashCondition(item) && !createdIds.has(item.id))
    .map((item) => item.id);

  if (staleIds.length) {
    try {
      await actor.deleteEmbeddedDocuments("Item", staleIds, safeDocumentOptions);
    } catch (error) {
      console.error(`${MODULE_ID} | could not remove stale wash states`, error);
      if (!suppressNotifications) ui.notifications.warn(localize("Notifications.WashCleanupFailed", "The new wash state was created, but an older wash state could not be removed."));
    }
  }

  if (!suppressNotifications) ui.notifications.info(localize("Notifications.WashChanged", "Wash state changed: {previous} ➔ {next}.", { previous: escapeHTML(getWashDisplayName(currentName)), next: escapeHTML(nextName) }));
  return { changed: true, previousName: getWashDisplayName(currentName), nextName };
}
