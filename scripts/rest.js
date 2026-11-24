import { FLAG_SHORT_REST_RECOVERY, MODULE_ID } from "./constants.js";
import { getActorAttributeState, getProperty } from "./actor-data.js";
import { qaLocalize } from "./i18n.js";
import { findConditionControl, findRestButton } from "./sheet-adapter/forbidden-lands-v1.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, rerenderSheet } from "./utils.js";
import { createFoundryDialog, extractDialogElement, findDialogForm, hasFoundryDialogApi } from "./dialogs.js";
import { canResetShortRestLimit, shouldPostNoChangeRestCards } from "./settings.js";
import { openNewDayDialog } from "./new-day.js";
import { usesCalendariaStateProgression } from "./state-progression.js";
import { getCalendariaQuarterInfo } from "./integration/calendaria-adapter.js";
import { executeActorOperation, handleActorOperation, registerSocketHandler } from "./integration/socket-api.js";
import { documentValuesEqual, getDocumentWriteMismatches, isUnknownWriteOutcome, runDocumentWrite, whisperToGM } from "./document-writes.js";
import { renderModuleTemplate } from "./template-renderer.js";
const REST_DIALOG_TEMPLATE = `modules/${MODULE_ID}/templates/rest/rest-dialog.hbs`;
const QUARTER_SECONDS = 6 * 60 * 60;
const REST_OPERATION = "rest.apply";

export function initializeRestOperations() {
  registerSocketHandler(REST_OPERATION, (payload, context) => handleActorOperation(payload, context, applyRestInternal), { addressed: true });
}

export const REST_ATTRIBUTES = {
  strength: {
    key: "strength",
    short: "STR",
    labelKey: "Rest.AttributeStrength",
    fallback: "Strength",
    consumableKey: "Rest.ConsumableFood",
    consumableFallback: "еда / дополнительная порция пищи"
  },
  agility: {
    key: "agility",
    short: "AGI",
    labelKey: "Rest.AttributeAgility",
    fallback: "Agility",
    consumableKey: "Rest.ConsumableWater",
    consumableFallback: "вода"
  },
  wits: {
    key: "wits",
    short: "WIT",
    labelKey: "Rest.AttributeWits",
    fallback: "Wits",
    consumableKey: "Rest.ConsumableSmoke",
    consumableFallback: "курево / стимулятор / особый расходник"
  },
  empathy: {
    key: "empathy",
    short: "EMP",
    labelKey: "Rest.AttributeEmpathy",
    fallback: "Empathy",
    consumableKey: "Rest.ConsumableConversation",
    consumableFallback: "осмысленная беседа / социальная сцена"
  }
};

export const REST_CONDITIONS = {
  hungry: {
    key: "hungry",
    labelKey: "Rest.ConditionHungry",
    fallback: "Hungry",
    blockedAttributes: ["strength"],
    aliases: ["hungry", "голод", "голоден", "голодная", "голодный"]
  },
  thirsty: {
    key: "thirsty",
    labelKey: "Rest.ConditionThirsty",
    fallback: "Thirsty",
    blockedAttributes: ["agility"],
    aliases: ["thirsty", "жажда", "хочет пить", "испытывает жажду"]
  },
  sleepy: {
    key: "sleepy",
    labelKey: "Rest.ConditionSleepy",
    fallback: "Sleepy",
    blockedAttributes: ["wits"],
    aliases: ["sleepy", "сонный", "сонная", "усталость", "сонливость"]
  },
  cold: {
    key: "cold",
    labelKey: "Rest.ConditionCold",
    fallback: "Cold",
    blockedAttributes: ["strength", "wits"],
    aliases: ["cold", "холод", "замёрз", "замерз", "замёрзший", "замерзший"]
  }
};

export function setupRestButton(app, actor, root) {
  if (!actor || !root) return;

  const nativeButton = findRestButton(root);
  if (!nativeButton || nativeButton.dataset.fblqaRestReady === "true") return;

  const button = nativeButton.cloneNode(true);
  button.dataset.fblqaRestReady = "true";

  // The Forbidden Lands sheet binds its native full-heal Rest behavior to the
  // .rest-up control. Remove that selector from the replacement node so the
  // system's delegated handler cannot see this click at all. The remaining
  // header-button/control classes preserve the visual placement in the header.
  button.classList.remove("rest-up");
  button.classList.add("fblqa-rest-button");
  button.removeAttribute("data-action");
  button.removeAttribute("data-control");
  button.removeAttribute("href");
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.title = qaLocalize("Rest.ButtonTitle", "Отдых по домашним правилам");
  button.setAttribute("aria-label", qaLocalize("Rest.ButtonTitle", "Отдых по домашним правилам"));

  if (!canModifyActor(actor)) {
    button.setAttribute("aria-disabled", "true");
  }

  nativeButton.replaceWith(button);

  const blockNativeRestEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
    button.addEventListener(eventName, blockNativeRestEvent, { capture: true });
  }

  const activateCustomRest = async (event) => {
    blockNativeRestEvent(event);

    if (!canModifyActor(actor)) {
      warnCannotModifyActor();
      return;
    }

    await openRestDialog(app, actor, root);
  };

  button.addEventListener("click", activateCustomRest, { capture: true });

  button.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    await activateCustomRest(event);
  }, { capture: true });
}

export async function openRestDialog(app, actor, root = null) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return null;
  }
  let snapshot;
  try {
    snapshot = buildRestSnapshot(actor, { root });
  } catch (error) {
    console.error(`${MODULE_ID} | could not prepare rest dialog`, error);
    const message = error?.code === "calendaria-quarter-error"
      ? qaLocalize("Rest.CalendariaQuarterError", "Calendaria could not determine the current quarter day. Rest was stopped.")
      : qaLocalize("Rest.UpdateFailed", "Не удалось применить отдых.");
    ui.notifications?.error?.(escapeHtml(message));
    return null;
  }
  if (!hasFoundryDialogApi()) {
    ui.notifications?.warn?.(qaLocalize("Rest.DialogUnavailable", "Окно отдыха недоступно в этом окружении."));
    return;
  }

  let content;
  try {
    content = await renderModuleTemplate(REST_DIALOG_TEMPLATE, restTemplateData(actor, snapshot, {
      canResetShortRest: canResetShortRestLimit(actor)
    }));
  } catch (error) {
    console.error(`${MODULE_ID} | could not render rest dialog`, error);
    ui.notifications?.error?.(qaLocalize("Rest.DialogUnavailable", "Окно отдыха недоступно в этом окружении."));
    return null;
  }
  if (!globalThis.foundry?.applications?.api?.DialogV2) content = `<form class="fblqa-rest-form">${content}</form>`;

  return new Promise((resolve) => {
    let resolved = false;
    let applying = false;
    let dialog = null;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    const closeDialog = async (renderedDialog = null) => {
      const target = renderedDialog ?? dialog;
      try {
        await target?.close?.();
      } catch (error) {
        console.warn(`${MODULE_ID} | could not close rest dialog cleanly`, error);
      }
    };

    dialog = createFoundryDialog({
      title: qaLocalize("Rest.Title", "Отдых: {actor}", { actor: actor?.name ?? "" }),
      content,
      closeOnSubmit: false,
      buttons: {
        apply: {
          icon: '<i class="fas fa-campground"></i>',
          label: qaLocalize("Rest.Apply", "Применить отдых"),
          callback: async (html, _event, _button, renderedDialog) => {
            if (applying) return false;
            applying = true;

            const form = findDialogForm(_button?.form ?? renderedDialog ?? html, "form");
            if (!form) {
              console.error(`${MODULE_ID} | rest form was not available in the rendered dialog`);
              ui.notifications?.error?.(qaLocalize("Rest.UpdateFailed", "Не удалось применить отдых."));
              applying = false;
              return false;
            }

            const options = readRestOptionsFromForm(form);
            const result = await applyRest(app, actor, options);

            if (result?.failed) {
              finish(result);
              await closeDialog(renderedDialog);
              return false;
            }
            if (!result || result.errors?.length) {
              applying = false;
              return false;
            }

            const startsNewDay = options.type === "long" && options.startsNewDay && !usesCalendariaStateProgression();
            finish(result);
            await runPostRestWorkflow({
              startsNewDay,
              closeDialog: () => closeDialog(renderedDialog),
              openNewDay: () => openNewDayDialog(app, actor)
            });
            return false;
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: qaLocalize("Common.Cancel", "Отмена"),
          callback: async (_html, _event, _button, renderedDialog) => {
            finish(null);
            await closeDialog(renderedDialog);
            return false;
          }
        }
      },
      default: "apply",
      render: (html, renderedDialog) => {
        const element = extractDialogElement(renderedDialog ?? html);
        element?.closest?.(".app, .application")?.classList.add("fblqa-rest-dialog");
        const resize = () => scheduleRestDialogAutoSize(dialog, element);
        setupRestDialogInteractivity(renderedDialog?.form ?? renderedDialog ?? element, resize);
        resize();
      },
      close: () => finish(null)
    }, {
      classes: ["fblqa-rest-dialog"],
      width: 560,
      height: "auto",
      resizable: false
    });

    dialog.render(true);
  });
}


export async function runPostRestWorkflow({ startsNewDay = false, closeDialog, openNewDay } = {}) {
  if (typeof closeDialog === "function") await closeDialog();
  if (startsNewDay && typeof openNewDay === "function") await openNewDay();
}

function restTemplateData(actor, snapshot, { canResetShortRest } = {}) {
  const attributes = Object.values(REST_ATTRIBUTES).map(attribute => ({
    key: attribute.key,
    label: localizeAttribute(attribute)
  }));
  const shortUsed = snapshot.shortRestUse?.usedThisQuarter;
  const shortStatus = shortUsed
    ? qaLocalize("Rest.ShortAlreadyUsed", "В этой четверти дня восстановление уже использовано: {attribute}.", {
        attribute: localizeAttribute(REST_ATTRIBUTES[snapshot.shortRestUse.attribute] ?? { fallback: snapshot.shortRestUse.attribute ?? "?" })
      })
    : qaLocalize("Rest.ShortAvailable", "Восстановление Short Rest в этой четверти дня доступно.");

  return {
    attributes,
    conditionChips: Object.values(REST_CONDITIONS).map(condition => ({
      active: snapshot.conditions[condition.key],
      label: localizeCondition(condition)
    })),
    longRows: attributes.map(attribute => longRestAttributeData(actor, snapshot, attribute)),
    calendaria: usesCalendariaStateProgression(),
    canResetShortRest,
    shortUsed,
    shortUsedValue: String(shortUsed),
    shortStatus,
    defaultConsumable: localizeDefaultConsumable(REST_ATTRIBUTES.strength),
    labels: {
      longTitle: qaLocalize("Rest.LongTitle", "Long Rest"),
      shortTitle: qaLocalize("Rest.ShortTitle", "Short Rest"),
      longHeading: qaLocalize("Rest.LongHeading", "Long Rest — 6 часов сна"),
      longDescription: qaLocalize("Rest.LongDescription", "Восстанавливает по 1 единице каждой незаблокированной повреждённой характеристики."),
      heatSource: qaLocalize("Rest.HeatSource", "Есть источник тепла. В конце отдыха снять Cold."),
      calendaria: qaLocalize("Rest.StateProgressionCalendaria", "Daily state progression is handled by Calendaria when a new day is registered. Long Rest does not advance daily states in this mode."),
      startsNewDay: qaLocalize("Rest.StartsNewDay", "Этот отдых начинает новый день"),
      startsNewDayHint: qaLocalize("Rest.StartsNewDayHint", "После Long Rest откроется отдельное окно ежедневного продвижения травм, помытости, состояний и зависимостей."),
      longConditionRemoval: qaLocalize("Rest.LongConditionRemoval", "Sleepy снимается сном. Cold снимается только при источнике тепла. Эти состояния всё равно блокируют восстановление на текущем Long Rest."),
      shortHeading: qaLocalize("Rest.ShortHeading", "Short Rest — 15 минут передышки"),
      shortDescription: qaLocalize("Rest.ShortDescription", "Можно выполнить продолжительные действия. Один раз в четверть дня можно восстановить 1 единицу одной характеристики, если потрачен подходящий расходник или выполнено подходящее условие."),
      timeSource: qaLocalize("Rest.TimeSource", "Источник четверти дня: {source}", { source: snapshot.quarterInfo?.label ?? "—" }),
      useShortRecovery: qaLocalize("Rest.UseShortRecovery", "Восстановить одну характеристику на 1"),
      shortAttribute: qaLocalize("Rest.ShortAttribute", "Характеристика"),
      shortConsumable: qaLocalize("Rest.ShortConsumable", "Расходник / обоснование"),
      resetShortQuarter: qaLocalize("Rest.ResetShortQuarter", "Reset the Short Rest limit for a new Quarter Day"),
      shortManualConsumableNote: qaLocalize("Rest.ShortManualConsumableNote", "Модуль не списывает расходник автоматически: еда, вода, курево, разговоры, наркотики и зелья могут быть оформлены по-разному. Он фиксирует восстановление и пишет выбранное обоснование в результат.")
    }
  };
}

function longRestAttributeData(actor, snapshot, { key, label }) {
  const state = getAttributeState(actor, key);
  const blockedBy = snapshot.blockedBy[key] ?? [];
  const blocked = blockedBy.length > 0;
  const canRecover = !blocked && state.canRecover;
  const status = blocked
    ? qaLocalize("Rest.BlockedBy", "Блокировано: {conditions}", { conditions: blockedBy.map(key => localizeCondition(REST_CONDITIONS[key])).join(", ") })
    : canRecover
      ? qaLocalize("Rest.WillRecover", "Восстановит 1")
      : qaLocalize("Rest.NoRecoveryNeeded", "Не требует восстановления");

  return { label, blocked, canRecover, value: state.hasValue ? `${state.value}/${state.max}` : "—", status };
}

function setupRestDialogInteractivity(dialogOrElement, onLayoutChange = null) {
  const element = extractDialogElement(dialogOrElement);
  setupRestDialogHeader(element);

  const form = findDialogForm(dialogOrElement, "form");
  if (!form) return;
  form.classList.add("fblqa-rest-form");

  const updatePanes = () => {
    const type = form.querySelector('input[name="restType"]:checked')?.value ?? "long";
    for (const pane of form.querySelectorAll("[data-rest-pane]")) {
      const hidden = pane.dataset.restPane !== type;
      pane.hidden = hidden;
      pane.setAttribute("aria-hidden", String(hidden));
    }
    onLayoutChange?.();
  };

  const updateConsumable = () => {
    const attributeKey = form.querySelector('select[name="shortAttribute"]')?.value ?? "strength";
    const input = form.querySelector('input[name="shortConsumable"]');
    if (input && !input.dataset.touched) input.value = localizeDefaultConsumable(REST_ATTRIBUTES[attributeKey] ?? REST_ATTRIBUTES.strength);
  };

  const updateShortRecoveryAvailability = () => {
    const initiallyUsed = form.querySelector(".fblqa-rest-short-status")?.dataset?.shortUsed === "true";
    const reset = form.querySelector('input[name="resetShortQuarter"]')?.checked;
    const locked = initiallyUsed && !reset;
    const recovery = form.querySelector('input[name="useShortRecovery"]');
    if (recovery) {
      recovery.disabled = locked;
      if (locked) recovery.checked = false;
    }
    for (const selector of ['select[name="shortAttribute"]', 'input[name="shortConsumable"]']) {
      const field = form.querySelector(selector);
      if (field) field.disabled = locked;
    }
  };

  if (!form.dataset.fblqaRestBound) {
    form.dataset.fblqaRestBound = "true";
    form.addEventListener("change", (event) => {
      if (event.target?.name === "restType") updatePanes();
      if (event.target?.name === "shortAttribute") updateConsumable();
      if (event.target?.name === "resetShortQuarter") updateShortRecoveryAvailability();
    });
    form.querySelector('input[name="shortConsumable"]')?.addEventListener("input", (event) => {
      event.currentTarget.dataset.touched = "true";
    });
  }

  updatePanes();
  updateConsumable();
  updateShortRecoveryAvailability();
}

function scheduleRestDialogAutoSize(dialog, element) {
  const resize = () => {
    const appElement = element?.closest?.(".app, .application");
    if (!appElement?.isConnected) return;

    const content = appElement.querySelector?.(".window-content");
    appElement.style.height = "auto";
    if (content) {
      content.style.height = "auto";
      content.style.maxHeight = "none";
      content.style.overflowY = "visible";
    }

    dialog?.setPosition?.({ height: "auto" });

    const viewportHeight = Number(globalThis.innerHeight) || 0;
    if (!viewportHeight) return;
    const rect = appElement.getBoundingClientRect?.();
    if (!rect || rect.bottom <= viewportHeight - 12) return;

    dialog?.setPosition?.({
      top: Math.max(12, viewportHeight - rect.height - 12),
      height: "auto"
    });
  };

  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resize));
  } else {
    globalThis.setTimeout?.(resize, 0);
  }
}

function setupRestDialogHeader(element) {
  const app = element?.closest?.(".app, .application");
  const header = app?.querySelector?.(".window-header");
  const template = element?.querySelector?.(".fblqa-rest-header-template");
  if (!header || !template) return;

  header.querySelector(".fblqa-rest-header-conditions")?.remove();

  const title = header.querySelector(".window-title");
  if (title) title.textContent = "";

  const container = document.createElement("div");
  container.className = "fblqa-rest-header-conditions";
  container.setAttribute("aria-label", qaLocalize("Rest.CurrentConditions", "Текущие состояния"));
  container.innerHTML = template.innerHTML;

  const close = header.querySelector('[data-action="close"], .close');
  if (close) header.insertBefore(container, close);
  else header.appendChild(container);
}

function readRestOptionsFromForm(form) {
  return {
    type: form?.querySelector('input[name="restType"]:checked')?.value === "short" ? "short" : "long",
    hasHeatSource: Boolean(form?.querySelector('input[name="hasHeatSource"]')?.checked),
    startsNewDay: Boolean(form?.querySelector('input[name="startsNewDay"]')?.checked),
    useShortRecovery: Boolean(form?.querySelector('input[name="useShortRecovery"]')?.checked),
    shortAttribute: String(form?.querySelector('select[name="shortAttribute"]')?.value ?? "strength"),
    shortConsumable: String(form?.querySelector('input[name="shortConsumable"]')?.value ?? "").trim(),
    resetShortQuarter: Boolean(form?.querySelector('input[name="resetShortQuarter"]')?.checked)
  };
}

async function applyRest(app, actor, options) {
  let result;
  try {
    result = await executeActorOperation(actor, REST_OPERATION, options, applyRestInternal);
  } catch (error) {
    result = restFailure(actor, [], qaLocalize("Rest.StepRequest", "Rest request"), error, options?.type);
  }
  if (result.failed) {
    const notify = result.outcomeUnknown ? ui.notifications?.warn : ui.notifications?.error;
    notify?.call(ui.notifications, escapeHtml(result.error));
    return result;
  }
  if (result.errors.length) {
    ui.notifications?.warn?.(result.errors.join(" "));
    return result;
  }

  ui.notifications?.info?.(result.changed ? result.notification
    : qaLocalize("Rest.NoChanges", "Отдых завершён без изменений на листе."));
  if (result.changed || shouldPostNoChangeRestCards()) {
    try {
      await runDocumentWrite(() => postRestChatMessage(actor, result));
    } catch (error) {
      result.notificationError = String(error?.message ?? error);
      console.error(`${MODULE_ID} | rest applied but chat failed`, error);
      ui.notifications?.warn?.(qaLocalize("Rest.ChatFailed", "Отдых применен, но сообщение в чат не отправлено."));
    }
  }
  if (!result.changed) rerenderSheet(app);
  return result;
}

async function applyRestInternal(actor, options, user) {
  if (!["short", "long"].includes(options.type)) throw new TypeError("Invalid Rest type");
  const { effectsToDelete, clearedConditions: plannedClears, ...result } = options.type === "short"
    ? calculateShortRestChanges(actor, options, { allowResetShortQuarter: canResetShortRestLimit(actor, user) })
    : calculateLongRestChanges(actor, options);
  result.clearedConditions = [];
  if (result.errors.length) return result;

  const update = { ...result.updates };
  // A successful recovery replaces the old marker even when Reset was checked.
  if (result.flagValue !== undefined || result.clearShortRestFlag) {
    update[`flags.${MODULE_ID}.${FLAG_SHORT_REST_RECOVERY}`] = result.flagValue ?? null;
  }
  const steps = [];
  if (Object.keys(update).length) {
    const step = qaLocalize("Rest.StepActorUpdate", "attributes, condition flags and Short Rest limit");
    const source = actor._source ?? actor;
    const before = Object.fromEntries(Object.keys(update).map(path => [path, structuredClone(getProperty(source, path))]));
    const savedPaths = () => Object.keys(update).filter(path => !documentValuesEqual(getProperty(actor._source ?? actor, path), before[path]));
    try {
      await runDocumentWrite(() => actor.update(structuredClone(update)));
      const missing = getDocumentWriteMismatches(actor, update);
      if (missing.length) throw new Error(missing.join(", "));
      if (savedPaths().length) steps.push(step);
    } catch (error) {
      const saved = savedPaths();
      if (!isUnknownWriteOutcome(error) && saved.length) steps.push(saved.join(", "));
      return { ...result, ...restFailure(actor, steps, step, error, result.type) };
    }
  }

  const effectIds = effectsToDelete.map(effect => effect.id ?? effect._id).filter(Boolean);
  if (effectIds.length) {
    const step = qaLocalize("Rest.StepEffectRemoval", "condition ActiveEffect removal");
    const hasEffect = id => Array.from(actor.effects?.values?.() ?? actor.effects ?? []).some(effect => (effect.id ?? effect._id) === id);
    try {
      await runDocumentWrite(() => actor.deleteEmbeddedDocuments("ActiveEffect", [...effectIds]));
      const remaining = effectIds.filter(hasEffect);
      if (remaining.length) throw new Error(remaining.join(", "));
    } catch (error) {
      const removed = effectIds.filter(id => !hasEffect(id));
      if (!isUnknownWriteOutcome(error) && removed.length) steps.push(`${step} (${removed.join(", ")})`);
      return { ...result, ...restFailure(actor, steps, step, error, result.type) };
    }
  }

  if (result.type === "long") {
    result.clearedConditions = plannedClears.filter(key => !isConditionActive(actor, REST_CONDITIONS[key]));
    result.notification = buildLongRestNotification(result.recovered, result.clearedConditions);
  }
  return result;
}

function restFailure(actor, steps, failedStep, cause, type) {
  const outcomeUnknown = isUnknownWriteOutcome(cause);
  const partiallyApplied = steps.length > 0;
  const details = { actor: actor.name, type: type === "short" ? "Short Rest" : type === "long" ? "Long Rest" : "Rest",
    step: failedStep, completed: steps.join(", ") || "—" };
  const error = outcomeUnknown
    ? qaLocalize("Rest.OutcomeUnknown", "{type} for {actor}: the outcome of {step} is unknown. Confirmed steps: {completed}. Check the sheet before trying again.", details)
    : partiallyApplied
      ? qaLocalize("Rest.PartialFailure", "{type} was partially applied to {actor}. Saved: {completed}. Failed step: {step}. Check the sheet before trying again.", details)
      : cause?.code === "calendaria-quarter-error"
        ? qaLocalize("Rest.CalendariaQuarterError", "Calendaria could not determine the current quarter day. Rest was stopped.")
        : qaLocalize("Rest.UpdateFailed", "Не удалось применить отдых.");
  console.error(`${MODULE_ID} | rest update failed`, actor.name, failedStep, cause);
  if (outcomeUnknown || partiallyApplied) whisperToGM(error);
  return { failed: true, outcomeUnknown, partiallyApplied, error, changed: partiallyApplied };
}

export function buildRestSnapshot(actor, context = {}) {
  const conditions = getRestConditionState(actor, context);
  const blockedBy = getBlockedRestAttributes(conditions);
  const quarterInfo = getCurrentQuarterInfo();
  const currentQuarterKey = quarterInfo.key;
  const savedUse = getShortRestRecoveryFlag(actor);

  return {
    conditions,
    blockedBy,
    currentQuarterKey,
    quarterInfo,
    shortRestUse: {
      ...savedUse,
      usedThisQuarter: Boolean(savedUse?.quarterKey && [currentQuarterKey, quarterInfo.legacyKey].includes(savedUse.quarterKey))
    }
  };
}

export function getRestConditionState(actor, context = {}) {
  return Object.fromEntries(
    Object.values(REST_CONDITIONS).map((condition) => [condition.key, isConditionActive(actor, condition, context?.root ?? null)])
  );
}

export function getBlockedRestAttributes(conditionState) {
  const blocked = Object.fromEntries(Object.keys(REST_ATTRIBUTES).map((key) => [key, []]));

  for (const condition of Object.values(REST_CONDITIONS)) {
    if (!conditionState?.[condition.key]) continue;
    for (const attributeKey of condition.blockedAttributes) blocked[attributeKey]?.push(condition.key);
  }

  return blocked;
}

export function calculateLongRestChanges(actor, options = {}, context = {}) {
  const snapshot = buildRestSnapshot(actor, context);
  const updates = {};
  const recovered = [];
  const blocked = [];
  const unchanged = [];

  for (const attribute of Object.values(REST_ATTRIBUTES)) {
    const state = getAttributeState(actor, attribute.key);
    const blockedBy = snapshot.blockedBy[attribute.key] ?? [];

    if (blockedBy.length) {
      blocked.push({ attribute: attribute.key, blockedBy });
      continue;
    }

    if (!state.canRecover) {
      unchanged.push(attribute.key);
      continue;
    }

    updates[state.valuePath] = state.value + 1;
    recovered.push(attribute.key);
  }

  const conditionClears = [];
  if (snapshot.conditions.sleepy) conditionClears.push("sleepy");
  if (options.hasHeatSource === true && snapshot.conditions.cold) conditionClears.push("cold");

  const { conditionUpdates, effectsToDelete, clearedConditions } = buildConditionClearOperations(actor, conditionClears);
  Object.assign(updates, conditionUpdates);

  const changed = Boolean(Object.keys(updates).length || effectsToDelete.length);

  return {
    type: "long",
    updates,
    effectsToDelete,
    flagValue: undefined,
    clearShortRestFlag: false,
    recovered,
    blocked,
    unchanged,
    clearedConditions,
    errors: [],
    changed,
    notification: buildLongRestNotification(recovered, clearedConditions)
  };
}

export function calculateShortRestChanges(actor, options = {}, context = {}) {
  const snapshot = buildRestSnapshot(actor, context);
  const updates = {};
  const effectsToDelete = [];
  const recovered = [];
  const blocked = [];
  const unchanged = [];
  const errors = [];
  let flagValue;
  let clearShortRestFlag = false;

  if (options.resetShortQuarter === true) {
    if (context.allowResetShortQuarter) {
      clearShortRestFlag = true;
      snapshot.shortRestUse.usedThisQuarter = false;
    } else {
      errors.push(qaLocalize("Rest.ResetNotAllowed", "Only the GM can reset the Short Rest limit."));
    }
  }

  if (options.useShortRecovery === true) {
    const attributeKey = REST_ATTRIBUTES[options.shortAttribute]?.key ?? "strength";
    const blockedBy = snapshot.blockedBy[attributeKey] ?? [];
    const state = getAttributeState(actor, attributeKey);

    if (snapshot.shortRestUse.usedThisQuarter) {
      errors.push(qaLocalize("Rest.ShortAlreadyUsedError", "В этой четверти дня восстановление Short Rest уже использовано."));
    } else if (blockedBy.length) {
      blocked.push({ attribute: attributeKey, blockedBy });
      errors.push(qaLocalize("Rest.ShortBlockedError", "Эта характеристика заблокирована состоянием: {conditions}.", {
        conditions: blockedBy.map((key) => localizeCondition(REST_CONDITIONS[key])).join(", ")
      }));
    } else if (!state.canRecover) {
      unchanged.push(attributeKey);
      errors.push(qaLocalize("Rest.ShortNoDamageError", "Выбранная характеристика не требует восстановления."));
    } else {
      updates[state.valuePath] = state.value + 1;
      recovered.push(attributeKey);
      flagValue = {
        quarterKey: snapshot.currentQuarterKey,
        attribute: attributeKey,
        consumable: String(options.shortConsumable ?? "").trim(),
        atWorldTime: Number.isFinite(game?.time?.worldTime) ? game.time.worldTime : null,
        atCalendaria: snapshot.quarterInfo.dateTime ?? null,
        timeSource: snapshot.quarterInfo.source,
        at: Date.now()
      };
    }
  }

  const changed = Boolean(Object.keys(updates).length || flagValue !== undefined || clearShortRestFlag);

  const consumable = options.useShortRecovery === true ? String(options.shortConsumable ?? "").trim() : "";
  return {
    type: "short",
    updates,
    effectsToDelete,
    flagValue,
    clearShortRestFlag,
    recovered,
    blocked,
    unchanged,
    clearedConditions: [],
    errors,
    changed,
    consumable,
    notification: buildShortRestNotification(recovered, consumable)
  };
}

export function getAttributeState(actor, attributeKey) {
  return getActorAttributeState(actor, attributeKey);
}

function isConditionActive(actor, condition, root = null) {
  const actorValue = readActorConditionValue(actor, condition.key);
  if (normalizeConditionValue(actorValue)) return true;
  if (findConditionEffects(actor, condition, actor.appliedEffects ?? actor.allApplicableEffects?.()).length > 0) return true;
  if (actorValue !== undefined) return false;

  const domValue = readDomConditionValue(root, condition.key);
  if (domValue !== undefined) return normalizeConditionValue(domValue);

  return false;
}

function readActorConditionValue(actor, key) {
  for (const path of getConditionPaths(key)) {
    const value = getProperty(actor, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function readDomConditionValue(root, key) {
  const control = findConditionControl(root, key);
  if (!control) return undefined;

  for (const name of ["aria-pressed", "aria-checked", "data-active", "data-value", "data-state", "data-checked"]) {
    const value = control.getAttribute?.(name);
    if (value !== null && value !== undefined && value !== "") return value;
  }

  const checkbox = control.querySelector?.('input[type="checkbox"], input[type="radio"]');
  if (checkbox) return Boolean(checkbox.checked);

  const activeClassNames = ["active", "is-active", "checked", "selected", "on"];
  if (activeClassNames.some((className) => control.classList?.contains?.(className))) return true;

  const inactiveClassNames = ["inactive", "is-inactive", "disabled", "off"];
  if (inactiveClassNames.some((className) => control.classList?.contains?.(className))) return false;

  const marker = control.querySelector?.(
    ".active, .is-active, .checked, .selected, .fa-check-circle, .fa-circle-check, .fa-dot-circle, .fa-circle-dot"
  );
  if (marker) return true;

  return undefined;
}

function buildConditionClearOperations(actor, keys) {
  const conditionUpdates = {};
  const effectsToDelete = [];
  const effectIds = new Set();
  const clearedConditions = [];

  for (const key of keys) {
    const spec = REST_CONDITIONS[key];
    if (!spec) continue;

    addConditionClearUpdates(actor, key, conditionUpdates);

    // Forbidden Lands v13 condition buttons are backed by ActiveEffects.
    // Updating system.condition.<key>.value alone can leave the ActiveEffect in
    // place, and the sheet will immediately show the condition again. Mirror the
    // system's own toggleCondition flow: write the system flag to false AND
    // delete the matching status effect.
    for (const effect of findConditionEffects(actor, spec)) {
      const id = effect?.id ?? effect?._id ?? effect?.uuid ?? effect?.name ?? effect?.label;
      if (id && effectIds.has(id)) continue;
      if (id) effectIds.add(id);
      effectsToDelete.push(effect);
    }

    clearedConditions.push(key);
  }

  return { conditionUpdates, effectsToDelete, clearedConditions };
}

function addConditionClearUpdates(actor, key, updates) {
  let updated = false;

  for (const path of getConditionPaths(key)) {
    const value = getProperty(actor._source ?? actor, path);
    if (value === undefined) continue;

    const paths = getClearUpdatePathsForValue(path, value);
    for (const updatePath of paths) {
      updates[updatePath] = false;
      updated = true;
    }
  }

  // Forbidden Lands v13 stores sheet conditions under system.condition.<key>.value.
  // When the current sheet state was detected from the DOM fallback, actor data
  // may not expose the path through the generic readers during this render. Use
  // the known system path as a safe final write target instead of reporting that
  // the condition was cleared while changing nothing.
  if (!updated) {
    updates[`system.condition.${key}.value`] = false;
    updated = true;
  }

  return updated;
}

function getClearUpdatePathsForValue(path, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = [];
    if ("value" in value) nested.push(`${path}.value`);
    if ("active" in value) nested.push(`${path}.active`);
    if ("checked" in value) nested.push(`${path}.checked`);
    if (nested.length) return nested;
  }

  return [path];
}

function findConditionEffects(actor, condition, effects = actor?.effects ?? []) {
  const aliases = new Set(condition.aliases.map((value) => normalizeAlias(value)));
  aliases.add(normalizeAlias(condition.key));
  const statusEffect = globalThis.CONFIG?.statusEffects?.find?.((entry) => normalizeAlias(entry?.id) === normalizeAlias(condition.key));
  const statusIcon = statusEffect?.img ?? statusEffect?.icon ?? null;

  return Array.from(effects.values?.() ?? effects).filter((effect) => {
    if (effect.active === false || effect.disabled || effect.isSuppressed) return false;
    const statusIds = new Set([...(effect.statuses ?? []), ...(effect.flags?.core?.statusId ? [effect.flags.core.statusId] : [])].map(normalizeAlias));
    for (const status of statusIds) if (aliases.has(status)) return true;

    if (statusIcon && (effect?.img === statusIcon || effect?.icon === statusIcon)) return true;

    const label = normalizeAlias(effect.name ?? effect.label ?? effect.title ?? "");
    return aliases.has(label);
  });
}

function getConditionPaths(key) {
  return [
    `system.condition.${key}.value`,
    `system.condition.${key}.active`,
    `system.condition.${key}.checked`,
    `system.condition.${key}`,
    `system.conditions.${key}.value`,
    `system.conditions.${key}.active`,
    `system.conditions.${key}.checked`,
    `system.conditions.${key}`,
    `system.bio.conditions.${key}.value`,
    `system.bio.conditions.${key}.active`,
    `system.bio.conditions.${key}.checked`,
    `system.bio.conditions.${key}`,
    `system.status.${key}.value`,
    `system.status.${key}.active`,
    `system.status.${key}.checked`,
    `system.status.${key}`
  ];
}

function normalizeConditionValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text || text === "false" || text === "0" || text === "off" || text === "no") return false;
    return true;
  }
  if (value && typeof value === "object") {
    if ("value" in value) return normalizeConditionValue(value.value);
    if ("active" in value) return normalizeConditionValue(value.active);
    if ("checked" in value) return normalizeConditionValue(value.checked);
  }
  return false;
}

function getShortRestRecoveryFlag(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, FLAG_SHORT_REST_RECOVERY) ?? actor?.flags?.[MODULE_ID]?.[FLAG_SHORT_REST_RECOVERY] ?? null;
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

export function getCurrentQuarterKey() {
  return getCurrentQuarterInfo().key;
}

export function getCurrentQuarterInfo() {
  const info = getCalendariaQuarterInfo();
  if (info) return {
    ...info,
    source: "calendaria",
    label: qaLocalize("Rest.TimeSourceCalendaria", "Calendaria: {date}, четверть {quarter}", {
      date: info.dateLabel, quarter: info.quarterIndex + 1
    })
  };

  const worldTime = game?.time?.worldTime;
  if (Number.isFinite(worldTime)) {
    const quarter = Math.floor(worldTime / QUARTER_SECONDS);
    return {
      key: `world:${quarter}`,
      source: "foundry",
      label: qaLocalize("Rest.TimeSourceFoundry", "Foundry world time")
    };
  }

  return {
    key: "manual",
    source: "manual",
    label: qaLocalize("Rest.TimeSourceManual", "ручной режим")
  };
}

function buildLongRestNotification(recovered, clearedConditions) {
  return qaLocalize("Rest.LongResult", "Long Rest применён. Восстановлено: {attributes}. Снято: {conditions}.", {
    attributes: recovered.length ? recovered.map((key) => localizeAttribute(REST_ATTRIBUTES[key])).join(", ") : qaLocalize("Rest.None", "ничего"),
    conditions: clearedConditions.length ? clearedConditions.map((key) => localizeCondition(REST_CONDITIONS[key])).join(", ") : qaLocalize("Rest.None", "ничего")
  });
}

function buildShortRestNotification(recovered, consumable) {
  return qaLocalize("Rest.ShortResult", "Short Rest применён. Восстановлено: {attributes}. Расходник: {consumable}.", {
    attributes: recovered.length ? recovered.map((key) => localizeAttribute(REST_ATTRIBUTES[key])).join(", ") : qaLocalize("Rest.None", "ничего"),
    consumable: consumable || qaLocalize("Rest.NotSpecified", "не указан")
  });
}

async function postRestChatMessage(actor, result) {
  if (!globalThis.ChatMessage?.create) return;

  const title = result.type === "long" ? qaLocalize("Rest.LongTitle", "Long Rest") : qaLocalize("Rest.ShortTitle", "Short Rest");
  const recovered = result.recovered.length
    ? result.recovered.map((key) => escapeHtml(localizeAttribute(REST_ATTRIBUTES[key]))).join(", ")
    : escapeHtml(qaLocalize("Rest.None", "ничего"));
  const cleared = result.clearedConditions.length
    ? result.clearedConditions.map((key) => escapeHtml(localizeCondition(REST_CONDITIONS[key]))).join(", ")
    : escapeHtml(qaLocalize("Rest.None", "ничего"));
  const blocked = result.blocked.length
    ? result.blocked.map((entry) => `${escapeHtml(localizeAttribute(REST_ATTRIBUTES[entry.attribute]))}: ${entry.blockedBy.map((key) => escapeHtml(localizeCondition(REST_CONDITIONS[key]))).join(", ")}`).join("<br>")
    : escapeHtml(qaLocalize("Rest.None", "ничего"));

  const content = `
    <div class="fblqa-rest-chat-card">
      <h3>${escapeHtml(title)} — ${escapeHtml(actor?.name ?? "")}</h3>
      <p><strong>${qaLocalize("Rest.ChatRecovered", "Восстановлено")}:</strong> ${recovered}</p>
      ${result.type === "long" ? `<p><strong>${qaLocalize("Rest.ChatCleared", "Снято")}:</strong> ${cleared}</p>` : ""}
      <p><strong>${qaLocalize("Rest.ChatBlocked", "Заблокировано")}:</strong><br>${blocked}</p>
      ${result.type === "short" && result.consumable ? `<p><strong>${qaLocalize("Rest.ShortConsumable", "Расходник / обоснование")}:</strong> ${escapeHtml(result.consumable)}</p>` : ""}
    </div>
  `;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker?.({ actor }) ?? undefined,
    content
  });
}

function localizeAttribute(attribute) {
  return qaLocalize(attribute?.labelKey ?? "Rest.UnknownAttribute", attribute?.fallback ?? String(attribute?.key ?? "?"));
}

function localizeCondition(condition) {
  return qaLocalize(condition?.labelKey ?? "Rest.UnknownCondition", condition?.fallback ?? String(condition?.key ?? "?"));
}

function localizeDefaultConsumable(attribute) {
  return qaLocalize(attribute?.consumableKey ?? "Rest.ConsumableOther", attribute?.consumableFallback ?? "особый расходник");
}

function normalizeAlias(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}
