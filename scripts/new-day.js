import { FLAG_SHORT_REST_RECOVERY, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, rerenderSheet } from "./utils.js";
import { createFoundryDialog, extractDialogElement, findDialogForm, hasFoundryDialogApi } from "./dialogs.js";
import { FLAGS as CONDITION_FLAGS } from "./conditions/constants.js";
import { createChatMessage, isPermanentTime } from "./conditions/utils.js";
import { getNextWashName, isWashCondition, transitionWashLevel } from "./conditions/features/wash.js";
import {
  getAddictionState,
  isAddictionCondition,
  isHeatCondition,
  isMorCondition
} from "./conditions/features/special-counters.js";
import { processAddictionNewDay } from "./conditions/services/addiction-service.js";
import {
  applyNewDayProviderAction,
  buildNewDayProviderActions,
  describeNewDayProviderAction,
  getNewDayProviderCategory,
  getNewDayProviderIcon,
  getNewDayProviders
} from "./integration/new-day-providers.js";

const CORE_CATEGORIES = Object.freeze([
  { id: "injuries", order: 100 },
  { id: "wash", order: 200 },
  { id: "conditions", order: 300 },
  { id: "addiction", order: 350 },
  { id: "system", order: 1000 }
]);

export function decrementFirstInteger(value, amount = 1) {
  const text = String(value ?? "");
  if (/\b\d*d\d+\b|\bd\d+\b/i.test(text)) return null;
  const match = text.match(/\d+/);
  if (!match) return null;
  const current = Number.parseInt(match[0], 10);
  if (!Number.isFinite(current)) return null;
  const next = Math.max(0, current - Math.max(0, Number(amount) || 0));
  const replaced = text.replace(match[0], String(next));
  return {
    beforeNumber: current,
    afterNumber: next,
    beforeText: text,
    afterText: normalizeDayUnit(replaced, next)
  };
}

function normalizeDayUnit(text, value) {
  let normalized = String(text ?? "");

  if (/\bdays?\b/i.test(normalized)) {
    normalized = normalized.replace(/\bdays?\b/i, Number(value) === 1 ? "day" : "days");
  }

  if (/\b(?:день|дня|дней)\b/i.test(normalized)) {
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
    normalized = normalized.replace(/\b(?:день|дня|дней)\b/i, unit);
  }

  return normalized;
}

export function isDailyLethalLimit(value) {
  const text = String(value ?? "").trim().toLocaleLowerCase();
  if (!text || !/\d/.test(text)) return false;
  if (/\b\d*d\d+\b|\bd\d+\b/i.test(text)) return false;
  if (/hour|minute|turn|round|quarter|час|минут|ход|раунд|четверт/i.test(text)) return false;
  return /^\d+$/.test(text) || /day|days|день|дня|дней|сутк/i.test(text);
}

export function buildNewDayPlan(actor) {
  const actions = [];
  const items = getActorItems(actor);

  for (const item of items) {
    if (item?.type !== "criticalInjury") continue;
    const itemName = String(item.name ?? qaLocalize("NewDay.UnnamedEntry", "Без названия"));

    if (isAddictionCondition(item)) {
      actions.push({
        id: `addiction:${item.id}:day`,
        kind: "addiction-day",
        category: "addiction",
        itemId: item.id,
        itemName,
        checked: true,
        state: getAddictionState(item)
      });
      continue;
    }

    if (isHeatCondition(item) || isMorCondition(item) || isArcName(itemName)) continue;

    const healingTime = item.system?.healingTime;
    const healing = decrementFirstInteger(healingTime, 1);
    const healingIsPermanent = isPermanentTime(healingTime);

    if (isWashCondition(item)) {
      if (healing && !healingIsPermanent) {
        const nextWashName = getNextWashName(itemName);
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

    if (!injuryExpires && item.system?.lethal === "yes" && isDailyLethalLimit(item.system?.limit)) {
      const limit = decrementFirstInteger(item.system?.limit, 1);
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

  const customConditions = getCustomConditions(actor);
  for (const condition of customConditions) {
    if (isArcName(condition?.name)) continue;
    const timer = decrementFirstInteger(condition?.time, 1);
    if (!timer || isPermanentTime(condition?.time)) continue;

    const expires = timer.afterNumber === 0;
    if (!expires && timer.beforeNumber <= 0) continue;

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

  actions.push({
    id: "system:short-rest-reset",
    kind: "short-rest-reset",
    category: "system",
    checked: true,
    itemName: qaLocalize("NewDay.ShortRestReset", "Сбросить лимит восстановления Short Rest")
  });

  const categories = buildPlanCategories();
  sortNewDayActions(actions, categories);

  return { actorId: actor?.id ?? "", actorName: actor?.name ?? "", actions, categories, providerErrors: [] };
}

/**
 * Build the complete plan, including actions supplied by registered modules.
 * The legacy buildNewDayPlan() remains synchronous for backwards compatibility.
 */
export async function buildNewDayPlanWithProviders(actor) {
  const plan = buildNewDayPlan(actor);
  const providerResult = await buildNewDayProviderActions(actor);
  plan.actions.push(...providerResult.actions);
  plan.providerErrors = providerResult.errors;
  plan.categories = buildPlanCategories(plan.actions);
  sortNewDayActions(plan.actions, plan.categories);
  return plan;
}

export async function applyNewDayPlan(actor, plan, selectedActionIds, options = {}) {
  const selected = new Set(selectedActionIds ?? []);
  const actions = (plan?.actions ?? []).filter((action) => selected.has(action.id));
  const results = [];
  const postChat = options.postChat !== false;
  const suppressNotifications = Boolean(options.suppressNotifications);
  const documentOptions = options.documentOptions ?? {};

  if (!actions.length) return { changed: false, selected: 0, succeeded: [], failed: [] };

  const customActions = actions.filter((action) =>
    !action.providerId && (action.kind === "custom-condition" || action.kind === "custom-condition-expire")
  );
  if (customActions.length) {
    try {
      const byId = new Map(customActions.map((action) => [action.conditionId, action]));
      const nextConditions = getCustomConditions(actor).flatMap((condition) => {
        const action = byId.get(condition.id);
        if (!action) return [condition];

        const timer = decrementFirstInteger(condition.time, 1);
        if (!timer || isPermanentTime(condition.time) || timer.beforeNumber <= 0) return [condition];
        if (timer.afterNumber === 0) return [];
        return [{ ...condition, time: timer.afterText }];
      });
      await setActorFlagWithOptions(actor, CONDITION_FLAGS.LIST, nextConditions, documentOptions);
      for (const action of customActions) results.push(successResult(action));
    } catch (error) {
      console.error(`${MODULE_ID} | could not advance custom condition timers`, error);
      for (const action of customActions) results.push(failureResult(action, error));
    }
  }

  let pendingKind = "";
  let pendingActions = [];

  const flushPending = async () => {
    if (!pendingActions.length) return;
    const batch = pendingActions;
    const kind = pendingKind;
    pendingActions = [];
    pendingKind = "";

    if (kind === "update") await applyItemUpdateBatch(actor, batch, results, documentOptions);
    else if (kind === "delete") await applyItemDeleteBatch(actor, batch, results, documentOptions);
  };

  for (const action of actions) {
    if (!action.providerId && (action.kind === "custom-condition" || action.kind === "custom-condition-expire")) continue;

    const simpleKind = getSimpleItemActionKind(action);
    if (simpleKind) {
      if (pendingKind && pendingKind !== simpleKind) await flushPending();
      pendingKind = simpleKind;
      pendingActions.push(action);
      continue;
    }

    await flushPending();

    try {
      if (action.providerId) {
        const providerResult = await applyNewDayProviderAction(actor, action, { suppressChat: !postChat });
        results.push(successResult(action, providerResult));
        continue;
      }

      if (action.kind === "short-rest-reset") {
        await clearActorFlagWithOptions(actor, FLAG_SHORT_REST_RECOVERY, documentOptions);
        results.push(successResult(action));
        continue;
      }

      const item = getActorItem(actor, action.itemId);
      if (!item) throw new Error(`Missing item ${action.itemId}`);

      if (action.kind === "wash-transition") {
        const transition = await transitionWashLevel(actor, item.name, {
          ...documentOptions,
          fblqaSuppressNotifications: suppressNotifications
        });
        if (!transition?.changed) throw new Error(transition?.reason ?? "Wash transition failed");
      } else if (action.kind === "addiction-day") {
        const addictionResult = await processAddictionNewDay(actor, item, {
          postChat,
          notify: !suppressNotifications,
          documentOptions
        });
        results.push(successResult(action, {
          changed: addictionResult?.changed,
          summary: formatAddictionNewDayResult(addictionResult)
        }));
        continue;
      }

      results.push(successResult(action));
    } catch (error) {
      console.error(`${MODULE_ID} | new-day action failed`, action, error);
      results.push(failureResult(action, error));
    }
  }

  await flushPending();

  const succeeded = results.filter((entry) => entry.ok);
  const failed = results.filter((entry) => !entry.ok);
  if (postChat) await postNewDaySummary(actor, succeeded, failed);

  return {
    changed: succeeded.some((entry) => entry.changed !== false),
    selected: actions.length,
    succeeded,
    failed
  };
}

function getSimpleItemActionKind(action) {
  if (action?.providerId) return "";
  if (action?.kind === "injury-expire") return "delete";
  if (action?.kind === "injury-healing" || action?.kind === "wash-timer" || action?.kind === "lethal-limit") return "update";
  return "";
}

function getSimpleItemUpdate(action) {
  if (action.kind === "injury-healing" || action.kind === "wash-timer") {
    return { "system.healingTime": action.afterText };
  }
  if (action.kind === "lethal-limit") return { "system.limit": action.afterText };
  return null;
}

async function applyItemUpdateBatch(actor, actions, results, documentOptions) {
  const valid = [];
  for (const action of actions) {
    const item = getActorItem(actor, action.itemId);
    if (!item) {
      const error = new Error(`Missing item ${action.itemId}`);
      console.error(`${MODULE_ID} | new-day action failed`, action, error);
      results.push(failureResult(action, error));
      continue;
    }
    valid.push({ action, item });
  }
  if (!valid.length) return;

  if (typeof actor.updateEmbeddedDocuments === "function") {
    const updatesById = new Map();
    for (const { action } of valid) {
      const update = getSimpleItemUpdate(action);
      if (!update) continue;
      const current = updatesById.get(action.itemId) ?? { _id: action.itemId };
      Object.assign(current, update);
      updatesById.set(action.itemId, current);
    }

    try {
      await actor.updateEmbeddedDocuments("Item", [...updatesById.values()], documentOptions);
      for (const { action } of valid) results.push(successResult(action));
      return;
    } catch (error) {
      // A bulk write can fail because one embedded Item is stale or rejected by
      // another module. Fall back to the original per-action path so one bad
      // update does not change the previous partial-success semantics. The
      // updates below are absolute values, so retrying an Item that the bulk
      // request happened to apply before failing is idempotent.
      console.error(`${MODULE_ID} | new-day item update batch failed; retrying individually`, error);
    }

    await applyItemUpdatesIndividually(actor, valid, results, documentOptions);
    return;
  }

  // Compatibility fallback for test doubles and wrappers without the bulk API.
  await applyItemUpdatesIndividually(actor, valid, results, documentOptions);
}

async function applyItemUpdatesIndividually(actor, valid, results, documentOptions) {
  for (const { action, item: originalItem } of valid) {
    const item = getActorItem(actor, action.itemId) ?? originalItem;
    try {
      await item.update(getSimpleItemUpdate(action), documentOptions);
      results.push(successResult(action));
    } catch (error) {
      console.error(`${MODULE_ID} | new-day action failed`, action, error);
      results.push(failureResult(action, error));
    }
  }
}

async function applyItemDeleteBatch(actor, actions, results, documentOptions) {
  const valid = [];
  for (const action of actions) {
    const item = getActorItem(actor, action.itemId);
    if (!item) {
      const error = new Error(`Missing item ${action.itemId}`);
      console.error(`${MODULE_ID} | new-day action failed`, action, error);
      results.push(failureResult(action, error));
      continue;
    }
    valid.push({ action, item });
  }
  if (!valid.length) return;

  if (typeof actor.deleteEmbeddedDocuments === "function") {
    try {
      await actor.deleteEmbeddedDocuments("Item", valid.map(({ action }) => action.itemId), documentOptions);
      for (const { action } of valid) results.push(successResult(action));
      return;
    } catch (error) {
      // Preserve the old per-Item failure isolation if a bulk delete is rejected.
      // Re-check the Actor first because a partially-applied bulk request may
      // already have removed some of the requested Items.
      console.error(`${MODULE_ID} | new-day item delete batch failed; retrying individually`, error);
    }

    await applyItemDeletesIndividually(actor, valid, results, documentOptions, { missingMeansSuccess: true });
    return;
  }

  await applyItemDeletesIndividually(actor, valid, results, documentOptions);
}

async function applyItemDeletesIndividually(actor, valid, results, documentOptions, { missingMeansSuccess = false } = {}) {
  for (const { action, item: originalItem } of valid) {
    const liveItem = getActorItem(actor, action.itemId);
    if (!liveItem && missingMeansSuccess) {
      results.push(successResult(action));
      continue;
    }

    const item = liveItem ?? originalItem;
    try {
      await item.delete(documentOptions);
      results.push(successResult(action));
    } catch (error) {
      console.error(`${MODULE_ID} | new-day action failed`, action, error);
      results.push(failureResult(action, error));
    }
  }
}

async function setActorFlagWithOptions(actor, key, value, documentOptions) {
  if (hasDocumentOptions(documentOptions) && typeof actor.update === "function") {
    return actor.update({ [`flags.${MODULE_ID}.${key}`]: value }, documentOptions);
  }
  return actor.setFlag(MODULE_ID, key, value);
}

async function clearActorFlagWithOptions(actor, key, documentOptions) {
  // Forbidden Lands v13 can reject a Foundry deletion-path update such as
  // `flags.<scope>.-=<key>` during Actor._preUpdate. Short Rest only treats an
  // object value as an active recovery marker, so a null value is semantically
  // equivalent to an absent flag and avoids that system-level failure.
  const current = actor?.getFlag?.(MODULE_ID, key) ?? actor?.flags?.[MODULE_ID]?.[key] ?? null;
  if (current == null) return false;

  const update = { [`flags.${MODULE_ID}.${key}`]: null };
  if (typeof actor?.update === "function") {
    return actor.update(update, hasDocumentOptions(documentOptions) ? documentOptions : {});
  }
  return actor?.setFlag?.(MODULE_ID, key, null);
}

function hasDocumentOptions(options) {
  return Boolean(options && Object.keys(options).length);
}

export function serializeNewDayResult(result) {
  const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  return {
    changed: Boolean(result?.changed),
    selected: Number(result?.selected) || 0,
    successCount: succeeded.length,
    failedCount: failed.length,
    entries: [
      ...succeeded.map((entry) => ({
        ok: true,
        itemName: String(entry?.action?.itemName ?? ""),
        detail: String(entry?.summary || actionDetail(entry?.action ?? {}))
      })),
      ...failed.map((entry) => ({
        ok: false,
        itemName: String(entry?.action?.itemName ?? ""),
        detail: String(entry?.error ?? qaLocalize("NewDay.UnknownError", "Unknown error"))
      }))
    ]
  };
}

function formatAddictionNewDayResult(result) {
  if (!result) return "";
  if (result.cured) return qaLocalize("NewDay.AddictionCured", "Addiction resolved.");
  const from = formatAddictionState(result.state);
  const to = formatAddictionState(result.nextState);
  if (Number.isFinite(Number(result.total))) {
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

  const plan = await buildNewDayPlanWithProviders(actor);
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
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    createFoundryDialog({
      title: qaLocalize("NewDay.Title", "Новый день: {actor}", { actor: actor?.name ?? "" }),
      content,
      buttons: {
        apply: {
          icon: '<i class="fas fa-sun"></i>',
          label: qaLocalize("NewDay.Apply", "Провести новый день"),
          callback: async (html, _event, _button, renderedDialog) => {
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
            let result;
            try {
              result = typeof options.applyHandler === "function"
                ? await options.applyHandler({ actor, plan, selectedIds, source: options.source ?? "manual", targetDate: options.targetDate ?? null })
                : await applyNewDayPlan(actor, plan, selectedIds, {
                    postChat: options.postChat !== false,
                    suppressNotifications: Boolean(options.suppressNotifications),
                    source: options.source ?? "manual"
                  });
            } catch (error) {
              console.error(`${MODULE_ID} | new-day delegated apply failed`, error);
              const stale = ["stale-calendar-day", "multi-day-pending"].includes(String(error?.code ?? ""));
              const message = stale
                ? qaLocalize("NewDay.DelegatedStale", "The calendar changed while this window was open. Close it and resolve the pending day from the current calendar state.")
                : qaLocalize("NewDay.DelegatedFailed", "Could not apply the selected new-day changes. Nothing is marked complete; you can retry or close the window.");
              (stale ? ui.notifications?.warn : ui.notifications?.error)?.call?.(ui.notifications, message);
              return false;
            }

            const calendarMode = String(options.source ?? "").startsWith("calendaria");
            if (!calendarMode) {
              if (result?.failed?.length) {
                ui.notifications?.warn?.(qaLocalize("NewDay.CompletedWithErrors", "Новый день обработан: {success} успешно, {failed} с ошибкой.", {
                  success: result.succeeded.length,
                  failed: result.failed.length
                }));
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
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: qaLocalize("Common.Cancel", "Отмена"),
          callback: () => finish(null)
        }
      },
      default: "apply",
      render: (html, renderedDialog) => {
        const element = extractDialogElement(renderedDialog ?? html);
        element?.closest?.(".app, .application")?.classList.add("fblqa-rest-dialog", "fblqa-new-day-dialog");
        setupNewDayDialogInteractivity(renderedDialog ?? element);
      },
      close: () => finish(null)
    }, {
      classes: ["fblqa-rest-dialog", "fblqa-new-day-dialog"],
      width: 640,
      resizable: true
    }).render(true);
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
      <p class="fblqa-rest-note">${escapeHtml(qaLocalize("NewDay.Note", "Таймеры уменьшаются на один день. Непостоянные травмы и состояния, достигшие нуля, удаляются. Помытость и зависимость используют текущие правила STAT."))}</p>
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
    return action.state?.phase === "flat"
      ? qaLocalize("NewDay.AddictionDayFlat", "Утренняя проверка Endurance; после неё цикл ломки продвинется автоматически.")
      : qaLocalize("NewDay.AddictionDayRoll", "Автобросок тяги 1d{die}: на 1–2 цикл не меняется, на 3+ продвигается автоматически.", {
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
  if (!form) return;

  form.querySelector('[data-action="select-all"]')?.addEventListener("click", () => {
    for (const input of form.querySelectorAll('input[name="newDayAction"]')) input.checked = true;
  });
  form.querySelector('[data-action="select-none"]')?.addEventListener("click", () => {
    for (const input of form.querySelectorAll('input[name="newDayAction"]')) input.checked = false;
  });
}

async function postNewDaySummary(actor, succeeded, failed) {
  if (!succeeded.length && !failed.length) return null;

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
    summary: String(result?.summary ?? ""),
    privateSummary: String(result?.privateSummary ?? "")
  };
}

function failureResult(action, error) {
  return { ok: false, action, error: String(error?.message ?? error ?? "Unknown error") };
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

