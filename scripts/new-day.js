import { FLAG_SHORT_REST_RECOVERY, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { getConditionKind, getWashStage } from "./conditions/condition-kind.js";
import { getProperty } from "./actor-data.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, rerenderSheet } from "./utils.js";
import { createFoundryDialog, extractDialogElement, findDialogForm, hasFoundryDialogApi } from "./dialogs.js";
import { FLAGS as CONDITION_FLAGS } from "./conditions/constants.js";
import { createChatMessage, isPermanentTime } from "./conditions/utils.js";
import { getNextWashName, isWashCondition, transitionWashLevelInternal } from "./conditions/features/wash.js";
import {
  getAddictionState,
  isAddictionCondition
} from "./conditions/features/special-counters.js";
import { getAddictionDayKey, getAddictionMorning, getPendingAddictions, processAddictionNewDayInternal } from "./conditions/services/addiction-service.js";
import {
  applyNewDayProviderActionInternal,
  buildNewDayProviderActions,
  describeNewDayProviderAction,
  getNewDayProviderCategory,
  getNewDayProviderIcon,
  getNewDayProviders,
  getProviderActionSignature
} from "./integration/new-day-providers.js";
import { executeActorOperation, getActiveGM, handleActorOperation, registerSocketHandler } from "./integration/socket-api.js";
import { documentValuesEqual, getDocumentWriteMismatches, isUnknownWriteOutcome, readActorFlag, runDocumentWrite, whisperToGM } from "./document-writes.js";

const NEW_DAY_OPERATION = "new-day.apply";

export function initializeNewDayOperations() {
  registerSocketHandler(NEW_DAY_OPERATION, (payload, context) =>
    handleActorOperation(payload, context, (actor, request) => applySubmittedNewDay(actor, request, context)), { addressed: true });
}

const CORE_CATEGORIES = Object.freeze([
  { id: "injuries", order: 100 },
  { id: "wash", order: 200 },
  { id: "conditions", order: 300 },
  { id: "addiction", order: 350 },
  { id: "system", order: 1000 }
]);

export function decrementFirstInteger(value, amount = 1) {
  const text = String(value ?? "");
  // A free-text description is not a duration. Preserve unknown units/formulas
  // for manual resolution instead of interpreting their first digit as days.
  const match = text.match(/^\s*(\d+)(?:\s*(?:day(?:s|\(s\))?|день|дня|дней|сутки|суток))?\s*$/iu);
  if (!match) return null;
  const current = Number(match[1]);
  if (!Number.isSafeInteger(current)) return null;
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  const next = Math.max(0, current - amount);
  const replaced = text.replace(match[1], String(next));
  return {
    beforeNumber: current,
    afterNumber: next,
    beforeText: text,
    afterText: normalizeDayUnit(replaced, next)
  };
}

function normalizeDayUnit(text, value) {
  let normalized = String(text ?? "");

  if (/\bday(?:s|\(s\))?(?=\s|$)/i.test(normalized)) {
    normalized = normalized.replace(/\bday(?:s|\(s\))?(?=\s|$)/i, Number(value) === 1 ? "day" : "days");
  }

  if (/(?:^|\s)(?:день|дня|дней)(?=\s|$)/iu.test(normalized)) {
    const absolute = Math.abs(Number(value) || 0);
    const mod100 = absolute % 100;
    const mod10 = absolute % 10;
    const unit = mod100 >= 11 && mod100 <= 14
      ? "дней"
      : mod10 === 1
        ? "день"
        : mod10 >= 2 && mod10 <= 4
          ? "дня"
          : "дней";
    normalized = normalized.replace(/(?:день|дня|дней)(?=\s|$)/iu, unit);
  }

  if (/(?:сутки|суток)(?=\s|$)/iu.test(normalized)) {
    const lastTwo = value % 100;
    const ending = value % 10;
    const unit = (lastTwo < 11 || lastTwo > 14) && ending >= 1 && ending <= 4 ? "сутки" : "суток";
    normalized = normalized.replace(/(?:сутки|суток)(?=\s|$)/iu, unit);
  }

  return normalized;
}

export function isDailyLethalLimit(value) {
  return decrementFirstInteger(value) !== null;
}

export function buildNewDayPlan(actor, options = {}) {
  const actions = [];
  const items = getActorItems(actor);
  const pendingItems = getPendingAddictions(actor);
  const blockedByAddiction = pendingItems.length > 0;
  const dayKey = getAddictionDayKey(actor, { ...options, newDay: true });

  for (const item of items) {
    if (item?.type !== "criticalInjury") continue;
    if (blockedByAddiction && !pendingItems.includes(item)) continue;
    const itemName = String(item.name ?? qaLocalize("NewDay.UnnamedEntry", "Без названия"));
    const conditionKind = getConditionKind(item);

    if (isAddictionCondition(item)) {
      actions.push({
        id: `addiction:${item.id}:day`,
        kind: "addiction-day",
        category: "addiction",
        itemId: item.id,
        itemName,
        checked: true,
        dayKey: getAddictionMorning(item)?.status === "pending" ? getAddictionMorning(item).dayKey : dayKey,
        pending: getAddictionMorning(item)?.status === "pending",
        state: getAddictionState(item)
      });
      continue;
    }

    if (["heat", "mor", "arc", "addiction"].includes(conditionKind) || (conditionKind === "wash" && !isWashCondition(item))) continue;

    const timerData = item._source?.system ?? item.system;
    const healingTime = timerData?.healingTime;
    const healing = decrementFirstInteger(healingTime, 1);
    const healingIsPermanent = isPermanentTime(healingTime);

    if (isWashCondition(item)) {
      if (healing && !healingIsPermanent) {
        const nextWashName = getNextWashName(item);
        if (healing.afterNumber === 0 && nextWashName) {
          actions.push({
            id: `wash:${item.id}:transition`,
            kind: "wash-transition",
            category: "wash",
            itemId: item.id,
            itemName,
            checked: true,
            beforeText: healing.beforeText,
            afterText: nextWashName,
            nextWashName
          });
        } else if (healing.beforeNumber > 0) {
          actions.push({
            id: `wash:${item.id}:timer`,
            kind: "wash-timer",
            category: "wash",
            itemId: item.id,
            itemName,
            checked: true,
            beforeText: healing.beforeText,
            afterText: healing.afterText
          });
        }
      }
      continue;
    }

    const injuryExpires = Boolean(healing && !healingIsPermanent && healing.afterNumber === 0);
    if (injuryExpires) {
      actions.push({
        id: `injury:${item.id}:expire`,
        kind: "injury-expire",
        category: "injuries",
        itemId: item.id,
        itemName,
        checked: true,
        beforeText: healing.beforeText,
        afterText: healing.afterText
      });
    } else if (healing && healing.beforeNumber > 0 && !healingIsPermanent) {
      actions.push({
        id: `injury:${item.id}:healing`,
        kind: "injury-healing",
        category: "injuries",
        itemId: item.id,
        itemName,
        checked: true,
        beforeText: healing.beforeText,
        afterText: healing.afterText
      });
    }

    if (!injuryExpires && item.system?.lethal === "yes") {
      const limit = decrementFirstInteger(timerData?.limit, 1);
      if (limit && limit.beforeNumber > 0) {
        actions.push({
          id: `injury:${item.id}:lethal`,
          kind: "lethal-limit",
          category: "injuries",
          itemId: item.id,
          itemName,
          checked: true,
          warning: limit.afterNumber === 0,
          beforeText: limit.beforeText,
          afterText: limit.afterText
        });
      }
    }
  }

  const customConditions = blockedByAddiction ? [] : getCustomConditions(actor);
  for (const condition of customConditions) {
    if (isArcName(condition?.name)) continue;
    const timer = decrementFirstInteger(condition?.time, 1);
    if (!timer || isPermanentTime(condition?.time) || timer.beforeNumber === 0) continue;

    const expires = timer.afterNumber === 0;

    actions.push({
      id: `custom:${condition.id}:${expires ? "expire" : "timer"}`,
      kind: expires ? "custom-condition-expire" : "custom-condition",
      category: "conditions",
      conditionId: condition.id,
      itemName: String(condition.name || qaLocalize("NewDay.UnnamedCondition", "Состояние без названия")),
      checked: true,
      beforeText: timer.beforeText,
      afterText: timer.afterText
    });
  }

  if (!blockedByAddiction) actions.push({
    id: "system:short-rest-reset",
    kind: "short-rest-reset",
    category: "system",
    checked: true,
    itemName: qaLocalize("NewDay.ShortRestReset", "Сбросить лимит восстановления Short Rest")
  });

  const categories = buildPlanCategories();
  sortNewDayActions(actions, categories);

  return {
    actorId: actor?.id ?? "", actorName: actor?.name ?? "", actions, categories, providerErrors: [],
    blockedByAddiction, dayKey,
    preconditions: Object.fromEntries(actions.map(action => [action.id, actionPrecondition(actor, action)]))
  };
}

function actionPrecondition(actor, action) {
  if (action.providerId) return getProviderActionSignature(action);
  if (action.kind === "short-rest-reset") return JSON.stringify(readActorFlag(actor, FLAG_SHORT_REST_RECOVERY));
  if (action.conditionId) {
    const condition = getCustomConditions(actor).find(entry => entry.id === action.conditionId);
    return JSON.stringify(condition ? [condition.time, condition.name] : null);
  }
  const item = getActorItem(actor, action.itemId);
  if (!item) return "missing";
  if (action.kind === "addiction-day") return JSON.stringify([getConditionKind(item), isAddictionCondition(item), getAddictionState(item), getAddictionMorning(item)]);
  const timers = item._source?.system ?? item.system;
  const value = action.kind === "lethal-limit" ? timers?.limit : timers?.healingTime;
  return JSON.stringify([item.type, item.name, value, item.system?.lethal, getConditionKind(item), getWashStage(item)]);
}

function assertActionCurrent(actor, plan, action) {
  const expected = plan?.preconditions?.[action.id];
  if (expected !== undefined && expected !== actionPrecondition(actor, action)) {
    throw Object.assign(stalePlanError(), { actions: [action] });
  }
}

/**
 * Build the complete plan, including actions supplied by registered modules.
 * The legacy buildNewDayPlan() remains synchronous for backwards compatibility.
 */
export async function buildNewDayPlanWithProviders(actor, options = {}) {
  const plan = buildNewDayPlan(actor, options);
  if (plan.blockedByAddiction) return plan;
  const providerResult = await buildNewDayProviderActions(actor, options.authority);
  plan.actions.push(...providerResult.actions);
  plan.providerErrors = providerResult.errors;
  for (const action of providerResult.actions) plan.preconditions[action.id] = actionPrecondition(actor, action);
  plan.categories = buildPlanCategories(plan.actions);
  sortNewDayActions(plan.actions, plan.categories);
  return plan;
}

export function getNewDaySelection(plan, selectedIds) {
  const selected = new Set(selectedIds ?? []);
  const actions = plan.actions.filter(action => selected.has(action.id));
  return {
    selectedIds: actions.map(action => action.id),
    selectedPreconditions: Object.fromEntries(actions.map(action => [action.id, plan.preconditions[action.id]]))
  };
}

export function readNewDaySelection(payload) {
  if (!Array.isArray(payload?.selectedIds) || payload.selectedIds.length > 250) {
    throw new TypeError("Invalid New Day action list");
  }
  const ids = [...new Set(payload.selectedIds)];
  if (ids.some(id => typeof id !== "string" || !id || id.length > 240)) throw new TypeError("Invalid New Day action id");
  return ids;
}

export function getStaleNewDayActions(plan, selectedIds, preconditions) {
  const actions = new Map(plan.actions.map(action => [action.id, action]));
  return selectedIds.filter(id => !actions.has(id) || !preconditions || !Object.hasOwn(preconditions, id)
    || preconditions[id] !== plan.preconditions[id]).map(id => actions.get(id) ?? { id, itemName: id });
}

export async function applyNewDayPlan(actor, plan, selectedActionIds, options = {}) {
  if (!actor) return newDayResult(0);
  const selection = getNewDaySelection(plan, selectedActionIds);
  if (!selection.selectedIds.length) return newDayResult(0);
  const request = { ...selection, dayKey: plan.dayKey, blockedByAddiction: plan.blockedByAddiction,
    postChat: options.postChat !== false, suppressNotifications: Boolean(options.suppressNotifications),
    render: options.documentOptions?.render };
  const result = await executeActorOperation(actor, NEW_DAY_OPERATION, request, (live, payload, user) =>
    applySubmittedNewDay(live, payload, { requestUser: user, requesterId: user?.id, activeGM: getActiveGM(), isRemote: false }));
  if (request.postChat && (result.succeeded.length || result.failed.some(entry => entry.code !== "stale-plan"))) {
    try {
      await runDocumentWrite(() => postNewDaySummary(actor, result.succeeded, result.failed));
    } catch (error) {
      result.notificationError = String(error?.message ?? error);
      console.error(`${MODULE_ID} | new-day summary failed`, error);
    }
  }
  return result;
}

async function applySubmittedNewDay(actor, request, authority) {
  const ids = readNewDaySelection(request);
  const wantsProvider = ids.some(id => id.startsWith("provider:"));
  const plan = wantsProvider ? await buildNewDayPlanWithProviders(actor, { authority }) : buildNewDayPlan(actor);
  if (authority.activeGM?.id !== getActiveGM()?.id) throw new Error("The active GM changed");
  const user = authority.requestUser;
  const ownsActor = authority.isRemote ? actor.testUserPermission?.(user, "OWNER") : actor.isOwner;
  if (user?.active === false || (!user?.isGM && !ownsActor)) throw new Error("New Day requires Actor ownership");
  const result = newDayResult(ids.length);
  const wholePlanStale = request.dayKey !== getAddictionDayKey(actor, { newDay: true })
    || request.blockedByAddiction !== Boolean(getPendingAddictions(actor).length);
  const stale = wholePlanStale ? ids.map(id => plan.actions.find(action => action.id === id) ?? { id, itemName: id })
    : getStaleNewDayActions(plan, ids, request.selectedPreconditions);
  if (stale.length) {
    result.failed = stale.map(action => failureResult(action, stalePlanError()));
    return result;
  }
  return applyNewDayPlanInternal(actor, plan, ids, {
    authority, postChat: request.postChat !== false, suppressNotifications: request.suppressNotifications === true,
    documentOptions: request.render === false ? { render: false } : {}
  });
}

function newDayResult(selected) {
  return { changed: false, selected, succeeded: [], failed: [], pending: [], partiallyApplied: false,
    outcomeUnknown: false, notificationError: null };
}

/** Apply a validated selection while the caller holds the Actor queue. */
export async function applyNewDayPlanInternal(actor, plan, selectedIds, options = {}) {
  const selected = new Set(selectedIds);
  const actions = plan.actions.filter(action => selected.has(action.id));
  const result = newDayResult(actions.length);
  const { authority, documentOptions = {}, postChat = true, suppressNotifications = false } = options;
  const itemUpdates = actions.filter(action => getItemTimerUpdate(action));
  const itemDeletes = actions.filter(action => !action.providerId && action.kind === "injury-expire");
  const customActions = actions.filter(action => !action.providerId && action.conditionId);
  const individualActions = actions.filter(action => !itemUpdates.includes(action) && !itemDeletes.includes(action) && !customActions.includes(action));

  let currentActions = actions;
  try {
    for (const action of actions) assertActionCurrent(actor, plan, action);

    for (const [batch, deleting] of [[itemUpdates, false], [itemDeletes, true]]) {
      if (!batch.length) continue;
      currentActions = batch;
      for (const action of batch) assertActionCurrent(actor, plan, action);
      await applyItemBatch(actor, batch, deleting, documentOptions, result.succeeded);
    }

    if (customActions.length) {
      currentActions = customActions;
      for (const action of customActions) assertActionCurrent(actor, plan, action);
      const byId = new Map(customActions.map(action => [action.conditionId, action]));
      const nextConditions = getCustomConditions(actor).flatMap(condition => {
        const action = byId.get(condition.id);
        if (!action) return [condition];
        if (action.kind === "custom-condition-expire") return [];
        return [{ ...condition, time: action.afterText }];
      });
      await writeNewDayFlag(actor, CONDITION_FLAGS.LIST, nextConditions, documentOptions);
      result.succeeded.push(...customActions.map(action => successResult(action)));
    }

    for (const action of individualActions) {
      currentActions = [action];
      assertActionCurrent(actor, plan, action);
      if (action.providerId) {
        const suppressChat = Boolean(authority?.requestUser?.isGM && !authority.isRemote && !postChat);
        const applied = await applyNewDayProviderActionInternal(actor, action, authority, suppressChat);
        result.succeeded.push(successResult(action, applied));
      } else if (action.kind === "short-rest-reset") {
        const changed = readActorFlag(actor, FLAG_SHORT_REST_RECOVERY) != null;
        if (changed) await writeNewDayFlag(actor, FLAG_SHORT_REST_RECOVERY, null, documentOptions);
        result.succeeded.push(successResult(action, { changed }));
      } else if (action.kind === "wash-transition") {
        const item = getActorItem(actor, action.itemId);
        const transition = await transitionWashLevelInternal(actor, getWashStage(item) ?? item?.name, {
          ...documentOptions, fblqaSuppressNotifications: suppressNotifications
        }, { expected: { itemId: action.itemId, healingTime: action.beforeText }, reportFailure: false });
        if (!transition.changed) {
          throw Object.assign(new Error(transition.error ?? transition.reason), {
            code: transition.code, partiallyApplied: transition.partiallyApplied
          });
        }
        result.succeeded.push(successResult(action));
      } else if (action.kind === "addiction-day") {
        const addiction = await processAddictionNewDayInternal(actor, getActorItem(actor, action.itemId), {
          dayKey: action.dayKey, postChat, notify: !suppressNotifications, documentOptions, reportFailure: false, deferChat: true
        });
        if (addiction.skipped) throw stalePlanError();
        result.succeeded.push(successResult(action, {
          changed: addiction.changed, pending: addiction.pending, summary: formatAddictionNewDayResult(addiction)
        }));
      }
    }
  } catch (error) {
    result.failed = (error.actions ?? currentActions).map(action => failureResult(action, error));
    result.outcomeUnknown = isUnknownWriteOutcome(error);
    result.partiallyApplied = Boolean(error.partiallyApplied || result.succeeded.some(entry => entry.changed));
    const stale = ["stale-plan", "stale-provider-action"].includes(error.code);
    if (!stale || result.partiallyApplied || result.outcomeUnknown) reportNewDayFailure(actor, result, options.dateLabel);
    console.error(`${MODULE_ID} | New Day stopped`, actor.name, error);
  }
  result.changed = result.partiallyApplied || result.succeeded.some(entry => entry.changed);
  result.pending = result.succeeded.filter(entry => entry.pending);
  return result;
}

function getItemTimerUpdate(action) {
  if (action.providerId) return null;
  if (action.kind === "injury-healing" || action.kind === "wash-timer") return { "system.healingTime": action.afterText };
  if (action.kind === "lethal-limit") return { "system.limit": action.afterText };
  return null;
}

async function applyItemBatch(actor, actions, deleting, documentOptions, succeeded) {
  const ids = [...new Set(actions.map(action => action.itemId))];
  const updateMethod = deleting ? actor.deleteEmbeddedDocuments : actor.updateEmbeddedDocuments;
  const isSaved = action => {
    const item = getActorItem(actor, action.itemId);
    return deleting ? !item : getDocumentWriteMismatches(item, getItemTimerUpdate(action)).length === 0;
  };
  const hasChanged = action => {
    if (deleting) return isSaved(action);
    const item = getActorItem(actor, action.itemId);
    const path = Object.keys(getItemTimerUpdate(action))[0];
    return !item || String(getProperty(item._source ?? item, path) ?? "") !== action.beforeText;
  };
  const run = async (batch, write) => {
    let cause;
    try { await runDocumentWrite(write); }
    catch (error) { cause = error; }
    const unknown = isUnknownWriteOutcome(cause);
    const saved = unknown ? [] : batch.filter(isSaved);
    succeeded.push(...saved.map(action => successResult(action)));
    const missing = batch.filter(action => !saved.includes(action));
    if (!cause && !missing.length) return;
    const error = new Error(cause?.message ?? qaLocalize("NewDay.WriteNotPersisted", "The requested Item change did not persist."), { cause });
    const failedActions = missing.length ? missing : [{
      id: deleting ? "item-delete-batch" : "item-update-batch",
      itemName: deleting
        ? qaLocalize("NewDay.ItemDeleteBatch", "Item deletion batch")
        : qaLocalize("NewDay.ItemUpdateBatch", "Item update batch")
    }];
    throw Object.assign(error, {
      code: unknown ? "outcome-unknown" : "write-not-persisted", actions: failedActions,
      partiallyApplied: !unknown && batch.some(hasChanged)
    });
  };

  if (typeof updateMethod === "function") {
    if (deleting) await run(actions, () => actor.deleteEmbeddedDocuments("Item", [...ids], documentOptions));
    else {
      const updates = new Map(ids.map(id => [id, { _id: id }]));
      for (const action of actions) Object.assign(updates.get(action.itemId), getItemTimerUpdate(action));
      await run(actions, () => actor.updateEmbeddedDocuments("Item", [...updates.values()], documentOptions));
    }
    return;
  }

  // Some wrappers expose only the individual Item methods.
  for (const action of actions) {
    const item = getActorItem(actor, action.itemId);
    await run([action], () => deleting ? item.delete(documentOptions) : item.update(getItemTimerUpdate(action), documentOptions));
  }
}

async function writeNewDayFlag(actor, key, value, documentOptions) {
  const before = structuredClone(readActorFlag(actor, key));
  try {
    // Assign null through Actor.update. Forbidden Lands v13 can reject a flag deletion path.
    await runDocumentWrite(() => actor.update && (value === null || Object.keys(documentOptions).length)
      ? actor.update({ [`flags.${MODULE_ID}.${key}`]: structuredClone(value) }, documentOptions)
      : actor.setFlag(MODULE_ID, key, structuredClone(value)));
    if (!documentValuesEqual(readActorFlag(actor, key), value)) throw new Error(`Actor flag ${key} was not persisted`);
  } catch (cause) {
    const unknown = isUnknownWriteOutcome(cause);
    throw Object.assign(new Error(cause.message, { cause }), {
      code: unknown ? "outcome-unknown" : "write-not-persisted",
      partiallyApplied: !unknown && !documentValuesEqual(readActorFlag(actor, key), before)
    });
  }
}

function reportNewDayFailure(actor, result, dateLabel) {
  const details = {
    actor: dateLabel ? `${actor.name} (${dateLabel})` : actor.name,
    done: result.succeeded.filter(entry => entry.changed).map(entry => entry.action.itemName).join(", ") || "—",
    failures: result.failed.map(({ action, error }) => `${action.itemName} (${action.id}): ${error}`).join("; ")
  };
  const key = result.outcomeUnknown ? "NewDay.WriteOutcomeUnknown" : "NewDay.WriteStopped";
  const message = qaLocalize(key, result.outcomeUnknown
    ? "{actor}: New Day stopped with an unknown outcome. Confirmed actions: {done}. Unconfirmed: {failures}. Check the sheet before trying again."
    : "{actor}: New Day stopped. Confirmed actions: {done}. Failed: {failures}. Check the sheet before trying again.", details);
  whisperToGM(message);
}

function stalePlanError() {
  return Object.assign(new Error(qaLocalize("NewDay.StalePlan", "Данные изменились. Обновите предварительный просмотр.")), { code: "stale-plan" });
}

export function serializeNewDayResult(result) {
  const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  return {
    changed: Boolean(result?.changed),
    partiallyApplied: Boolean(result?.partiallyApplied),
    outcomeUnknown: Boolean(result?.outcomeUnknown),
    selected: Number(result?.selected) || 0,
    successCount: succeeded.length,
    failedCount: failed.length,
    pendingCount: succeeded.filter(entry => entry.pending).length,
    entries: [
      ...succeeded.map((entry) => ({
        ok: true,
        pending: Boolean(entry.pending),
        itemName: String(entry?.action?.itemName ?? ""),
        detail: String(entry?.summary || actionDetail(entry?.action ?? {}))
      })),
      ...failed.map((entry) => ({
        ok: false,
        pending: false,
        itemName: String(entry?.action?.itemName ?? ""),
        detail: String(entry?.error ?? qaLocalize("NewDay.UnknownError", "Unknown error"))
      }))
    ]
  };
}

function formatAddictionNewDayResult(result) {
  if (!result) return "";
  if (result.cured) return qaLocalize("NewDay.AddictionCured", "Addiction resolved.");
  if (result.pending) return result.total == null
    ? qaLocalize("NewDay.AddictionPendingFlat", "Withdrawal: manual Endurance is required. Record Success or Failure in STAT; the cycle and penalties are unchanged.")
    : qaLocalize("NewDay.AddictionPendingRoll", "Craving: {total}. Manual Endurance is required. Record Success or Failure in STAT; the cycle is unchanged.", { total: result.total });
  if (result.reused) return qaLocalize("NewDay.AddictionAlreadyProcessed", "This morning was already processed; no repeat roll or step was performed. Current state: {state}.", {
    state: formatAddictionState(result.nextState)
  });
  const from = formatAddictionState(result.state);
  const to = formatAddictionState(result.nextState);
  if (result.total != null && Number.isFinite(Number(result.total))) {
    const outcome = result.advanced
      ? qaLocalize("NewDay.AddictionAdvanced", "cycle advanced")
      : qaLocalize("NewDay.AddictionHeld", "cycle unchanged");
    return qaLocalize("NewDay.AddictionRollResult", "Craving roll: {total}; {outcome}. {from} → {to}", {
      total: Number(result.total),
      outcome,
      from,
      to
    });
  }
  return qaLocalize("NewDay.AddictionFlatResult", "Addiction cycle: {from} → {to}", { from, to });
}

export async function openNewDayDialog(app, actor, options = {}) {
  if (!canModifyActor(actor) && !options.allowDelegatedApply) {
    warnCannotModifyActor();
    return null;
  }

  if (!hasFoundryDialogApi()) {
    ui.notifications?.warn?.(qaLocalize("NewDay.DialogUnavailable", "Окно нового дня недоступно в этом окружении."));
    return null;
  }

  const plan = await buildNewDayPlanWithProviders(actor, { dayKey: options.dayKey });
  if (plan.providerErrors?.length) {
    ui.notifications?.warn?.(qaLocalize(
      "NewDay.ProviderBuildErrors",
      "Некоторые подключённые модули не смогли подготовить действия нового дня: {count}.",
      { count: plan.providerErrors.length }
    ));
  }
  const content = buildNewDayDialogContent(plan);

  return new Promise((resolve) => {
    let resolved = false;
    let applying = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const closeDialog = renderedDialog => typeof renderedDialog?.close === "function" ? renderedDialog.close() : dialog.close?.();
    const dialog = createFoundryDialog({
      title: qaLocalize("NewDay.Title", "Новый день: {actor}", { actor: actor?.name ?? "" }),
      content,
      closeOnSubmit: false,
      buttons: {
        apply: {
          icon: '<i class="fas fa-sun"></i>',
          label: qaLocalize("NewDay.Apply", "Провести новый день"),
          callback: async (html, _event, _button, renderedDialog) => {
            if (applying) return false;
            // DialogV2 exposes the submitted native form most reliably through
            // the rendered button. Reading only from the dialog can produce an
            // empty selection in Foundry v13, making every checked daily action
            // look as though it did nothing.
            // Foundry v13 may expose the DialogV2-owned form before our render
            // metadata class has been re-applied. Prefer the named form, but fall
            // back to the dialog's sole native form instead of aborting the day.
            const formSource = _button?.form ?? _event?.currentTarget?.form ?? renderedDialog?.form ?? renderedDialog ?? html;
            const form = findDialogForm(formSource, "form.fblqa-new-day-form")
              ?? findDialogForm(formSource, "form");
            if (!form) {
              console.error(`${MODULE_ID} | new-day form was not available in the rendered dialog`);
              ui.notifications?.error?.(qaLocalize("NewDay.FormUnavailable", "Не удалось прочитать выбранные изменения нового дня."));
              return false;
            }
            const selectedIds = [...(form?.querySelectorAll('input[name="newDayAction"]:checked') ?? [])]
              .map((input) => input.value);
            applying = true;
            let result;
            try {
              result = typeof options.applyHandler === "function"
                ? await options.applyHandler({ actor, plan, ...getNewDaySelection(plan, selectedIds),
                  source: options.source ?? "manual", targetDate: options.targetDate ?? null })
                : await applyNewDayPlan(actor, plan, selectedIds, {
                    postChat: options.postChat !== false,
                    suppressNotifications: Boolean(options.suppressNotifications)
                  });
            } catch (error) {
              console.error(`${MODULE_ID} | new-day delegated apply failed`, error);
              const unknown = isUnknownWriteOutcome(error);
              const staleCalendar = ["stale-calendar-day", "multi-day-pending"].includes(error?.code);
              const stale = error?.code === "stale-plan" || staleCalendar;
              const message = staleCalendar ? qaLocalize("NewDay.DelegatedStale", "The calendar changed. Open a new preview for the current date.")
                : stale ? stalePlanError().message
                  : unknown ? qaLocalize("Writes.Unknown", "The outcome is unknown. Check the sheet before trying again.")
                    : error?.code === "calendar-needs-review" ? error.message
                      : qaLocalize("NewDay.DelegatedFailed", "Could not apply the selected New Day changes.");
              (unknown || stale ? ui.notifications?.warn : ui.notifications?.error)?.call(ui.notifications, escapeHtml(message));
              if (unknown) whisperToGM(`${actor.name} — ${message}`);
              finish(null);
              await closeDialog(renderedDialog);
              return false;
            }

            const calendarMode = String(options.source ?? "").startsWith("calendaria");
            if (!calendarMode) {
              if (result?.failed?.length) {
                const message = result.outcomeUnknown ? qaLocalize("Writes.Unknown", "The outcome is unknown. Check the sheet before trying again.")
                  : result.partiallyApplied ? qaLocalize("NewDay.PartialFailure", "New Day was partially applied. Check the sheet before trying again.")
                    : result.failed.every(entry => entry.code === "stale-plan") ? stalePlanError().message
                      : qaLocalize("NewDay.DelegatedFailed", "Could not apply the selected New Day changes.");
                ui.notifications?.warn?.(message);
              } else if (result?.pending?.length) {
                ui.notifications?.warn?.(qaLocalize("NewDay.ManualChecksPending", "Manual Endurance is still required for {count} addictions. Record the outcomes in STAT.", { count: result.pending.length }));
              } else if (result?.succeeded?.length) {
                ui.notifications?.info?.(qaLocalize("NewDay.Completed", "Новый день обработан. Выполнено действий: {count}.", {
                  count: result.succeeded.length
                }));
              } else {
                ui.notifications?.info?.(qaLocalize("NewDay.NoActionsSelected", "Ни одно действие нового дня не выбрано."));
              }
            }

            const selectedCoreAction = selectedIds.some((id) => {
              const action = plan.actions.find((entry) => entry.id === id);
              return action && !action.providerId;
            });
            // Core Document writes already participate in Foundry's sheet render
            // pipeline. Preserve the explicit refresh only for no-op/provider-only
            // manual operations, where no Actor/Item mutation is guaranteed.
            if (app && !calendarMode && !selectedCoreAction) rerenderSheet(app);
            finish(result);
            await closeDialog(renderedDialog);
            return false;
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: qaLocalize("Common.Cancel", "Отмена"),
          callback: async (_html, _event, _button, renderedDialog) => {
            if (applying) return false;
            finish(null);
            await closeDialog(renderedDialog);
            return false;
          }
        }
      },
      default: "apply",
      render: (html, renderedDialog) => {
        const element = extractDialogElement(renderedDialog ?? html);
        element?.closest?.(".app, .application")?.classList.add("fblqa-rest-dialog", "fblqa-new-day-dialog");
        setupNewDayDialogInteractivity(renderedDialog ?? element);
      },
      close: () => { if (!applying) finish(null); }
    }, {
      classes: ["fblqa-rest-dialog", "fblqa-new-day-dialog"],
      width: 640,
      resizable: true
    });
    dialog.render(true);
  });
}

function buildNewDayDialogContent(plan) {
  const groups = getPlanCategories(plan)
    .map((category) => {
      const actions = plan.actions.filter((action) => action.category === category.id);
      if (!actions.length) return "";
      return `
        <section class="fblqa-new-day-group" data-category="${escapeHtml(category.id)}">
          <h3>${escapeHtml(category.label)}</h3>
          <div class="fblqa-new-day-actions">${actions.map(renderNewDayAction).join("")}</div>
        </section>`;
    })
    .join("");

  return `
    <form class="fblqa-new-day-form">
      <div class="fblqa-new-day-intro">
        <strong>${escapeHtml(qaLocalize("NewDay.Heading", "Начало нового дня"))}</strong>
        <span>${escapeHtml(qaLocalize("NewDay.Description", "Проверьте найденные ежедневные изменения. Применены будут только отмеченные действия."))}</span>
        <div class="fblqa-new-day-toolbar">
          <button type="button" data-action="select-all"><i class="fas fa-check-double"></i> ${escapeHtml(qaLocalize("NewDay.SelectAll", "Выбрать всё"))}</button>
          <button type="button" data-action="select-none"><i class="fas fa-ban"></i> ${escapeHtml(qaLocalize("NewDay.SelectNone", "Снять всё"))}</button>
        </div>
      </div>
      <div class="fblqa-new-day-groups">${groups}</div>
      <p class="fblqa-rest-note">${escapeHtml(plan.blockedByAddiction
        ? qaLocalize("NewDay.PendingBlocked", "Resolve the pending addiction Endurance in STAT before advancing another day. Other timers will not change.")
        : qaLocalize("NewDay.Note", "Таймеры уменьшаются на один день. Непостоянные травмы и состояния, достигшие нуля, удаляются. Помытость и зависимость используют текущие правила STAT."))}</p>
    </form>`;
}

function renderNewDayAction(action) {
  const detail = actionDetail(action);
  const warningClass = action.warning ? " is-warning" : "";
  return `
    <label class="fblqa-new-day-action${warningClass}">
      <input type="checkbox" name="newDayAction" value="${escapeHtml(action.id)}" ${action.checked ? "checked" : ""}>
      <span class="fblqa-new-day-icon"><i class="fas ${actionIcon(action)}" aria-hidden="true"></i></span>
      <span class="fblqa-new-day-copy">
        <strong>${escapeHtml(action.itemName)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
    </label>`;
}

function actionDetail(action) {
  if (action.providerId) return describeNewDayProviderAction(action) || qaLocalize("NewDay.GenericAction", "Ежедневное изменение");
  if (action.kind === "injury-expire") {
    return qaLocalize("NewDay.InjuryExpired", "Срок лечения: {beforeText} → {afterText}. Травма прошла и будет удалена.", action);
  }
  if (action.kind === "injury-healing") {
    return qaLocalize("NewDay.InjuryTimer", "Срок лечения: {beforeText} → {afterText}", action);
  }
  if (action.kind === "lethal-limit") {
    return action.warning
      ? qaLocalize("NewDay.LethalExpired", "Смертельный предел: {beforeText} → {afterText}. Предел исчерпан.", action)
      : qaLocalize("NewDay.LethalTimer", "Смертельный предел: {beforeText} → {afterText}", action);
  }
  if (action.kind === "wash-timer") {
    return qaLocalize("NewDay.WashTimer", "До ухудшения помытости: {beforeText} → {afterText}", action);
  }
  if (action.kind === "wash-transition") {
    return qaLocalize("NewDay.WashTransition", "Помытость ухудшится: {name} → {next}", {
      name: action.itemName,
      next: action.nextWashName
    });
  }
  if (action.kind === "custom-condition-expire") {
    return qaLocalize("NewDay.ConditionExpired", "Срок состояния: {beforeText} → {afterText}. Состояние завершится и будет удалено.", action);
  }
  if (action.kind === "custom-condition") {
    return qaLocalize("NewDay.ConditionTimer", "Срок состояния: {beforeText} → {afterText}", action);
  }
  if (action.kind === "addiction-day") {
    if (action.pending) return qaLocalize("NewDay.AddictionPendingFlat", "Manual Endurance is required. Record the result in STAT before advancing another day.");
    return action.state?.phase === "flat"
      ? qaLocalize("NewDay.AddictionDayFlat", "Ручная Endurance: отметьте результат в STAT. До этого дни ломки и штрафы не меняются.")
      : qaLocalize("NewDay.AddictionDayRoll", "Тяга 1d{die}: на 3+ шаг автоматически; на 1–2 нужна ручная Endurance и отметка результата в STAT.", {
          die: action.state?.die ?? 6
        });
  }
  if (action.kind === "short-rest-reset") {
    return qaLocalize("NewDay.ShortRestResetDetail", "Разрешить восстановление Short Rest в новой четверти дня.");
  }
  return qaLocalize("NewDay.GenericAction", "Ежедневное изменение");
}

function formatAddictionState(state) {
  if (!state) return "—";
  if (state.phase === "flat") return qaLocalize("NewDay.AddictionFlatState", "ломка, {days} дн.", { days: state.daysLeft });
  if (state.phase === "up") return qaLocalize("NewDay.AddictionUpState", "восстановление d{die}", { die: state.die });
  return qaLocalize("NewDay.AddictionDownState", "спад d{die}", { die: state.die });
}

function actionIcon(action) {
  if (action.providerId) return getNewDayProviderIcon(action);
  return {
    "injury-expire": "fa-heart-circle-check",
    "injury-healing": "fa-heartbeat",
    "lethal-limit": "fa-skull-crossbones",
    "wash-timer": "fa-soap",
    "wash-transition": "fa-soap",
    "custom-condition": "fa-hourglass-half",
    "custom-condition-expire": "fa-circle-check",
    "addiction-day": "fa-dice",
    "short-rest-reset": "fa-clock"
  }[action.kind] ?? "fa-check";
}


function buildPlanCategories(actions = []) {
  const categories = new Map(CORE_CATEGORIES.map((entry) => [entry.id, {
    ...entry,
    label: coreCategoryLabel(entry.id)
  }]));

  for (const provider of getNewDayProviders()) {
    const category = getNewDayProviderCategory(provider);
    if (!category) continue;
    const existing = categories.get(category.id);
    if (!existing || category.order < existing.order) categories.set(category.id, category);
  }

  for (const action of actions) {
    if (!action?.category || categories.has(action.category)) continue;
    categories.set(action.category, {
      id: action.category,
      order: Number.isFinite(Number(action.categoryOrder)) ? Number(action.categoryOrder) : 500,
      label: String(action.categoryLabel ?? action.category)
    });
  }

  return Array.from(categories.values()).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function getPlanCategories(plan) {
  const populated = new Set((plan?.actions ?? []).map((action) => action.category));
  const categories = Array.isArray(plan?.categories) ? plan.categories : buildPlanCategories(plan?.actions);
  return categories.filter((category) => populated.has(category.id));
}

function sortNewDayActions(actions, categories) {
  const orderByCategory = new Map((categories ?? []).map((entry, index) => {
    const order = Number(entry.order);
    return [entry.id, Number.isFinite(order) ? order : index];
  }));
  actions.sort((a, b) => {
    const categoryDifference = (orderByCategory.get(a.category) ?? 500) - (orderByCategory.get(b.category) ?? 500);
    if (categoryDifference) return categoryDifference;

    const providerDifference = (Number(a.providerOrder) || 0) - (Number(b.providerOrder) || 0);
    if (providerDifference) return providerDifference;

    const nameDifference = String(a.itemName).localeCompare(String(b.itemName));
    if (nameDifference) return nameDifference;

    return String(a.kind).localeCompare(String(b.kind));
  });
}

function coreCategoryLabel(category) {
  return qaLocalize(`NewDay.Category.${category}`, {
    injuries: "Травмы",
    wash: "Помытость",
    conditions: "Состояния",
    addiction: "Зависимости",
    system: "Новый день"
  }[category] ?? category);
}

function setupNewDayDialogInteractivity(dialogOrElement) {
  const form = findDialogForm(dialogOrElement, "form.fblqa-new-day-form")
    ?? findDialogForm(dialogOrElement, "form");
  if (!form || form.dataset.fblqaNewDayBound) return;
  form.dataset.fblqaNewDayBound = "true";

  form.querySelector('[data-action="select-all"]')?.addEventListener("click", () => {
    for (const input of form.querySelectorAll('input[name="newDayAction"]')) input.checked = true;
  });
  form.querySelector('[data-action="select-none"]')?.addEventListener("click", () => {
    for (const input of form.querySelectorAll('input[name="newDayAction"]')) input.checked = false;
  });
}

async function postNewDaySummary(actor, succeeded, failed) {
  if (!globalThis.ChatMessage?.create || (!succeeded.length && !failed.length)) return null;

  const successList = succeeded.length
    ? `<ul>${succeeded.map((entry) => `<li>${escapeHtml(entry.action.itemName)}: ${escapeHtml(entry.summary || actionDetail(entry.action))}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(qaLocalize("NewDay.None", "Нет"))}</p>`;
  const failedList = failed.length
    ? `<ul>${failed.map((entry) => `<li>${escapeHtml(entry.action.itemName)}</li>`).join("")}</ul>`
    : "";

  const content = `
    <div class="fblqa-rest-chat-card fblqa-new-day-chat-card">
      <h3>${escapeHtml(qaLocalize("NewDay.ChatTitle", "Новый день"))} — ${escapeHtml(actor?.name ?? "")}</h3>
      <p><strong>${escapeHtml(qaLocalize("NewDay.ChatApplied", "Применено"))}:</strong></p>
      ${successList}
      ${failedList ? `<p><strong>${escapeHtml(qaLocalize("NewDay.ChatFailed", "Не выполнено"))}:</strong></p>${failedList}` : ""}
    </div>`;

  return createChatMessage({
    speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }) ?? undefined,
    content
  });
}

function successResult(action, result = null) {
  return {
    ok: true,
    action,
    changed: result?.changed ?? true,
    pending: !action.providerId && action.kind === "addiction-day" && Boolean(result?.pending),
    summary: String(result?.summary ?? ""),
    privateSummary: String(result?.privateSummary ?? "")
  };
}

function failureResult(action, error) {
  return { ok: false, action, code: error?.code ?? "operation-failed", error: String(error?.message ?? error ?? "Unknown error") };
}

function getActorItems(actor) {
  if (!actor?.items) return [];
  if (typeof actor.items.values === "function") return Array.from(actor.items.values());
  return Array.from(actor.items);
}

function getActorItem(actor, itemId) {
  if (!itemId) return null;
  if (typeof actor?.items?.get === "function") return actor.items.get(itemId) ?? null;
  return getActorItems(actor).find((item) => item?.id === itemId) ?? null;
}

function getCustomConditions(actor) {
  const value = actor?.getFlag?.(MODULE_ID, CONDITION_FLAGS.LIST)
    ?? actor?.flags?.[MODULE_ID]?.conditions?.list
    ?? [];
  return Array.isArray(value) ? value.map((entry) => ({ ...entry })) : [];
}

function isArcName(name) {
  const text = String(name ?? "").toLocaleUpperCase();
  return text.includes("[АРКА]") || text.includes("[ARC]");
}

