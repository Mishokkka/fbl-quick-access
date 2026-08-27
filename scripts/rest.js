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
const QUARTER_SECONDS = 6 * 60 * 60;

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
  const snapshot = buildRestSnapshot(actor, { root });
  const content = buildRestDialogContent(actor, snapshot, {
    canResetShortRest: canResetShortRestLimit(actor)
  });

  if (!hasFoundryDialogApi()) {
    ui.notifications?.warn?.(qaLocalize("Rest.DialogUnavailable", "Окно отдыха недоступно в этом окружении."));
    return;
  }

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
            const result = await applyRest(app, actor, options, {
              root,
              allowResetShortQuarter: canResetShortRestLimit(actor)
            });

            if (!result || result.failed || result.errors?.length) {
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

function buildRestDialogContent(actor, snapshot, permissions = {}) {
  const conditionChips = Object.values(REST_CONDITIONS)
    .map((condition) => renderConditionChip(condition, snapshot.conditions[condition.key]))
    .join("");

  const longRows = Object.values(REST_ATTRIBUTES)
    .map((attribute) => renderLongAttributeRow(actor, snapshot, attribute))
    .join("");

  const attributeOptions = Object.values(REST_ATTRIBUTES)
    .map((attribute) => `<option value="${attribute.key}">${escapeHtml(localizeAttribute(attribute))}</option>`)
    .join("");

  const shortUsed = snapshot.shortRestUse?.usedThisQuarter;
  const shortStatus = shortUsed
    ? qaLocalize("Rest.ShortAlreadyUsed", "В этой четверти дня восстановление уже использовано: {attribute}.", {
        attribute: escapeHtml(localizeAttribute(REST_ATTRIBUTES[snapshot.shortRestUse.attribute] ?? { fallback: snapshot.shortRestUse.attribute ?? "?" }))
      })
    : qaLocalize("Rest.ShortAvailable", "Восстановление Short Rest в этой четверти дня доступно.");

  const newDayControl = usesCalendariaStateProgression()
    ? `<div class="fblqa-rest-progression-note"><i class="fas fa-calendar-day" aria-hidden="true"></i><span>${escapeHtml(qaLocalize("Rest.StateProgressionCalendaria", "Daily state progression is handled by Calendaria when a new day is registered. Long Rest does not advance daily states in this mode."))}</span></div>`
    : `<label class="fblqa-rest-check fblqa-rest-new-day-check">
          <input type="checkbox" name="startsNewDay">
          <span>
            <strong>${qaLocalize("Rest.StartsNewDay", "Этот отдых начинает новый день")}</strong>
            <small>${qaLocalize("Rest.StartsNewDayHint", "После Long Rest откроется отдельное окно ежедневного продвижения травм, помытости, состояний и зависимостей.")}</small>
          </span>
        </label>`;

  return `
    <form class="fblqa-rest-form">
      <div class="fblqa-rest-header-template" hidden>${conditionChips}</div>

      <fieldset class="fblqa-rest-type-switch">
        <label><input type="radio" name="restType" value="long" checked> <span>${qaLocalize("Rest.LongTitle", "Long Rest")}</span></label>
        <label><input type="radio" name="restType" value="short"> <span>${qaLocalize("Rest.ShortTitle", "Short Rest")}</span></label>
      </fieldset>

      <section class="fblqa-rest-pane" data-rest-pane="long">
        <div class="fblqa-rest-pane-head">
          <h2>${qaLocalize("Rest.LongHeading", "Long Rest — 6 часов сна")}</h2>
          <p>${qaLocalize("Rest.LongDescription", "Восстанавливает по 1 единице каждой незаблокированной повреждённой характеристики.")}</p>
        </div>
        <label class="fblqa-rest-check">
          <input type="checkbox" name="hasHeatSource">
          <span>${qaLocalize("Rest.HeatSource", "Есть источник тепла. В конце отдыха снять Cold.")}</span>
        </label>
        ${newDayControl}
        <div class="fblqa-rest-attribute-table">${longRows}</div>
        <p class="fblqa-rest-note">${qaLocalize("Rest.LongConditionRemoval", "Sleepy снимается сном. Cold снимается только при источнике тепла. Эти состояния всё равно блокируют восстановление на текущем Long Rest.")}</p>
      </section>

      <section class="fblqa-rest-pane" data-rest-pane="short" hidden aria-hidden="true">
        <div class="fblqa-rest-pane-head">
          <h2>${qaLocalize("Rest.ShortHeading", "Short Rest — 15 минут передышки")}</h2>
          <p>${qaLocalize("Rest.ShortDescription", "Можно выполнить продолжительные действия. Один раз в четверть дня можно восстановить 1 единицу одной характеристики, если потрачен подходящий расходник или выполнено подходящее условие.")}</p>
        </div>
        <div class="fblqa-rest-short-status${shortUsed ? " is-used" : ""}">${shortStatus}</div>
        <div class="fblqa-rest-time-source">${qaLocalize("Rest.TimeSource", "Источник четверти дня: {source}", { source: escapeHtml(snapshot.quarterInfo?.label ?? "—") })}</div>
        <label class="fblqa-rest-check">
          <input type="checkbox" name="useShortRecovery" ${shortUsed ? "disabled" : ""}>
          <span>${qaLocalize("Rest.UseShortRecovery", "Восстановить одну характеристику на 1")}</span>
        </label>
        <label class="fblqa-rest-field">
          <span>${qaLocalize("Rest.ShortAttribute", "Характеристика")}</span>
          <select name="shortAttribute" ${shortUsed ? "disabled" : ""}>${attributeOptions}</select>
        </label>
        <label class="fblqa-rest-field">
          <span>${qaLocalize("Rest.ShortConsumable", "Расходник / обоснование")}</span>
          <input type="text" name="shortConsumable" value="${escapeHtml(localizeDefaultConsumable(REST_ATTRIBUTES.strength))}" ${shortUsed ? "disabled" : ""}>
        </label>
        ${permissions.canResetShortRest ? `
          <label class="fblqa-rest-check fblqa-rest-reset-quarter">
            <input type="checkbox" name="resetShortQuarter">
            <span>${qaLocalize("Rest.ResetShortQuarter", "Reset the Short Rest limit for a new Quarter Day")}</span>
          </label>` : ""}
        <p class="fblqa-rest-note">${qaLocalize("Rest.ShortManualConsumableNote", "Модуль не списывает расходник автоматически: еда, вода, курево, разговоры, наркотики и зелья могут быть оформлены по-разному. Он фиксирует восстановление и пишет выбранное обоснование в результат.")}</p>
      </section>
    </form>
  `;
}

function renderConditionChip(condition, isActive) {
  const label = escapeHtml(localizeCondition(condition));
  const stateClass = isActive ? "is-active" : "is-inactive";
  const icon = isActive ? "fa-circle-exclamation" : "fa-circle-check";
  return `<span class="fblqa-rest-condition ${stateClass}"><i class="fas ${icon}" aria-hidden="true"></i>${label}</span>`;
}

function renderLongAttributeRow(actor, snapshot, attribute) {
  const state = getAttributeState(actor, attribute.key);
  const blockedBy = snapshot.blockedBy[attribute.key] ?? [];
  const blocked = blockedBy.length > 0;
  const canRecover = !blocked && state.canRecover;
  const status = blocked
    ? qaLocalize("Rest.BlockedBy", "Блокировано: {conditions}", { conditions: blockedBy.map((key) => escapeHtml(localizeCondition(REST_CONDITIONS[key]))).join(", ") })
    : canRecover
      ? qaLocalize("Rest.WillRecover", "Восстановит 1")
      : qaLocalize("Rest.NoRecoveryNeeded", "Не требует восстановления");

  return `
    <div class="fblqa-rest-attribute-row${blocked ? " is-blocked" : ""}${canRecover ? " will-recover" : ""}">
      <strong>${escapeHtml(localizeAttribute(attribute))}</strong>
      <span>${state.hasValue ? `${state.value}/${state.max}` : "—"}</span>
      <em>${status}</em>
    </div>
  `;
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

  form.addEventListener("input", (event) => {
    if (event.target?.name === "restType") updatePanes();
  });
  form.addEventListener("change", (event) => {
    if (event.target?.name === "restType") updatePanes();
    if (event.target?.name === "shortAttribute") updateConsumable();
  });
  form.querySelector('input[name="shortConsumable"]')?.addEventListener("input", (event) => {
    event.currentTarget.dataset.touched = "true";
  });

  updatePanes();
  updateConsumable();
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

async function applyRest(app, actor, options, context = {}) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return null;
  }

  const result = options.type === "short"
    ? calculateShortRestChanges(actor, options, context)
    : calculateLongRestChanges(actor, options, context);

  if (result.errors.length) {
    ui.notifications?.warn?.(result.errors.join(" "));
    return result;
  }

  try {
    const effectIds = result.effectsToDelete
      .map((effect) => effect?.id ?? effect?._id)
      .filter(Boolean);

    // Actor data and the short-rest flag are one logical mutation. Keep them in
    // one Actor.update so a rest does not emit multiple updateActor/render cycles.
    const actorUpdate = { ...result.updates };
    if (result.flagValue !== undefined) {
      actorUpdate[`flags.${MODULE_ID}.${FLAG_SHORT_REST_RECOVERY}`] = result.flagValue;
    }
    // Clearing wins if a future rule ever requests both in the same rest result.
    // Use a normal null assignment instead of Foundry's `.-=` deletion path:
    // Forbidden Lands v13 can reject that deletion shape in Actor._preUpdate.
    // All Short Rest reads already treat null exactly like an absent marker.
    if (result.clearShortRestFlag) {
      actorUpdate[`flags.${MODULE_ID}.${FLAG_SHORT_REST_RECOVERY}`] = null;
    }

    const hasActorUpdate = Object.keys(actorUpdate).length > 0;
    if (hasActorUpdate) await actor.update(actorUpdate);
    if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds);

    if (result.changed) {
      ui.notifications?.info?.(result.notification);
    } else {
      ui.notifications?.info?.(qaLocalize("Rest.NoChanges", "Отдых завершён без изменений на листе."));
    }

    if (result.changed || shouldPostNoChangeRestCards()) {
      await postRestChatMessage(actor, result, options);
    }
    // A real Document mutation already asks Foundry to refresh dependent sheets.
    // Preserve the historical explicit refresh only for a no-op rest.
    if (!hasActorUpdate && !effectIds.length) rerenderSheet(app);
  } catch (error) {
    console.error(`${MODULE_ID} | rest update failed`, error);
    ui.notifications?.error?.(qaLocalize("Rest.UpdateFailed", "Не удалось применить отдых."));
    return { ...result, failed: true, error };
  }

  return result;
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
      usedThisQuarter: Boolean(savedUse?.quarterKey && savedUse.quarterKey === currentQuarterKey)
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
  if (options.hasHeatSource && snapshot.conditions.cold) conditionClears.push("cold");

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

  if (options.resetShortQuarter) {
    if (context.allowResetShortQuarter) {
      clearShortRestFlag = true;
      snapshot.shortRestUse.usedThisQuarter = false;
    } else {
      errors.push(qaLocalize("Rest.ResetNotAllowed", "Only the GM can reset the Short Rest limit."));
    }
  }

  if (options.useShortRecovery) {
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
        atWorldTime: Number.isFinite(Number(game?.time?.worldTime)) ? Number(game.time.worldTime) : null,
        atCalendaria: getCalendariaDateTime() ?? null,
        timeSource: snapshot.quarterInfo.source,
        at: Date.now()
      };
    }
  }

  const changed = Boolean(Object.keys(updates).length || flagValue !== undefined || clearShortRestFlag);

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
    consumable: String(options.shortConsumable ?? "").trim(),
    notification: buildShortRestNotification(recovered, options.shortConsumable)
  };
}

export function getAttributeState(actor, attributeKey) {
  return getActorAttributeState(actor, attributeKey);
}

function isConditionActive(actor, condition, root = null) {
  const actorValue = readActorConditionValue(actor, condition.key);
  if (actorValue !== undefined) return normalizeConditionValue(actorValue);

  if (findConditionEffects(actor, condition).length > 0) return true;

  const domValue = readDomConditionValue(root, condition.key);
  if (domValue !== undefined) return normalizeConditionValue(domValue);

  return false;
}

function readActorConditionValue(actor, key) {
  for (const path of getConditionReadPaths(key)) {
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

  for (const path of getConditionWritePaths(key)) {
    const value = getProperty(actor, path);
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

function findConditionEffects(actor, condition) {
  const effects = actor?.effects ? [...actor.effects] : [];
  const aliases = new Set(condition.aliases.map((value) => normalizeAlias(value)));
  aliases.add(normalizeAlias(condition.key));
  const statusEffect = globalThis.CONFIG?.statusEffects?.find?.((entry) => normalizeAlias(entry?.id) === normalizeAlias(condition.key));
  const statusIcon = statusEffect?.img ?? statusEffect?.icon ?? null;

  return effects.filter((effect) => {
    const statusIds = new Set([...(effect.statuses ?? []), ...(effect.flags?.core?.statusId ? [effect.flags.core.statusId] : [])].map(normalizeAlias));
    for (const status of statusIds) if (aliases.has(status)) return true;

    if (statusIcon && (effect?.img === statusIcon || effect?.icon === statusIcon)) return true;

    const label = normalizeAlias(effect.name ?? effect.label ?? effect.title ?? "");
    return aliases.has(label);
  });
}

function getConditionReadPaths(key) {
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

function getConditionWritePaths(key) {
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
  const calendaria = getCalendariaQuarterInfo();
  if (calendaria) return calendaria;

  const worldTime = Number(game?.time?.worldTime);
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

function getCalendariaQuarterInfo() {
  const dateTime = getCalendariaDateTime();
  if (!dateTime) return null;

  const year = Number(dateTime.year);
  const month = Number(dateTime.month);
  const day = Number(dateTime.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  const activeCalendar = getCalendariaApi()?.getActiveCalendar?.();
  const hoursPerDay = readFiniteNumber(activeCalendar?.days?.hoursPerDay);
  const quarterHours = Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay / 4 : 6;
  const hour = readFiniteNumber(dateTime.hour);
  const minute = readFiniteNumber(dateTime.minute);
  const second = readFiniteNumber(dateTime.second);
  const timeOfDay = (Number.isFinite(hour) ? hour : 0)
    + (Number.isFinite(minute) ? minute / 60 : 0)
    + (Number.isFinite(second) ? second / 3600 : 0);
  const quarterIndex = Math.max(0, Math.min(3, Math.floor(timeOfDay / quarterHours)));

  return {
    key: `calendaria:${year}:${month}:${day}:q${quarterIndex}`,
    source: "calendaria",
    label: qaLocalize("Rest.TimeSourceCalendaria", "Calendaria: {date}, четверть {quarter}", {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      quarter: String(quarterIndex + 1)
    })
  };
}

function getCalendariaDateTime() {
  try {
    const api = getCalendariaApi();
    const value = api?.getCurrentDateTime?.();
    return value && typeof value === "object" ? value : null;
  } catch (_error) {
    return null;
  }
}

function getCalendariaApi() {
  return globalThis.CALENDARIA?.api ?? null;
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

async function postRestChatMessage(actor, result, options) {
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
      ${result.type === "short" && options.shortConsumable ? `<p><strong>${qaLocalize("Rest.ShortConsumable", "Расходник / обоснование")}:</strong> ${escapeHtml(options.shortConsumable)}</p>` : ""}
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

function readFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function normalizeAlias(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}
