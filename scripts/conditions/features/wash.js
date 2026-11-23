import { MODULE_ID, SETTINGS } from "../constants.js";
import { CONDITION_DEFINITIONS } from "../condition-definitions.js";
import { conditionKindUpdate, getConditionKind, getWashStage } from "../condition-kind.js";
import { isFeatureEnabled } from "../settings.js";
import { escapeHTML, localize, namesIncludeCondition, normalizeConditionName } from "../utils.js";
import { executeActorOperation, handleActorOperation, hasSocketHandler, registerSocketHandler } from "../../integration/socket-api.js";
import { getConditionItem } from "../services/condition-writes.js";
import { isUnknownWriteOutcome, runDocumentWrite, whisperToGM } from "../../document-writes.js";
import { makeSocketRequestId } from "../../socket-utils.js";

const WASH_OPERATION = "conditions.wash-transition";

function washItems(actor) {
  return Array.from(actor.items?.values?.() ?? actor.items ?? []).filter(item => item.type === "criticalInjury" && isWashCondition(item));
}

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
  if (typeof itemOrName === "object") return getConditionKind(itemOrName) === "wash";
  const name = typeof itemOrName === "string" ? itemOrName : itemOrName?.name;
  return namesIncludeCondition(getWashStateNames(), name);
}

export function getWashDisplayName(name) {
  const normalized = normalizeConditionName(name);
  return getWashStateNames().find(candidate => normalizeConditionName(candidate) === normalized) || String(name || "").trim();
}

export function getNextWashName(currentName) {
  if (typeof currentName === "object") currentName = getWashStage(currentName);
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
  if (!isPersistedWashStage(getConditionItem(actor, activeItem.id), getWashStage(activeItem))) return;

  const idsToDelete = washItems(actor)
    .filter(item => item.id !== activeItem.id)
    .map(item => item.id);

  if (!idsToDelete.length) return;

  await actor.deleteEmbeddedDocuments("Item", idsToDelete);
  if (idsToDelete.some(id => getConditionItem(actor, id))) throw new Error("Previous Wash state was not removed");
  ui.notifications.info(localize("Notifications.WashExclusive", "Wash state updated: “{name}” kept and older states removed.", { name: escapeHTML(activeItem.name) }));
}

export async function transitionWashLevel(actor, currentName, documentOptions = {}, expected = null) {
  return executeActorOperation(actor, WASH_OPERATION, { currentName, documentOptions, expected }, applyWashOperation);
}

export function initializeWashOperations() {
  if (hasSocketHandler(WASH_OPERATION)) return;
  registerSocketHandler(WASH_OPERATION, (payload, context) => handleActorOperation(payload, context, applyWashOperation));
}

function applyWashOperation(actor, { currentName, documentOptions, expected }) {
  return transitionWashLevelInternal(actor, currentName, {
    render: documentOptions?.render,
    fblqaSuppressNotifications: documentOptions?.fblqaSuppressNotifications === true
  }, { expected });
}

function isPersistedWashStage(item, stage) {
  return Boolean(stage && item?.type === "criticalInjury"
    && item.getFlag?.(MODULE_ID, "conditions.kind") === "wash"
    && item.getFlag?.(MODULE_ID, "conditions.washStage") === stage);
}

/** Execute a Wash step inside an existing Actor operation. */
export async function transitionWashLevelInternal(actor, currentName, documentOptions = {}, { expected, reportFailure = true } = {}) {
  const suppressNotifications = Boolean(documentOptions?.fblqaSuppressNotifications);
  const safeDocumentOptions = { ...(documentOptions ?? {}) };
  delete safeDocumentOptions.fblqaSuppressNotifications;
  if (!isFeatureEnabled(SETTINGS.FEATURE_WASH)) return { changed: false, reason: "feature-disabled" };

  const nextName = getNextWashName(currentName);
  if (!nextName) return { changed: false, reason: "no-next-state" };
  const previousName = getWashDisplayName(currentName);
  const currentStageMatches = () => washItems(actor).some(item => getWashStage(item) === previousName
    && (!expected || (item.id === expected.itemId
      && String((item._source?.system ?? item.system)?.healingTime ?? "") === expected.healingTime)));
  const stale = { changed: false, reason: "stale-stage", code: "stale-plan", previousName, nextName };
  if (!currentStageMatches()) return stale;

  const failed = (reason, cause, replacement) => {
    const outcomeUnknown = isUnknownWriteOutcome(cause);
    const partiallyApplied = Boolean(replacement);
    const details = { actor: actor.name, previous: previousName, next: nextName,
      replacement: replacement ? `${replacement.name} (${replacement.id})` : "—" };
    const error = outcomeUnknown
      ? localize("Notifications.WashOutcomeUnknown", "{actor}: the outcome of changing Wash from {previous} to {next} is unknown. Check the sheet before trying again.", details)
      : partiallyApplied
        ? localize("Notifications.WashPartialFailure", "{actor}: Wash replacement {replacement} is on the sheet, but the transition from {previous} to {next} failed. Verify both stages before trying again.", details)
        : localize("Notifications.WashTransitionFailed", "Could not change wash state to “{name}”. The previous state was kept.", { name: nextName });
    if (cause) console.error(`${MODULE_ID} | Wash transition failed`, reason, cause);
    if (reportFailure && (partiallyApplied || outcomeUnknown)) whisperToGM(error);
    if (!suppressNotifications && reportFailure) ui.notifications?.warn?.(escapeHTML(error));
    return { changed: false, reason, error, partiallyApplied, outcomeUnknown, previousName, nextName,
      code: outcomeUnknown ? "condition-outcome-unknown" : partiallyApplied ? "condition-partial-failure" : "write-not-persisted" };
  };

  const existing = washItems(actor).find(item => getWashStage(item) === nextName);
  let replacementId = existing?.id;
  const flags = conditionKindUpdate(existing);
  if (flags) {
    const { _id, ...update } = flags;
    try { await runDocumentWrite(() => existing.update(update, safeDocumentOptions)); }
    catch (error) { return failed("replacement-invalid", error, getConditionItem(actor, replacementId)); }
  }
  // A retry only needs to finish cleanup if the replacement already exists.
  if (!existing) {
    const newItemSource = await findWashConditionSource(nextName);
    if (!newItemSource) {
      const error = localize("Notifications.WashMissing", "Could not find wash state “{name}”. Check world items, compendiums, or the hidden washStateUuids setting.", { name: nextName });
      if (!suppressNotifications && reportFailure) ui.notifications?.warn?.(escapeHTML(error));
      return { changed: false, reason: "source-missing", error, previousName, nextName };
    }
    if (!currentStageMatches()) return stale;

    const itemData = newItemSource.toObject();
    replacementId = makeSocketRequestId(16);
    itemData._id = replacementId;
    itemData.flags ??= {};
    itemData.flags[MODULE_ID] ??= {};
    itemData.flags[MODULE_ID].conditions = { ...(itemData.flags[MODULE_ID].conditions ?? {}), kind: "wash", washStage: nextName };

    try {
      const createdItems = await runDocumentWrite(() => actor.createEmbeddedDocuments("Item", [itemData], {
        ...safeDocumentOptions,
        keepId: true,
        // The createItem hook normally enforces wash exclusivity. During an
        // explicit transition this function owns the whole create -> cleanup
        // sequence, so suppress the hook to avoid two concurrent deletions of the
        // same embedded Item collection.
        fblqaWashTransition: true
      }));
      replacementId = createdItems?.[0]?.id ?? replacementId;
    } catch (error) {
      const replacement = isUnknownWriteOutcome(error) ? null : getConditionItem(actor, replacementId);
      return failed(replacement ? "replacement-invalid" : "create-failed", error, replacement);
    }
  }

  const replacement = getConditionItem(actor, replacementId);
  if (!isPersistedWashStage(replacement, nextName)) {
    return failed(replacement ? "replacement-invalid" : "create-failed", null, replacement);
  }
  if (!currentStageMatches()) return failed("stale-stage", null, replacement);
  const staleIds = washItems(actor)
    .filter(item => item.id !== replacement.id)
    .map((item) => item.id);

  if (staleIds.length) {
    try {
      await runDocumentWrite(() => actor.deleteEmbeddedDocuments("Item", staleIds, safeDocumentOptions));
      if (staleIds.some(id => getConditionItem(actor, id))) throw new Error("Previous Wash state was not removed");
    } catch (error) {
      return failed("cleanup-failed", error, replacement);
    }
  }

  if (!suppressNotifications) ui.notifications.info(localize("Notifications.WashChanged", "Wash state changed: {previous} ➔ {next}.", { previous: escapeHTML(getWashDisplayName(currentName)), next: escapeHTML(nextName) }));
  return { changed: true, previousName: getWashDisplayName(currentName), nextName };
}
