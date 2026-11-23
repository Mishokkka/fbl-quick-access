import { CONDITIONS_TAB_ID, FLAGS, LEGACY_MODULE_ID, MODULE_ID } from "./constants.js";
import { getConditionKind } from "./condition-kind.js";
import { getActorAttributeState } from "../actor-data.js";
import { confirmDangerAction, createFoundryDialog, findDialogForm } from "../dialogs.js";
import { findActorSheetRoot } from "../sheet-adapter/forbidden-lands-v1.js";
import { registerSettings } from "./settings.js";
import { runWorldMigration } from "./migrations.js";
import {
  canUserEditActor,
  createChatMessage,
  escapeHTML,
  localize,
  parseStatDuration
} from "./utils.js";
import { getWashDisplayName, initializeWashOperations } from "./features/wash.js";
import {
  getAddictionState,
  applyHeatFailure,
  changeMor,
  coolHeatItem,
  initializeCounterOperations,
  updateHeatItem
} from "./features/special-counters.js";
import {
  activateConditionsTab,
  bindNativeSheetTabs,
  ensureConditionsTabButton,
  getSheetTabGroup,
  syncConditionsTabChrome
} from "./features/sheet-tab.js";
import { renderConditionItemRow, renderConditionsRows, renderStatTab } from "./render/stat-tab-renderer.js";
import { refreshConditionsRows } from "./render/refresh-rows.js";
import { bindStatDrag, cancelStatDrag, waitForStatDrag } from "./features/row-drag.js";
import {
  buildAddictionRelapseMessage,
  buildHeatChangeMessage
} from "./services/chat-service.js";
import { correctAddictionState, getAddictionMorning, initializeAddictionOperations, performAddictionMorning, relapseAddiction, resolveAddictionMorning } from "./services/addiction-service.js";
import { activateStatProviderListeners, renderStatProviderSections } from "../integration/stat-providers.js";
import { initializeStatOperations, readStatConditions, runStatOperation } from "./services/stat-operations.js";

const STAT_SCROLL_POSITIONS = new Map();
const STAT_RENDER_GENERATIONS = new WeakMap();
const STAT_ROW_VIEWS = new WeakMap();
const SPECIAL_ACTION_ITEMS = new WeakSet();

function setConditionDetailsExpanded(row, expanded) {
  row.children(".injury-desc, .condition-desc").stop(true, true).toggle(expanded);
  const title = row.find(".condition-details-toggle");
  title.attr("aria-expanded", String(expanded));
  title.find(".collapse-icon").toggleClass("fa-chevron-right", !expanded).toggleClass("fa-chevron-down", expanded);
  row.find(".heat-check").attr("aria-expanded", String(expanded));
}

function toggleConditionDetails(row) {
  const expanded = row.children(".injury-desc").css("display") === "none";
  setConditionDetailsExpanded(row, expanded);
}

function askAddictionDose(failure = true) {
  return new Promise(resolve => {
    const dialog = createFoundryDialog({
      title: localize("Addiction.DoseTitle", "Dose available?"),
      content: `<p>${escapeHTML(failure
        ? localize("Addiction.DoseQuestion", "Is a dose available to take? Taking it resets the cycle to d12; without it the cycle advances.")
        : localize("Addiction.TakeDoseQuestion", "Confirm that an available dose is taken. This resets the cycle to decline d12; No dose or Cancel leaves it unchanged."))}</p>`,
      buttons: {
        dose: { label: localize("Addiction.HasDose", "Take a dose"), callback: () => resolve(true) },
        none: { label: localize("Addiction.NoDose", "No dose"), callback: () => resolve(false) },
        cancel: { label: localize("Delete.ConfirmNo", "Cancel"), callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }, { classes: ["fblqa-rest-dialog"], width: 440 });
    if (!dialog) { resolve(null); return; }
    dialog.render(true);
  });
}

function editAddictionState(state) {
  return new Promise(resolve => {
    const options = (values, selected) => values.map(([value, label]) =>
      `<option value="${value}"${String(value) === String(selected) ? " selected" : ""}>${escapeHTML(label)}</option>`).join("");
    const dialog = createFoundryDialog({
      title: localize("Addiction.EditState", "Edit Addiction cycle"),
      content: `<form class="fblqa-condition-editor">
        <label>${escapeHTML(localize("Addiction.Stage", "Stage"))}<select name="phase">${options([
          ["down", localize("Addiction.PhaseDown", "Decline")], ["flat", localize("Addiction.PhaseFlat", "Withdrawal")],
          ["up", localize("Addiction.PhaseUp", "Recovery")]], state.phase)}</select></label>
        <label>${escapeHTML(localize("Addiction.Die", "Die"))}<select name="die">${options([6, 8, 10, 12].map(value => [value, `d${value}`]), state.die)}</select></label>
        <label>${escapeHTML(localize("Addiction.DaysLeft", "Days left"))}<input name="daysLeft" type="number" min="1" max="365" value="${Number(state.daysLeft) || Number(state.severity)}"></label>
        <label>${escapeHTML(localize("Addiction.Severity", "Severity"))}<select name="severity">${options([
          [1, localize("Addiction.SeverityLight", "Light")], [5, localize("Addiction.SeverityMedium", "Medium")],
          [10, localize("Addiction.SeveritySevere", "Severe")]], state.severity)}</select></label>
      </form>`,
      render: root => {
        const form = findDialogForm(root);
        if (!form) return;
        const sync = () => {
          const flat = form.elements.phase.value === "flat";
          form.elements.die.disabled = flat;
          form.elements.daysLeft.disabled = !flat;
        };
        form.elements.phase.addEventListener("change", sync);
        sync();
      },
      buttons: {
        save: { label: localize("UI.Save", "Save"), callback: root => {
          const form = findDialogForm(root);
          if (!form) return resolve(null);
          resolve({ phase: form.elements.phase.value, die: Number(form.elements.die.value),
            daysLeft: form.elements.phase.value === "flat" ? Number(form.elements.daysLeft.value) : 0,
            severity: Number(form.elements.severity.value) });
        } },
        cancel: { label: localize("Delete.ConfirmNo", "Cancel"), callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }, { classes: ["fblqa-rest-dialog"], width: 360 });
    if (!dialog) return resolve(null);
    dialog.render(true);
  });
}

export function invalidateExpandedConditionsRender(app) {
  if (!app || typeof app !== "object") return;
  cancelStatDrag(app);
  STAT_ROW_VIEWS.delete(app);
  STAT_RENDER_GENERATIONS.set(app, (STAT_RENDER_GENERATIONS.get(app) ?? 0) + 1);
}

export function initExpandedConditions() {
  registerSettings();
  initializeAddictionOperations();
  initializeCounterOperations();
  initializeWashOperations();
  initializeStatOperations();
}

export async function readyExpandedConditions() {
  if (game.modules.get(LEGACY_MODULE_ID)?.active) {
    ui.notifications.warn(localize("Notifications.LegacyModuleActive", "Disable the legacy Expanded Conditions module. Its features are now integrated into Quick Access."));
  }
  await runWorldMigration();
}

export async function handleExpandedConditionsCreateItem(item, options, userId) {
  if (options?.fblqaWashTransition) return;
  const actor = item.parent;
  if (game.user.id !== userId || item.type !== "criticalInjury"
    || actor?.documentName !== "Actor" || actor.type !== "character") return;
  try { await runStatOperation(actor, { kind: "item-created", itemId: item.id }); }
  catch (error) { notifyStatError(error); }
}


export async function persistNormalizedCustomConditions(actor, _customConditions, { changed, editable } = {}) {
  if (!editable || !changed) return false;
  return (await runStatOperation(actor, { kind: "normalize" })).changed;
}

export function refreshExpandedConditionsRows(app, root) {
  const view = STAT_ROW_VIEWS.get(app);
  return view && view.root === (findActorSheetRoot(root) ?? root) ? view.refreshRows() : renderExpandedConditions(app, root);
}

function notifyStatError(error) {
  console.error(`${MODULE_ID} | condition action failed`, error);
  if (error?.code === "condition-partial-failure" || error?.code === "condition-outcome-unknown") {
    if (!error.notified) ui.notifications?.error?.(escapeHTML(error.message));
  } else if (error?.code === "timeout") {
    ui.notifications?.warn?.(localize("Notifications.ConditionOutcomeUnknown", "The outcome is unknown. Check the sheet manually before repeating."));
  } else {
    ui.notifications?.error?.(localize("Notifications.ConditionActionFailed", "The action could not be completed. Refresh the sheet and retry."));
  }
}

export async function renderExpandedConditions(app, html) {
  invalidateExpandedConditionsRender(app);
  if (app.actor?.type !== "character") return;
  const generation = STAT_RENDER_GENERATIONS.get(app);
  const root = findActorSheetRoot(html);
  const isCurrent = () => STAT_RENDER_GENERATIONS.get(app) === generation && root?.isConnected !== false;
  if (root) root.classList.add("fblqa-sheet-root", "fblqa-actor-sheet-root", "fblec-sheet-root");

  html = html instanceof jQuery ? html : $(html);
  const editable = canUserEditActor(app.actor);

  const nav = html.find(".sheet-tabs").first();
  const tabGroup = getSheetTabGroup(html, nav);
  ensureConditionsTabButton(html, app);

  html.find(".sheet-tabs").off("click.customTab").on("click.customTab", "[data-tab]", (ev) => {
    app._customActiveTab = $(ev.currentTarget).data("tab");
    window.setTimeout(() => syncConditionsTabChrome(html), 0);
  });

  // Rendering must remain read-only. Performing embedded-document migrations
  // here can race a wash-state create/delete sequence and leave Foundry trying
  // to update an Item that was removed milliseconds earlier. World/actor data
  // migration is handled outside the render lifecycle; normalized values are
  // still used locally for a stable UI.

  const readLayout = () => Number(app.actor.getFlag(MODULE_ID, FLAGS.LAYOUT_COLUMNS)) === 2 ? 2 : 1;
  const scrollKey = getStatScrollKey(app);
  const captureScroll = () => captureStatScrollPosition(html, scrollKey);
  const restoreScroll = () => restoreStatScrollPosition(html, scrollKey);

  const getInjuries = () => Array.from(app.actor.items?.values?.() ?? app.actor.items).filter(i => i.type === "criticalInjury");

  async function buildRows() {
    return renderConditionsRows({
      customConditions: readStatConditions(app.actor),
      injuries: getInjuries(),
      editable
    });
  }

  let rowRefresh = 0;
  async function refreshRows() {
    const revision = ++rowRefresh;
    const rows = await refreshConditionsRows({ html, buildRows, captureScroll, restoreScroll,
      isCurrent: () => isCurrent() && rowRefresh === revision,
      beforeReplace: () => cancelStatDrag(app) });
    if (rows !== null) applyLayout(readLayout());
    return rows;
  }

  const rowsHtml = await buildRows();
  const providerSections = await renderStatProviderSections({
    app,
    actor: app.actor,
    editable
  });
  const tabHtml = await renderStatTab({
    tabGroup,
    rowsHtml,
    providerSectionsHtml: providerSections.html,
    editable,
    layoutColumns: readLayout()
  });
  if (!isCurrent()) return;
  const existingTab = html.find(`.conditions-tab[data-tab="${CONDITIONS_TAB_ID}"]`);
  if (!existingTab.length) html.find(".sheet-body").append(tabHtml);
  else existingTab.replaceWith(tabHtml);

  // Keep the STAT CSS scope intact even if a cached or externally overridden
  // template omits the classes. Without this class the system renders raw row
  // markup, including full-size journal images and unstyled controls.
  const renderedStatTab = html.find(`.conditions-tab[data-tab="${CONDITIONS_TAB_ID}"]`).first();
  renderedStatTab.addClass("fblec-stat-tab");
  renderedStatTab.toggleClass("fblec-readonly", !editable);
  activateStatProviderListeners({
    app,
    actor: app.actor,
    editable,
    tabRoot: renderedStatTab[0]
  }, providerSections.providers);

  bindStatScrollCapture(html, captureScroll);
  restoreScroll();

  async function submitStatCommand(command) {
    try { return await runStatOperation(app.actor, command); }
    catch (error) { notifyStatError(error); return null; }
  }

  async function persistRowOrder() {
    const rows = html.find(".conditions-rows > [data-row-kind]").get().map(element => ({
      kind: element.dataset.rowKind,
      id: element.dataset.conditionId ?? element.dataset.itemId
    }));
    await submitStatCommand({ kind: "order", rows });
    await refreshRows();
  }

  function getRowItem(row) {
    return app.actor.items.get(row.data("item-id"));
  }

  async function refreshItemRow(item, rowHint = null) {
    if (!isCurrent() || !item || !app.actor.items.get(item.id)) return null;

    captureScroll();
    const row = rowHint?.jquery ? rowHint[0] : rowHint;
    const current = row?.isConnected ? $(row) : html.find(`.conditions-rows > [data-item-id="${item.id}"]`).first();
    if (!current?.length) {
      await refreshRows();
      return null;
    }

    const description = current.children(".injury-desc, .condition-desc");
    const wasExpanded = description.length > 0 && description.css("display") !== "none";
    const rowHtml = await renderConditionItemRow(item, editable);
    if (!isCurrent() || !current[0]?.isConnected) return null;
    cancelStatDrag(app);
    const replacement = $(rowHtml);
    current.replaceWith(replacement);
    if (wasExpanded) setConditionDetailsExpanded(replacement, true);
    restoreScroll();
    return replacement;
  }
  async function refreshAfterSpecialItemAction(item, row, result = null) {
    if (!isCurrent()) return;
    if (result?.refreshRows) return refreshRows();
    if (result?.cured || !app.actor.items.get(item.id)) {
      cancelStatDrag(app);
      row?.remove?.();
      return;
    }
    await refreshItemRow(app.actor.items.get(item.id), row);
  }

  function syncAttributeDamageInputs(appliedDamage = []) {
    for (const entry of appliedDamage) {
      if (!entry?.path) continue;
      html.find(`[name="${entry.path}"]`).val(entry.value);
    }
  }

  function requireEditable() {
    if (editable) return true;
    ui.notifications.warn(localize("Permissions.ReadOnly", "STAT is read-only. Editing is disabled in module settings."));
    return false;
  }

  async function runSpecialItemAction(ev, operation) {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".injury-row");
    const item = getRowItem(row);
    if (!item || SPECIAL_ACTION_ITEMS.has(item)) return;
    SPECIAL_ACTION_ITEMS.add(item);
    row.find("button, select, input").prop("disabled", true);
    let result;
    try { result = await operation(item); }
    catch (error) { notifyStatError(error); }
    finally {
      SPECIAL_ACTION_ITEMS.delete(item);
      await refreshAfterSpecialItemAction(item, row, result);
    }
    return result;
  }

  async function postHeatResult(result, mode) {
    if (!result?.changed) return;
    try { await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content: buildHeatChangeMessage(app.actor.name, result, mode) }); }
    catch (error) { console.error(`${MODULE_ID} | heat result chat failed`, error); }
  }

  html.find(".conditions-tab").off("click", ".injury-header, .condition-header").on("click", ".injury-header, .condition-header", (ev) => {
    const header = $(ev.currentTarget);
    const row = header.parent();

    if ($(ev.target).closest(".injury-healing-inline, .condition-time-inline, .mor-controls, .heat-controls, .addiction-controls, .addiction-delete-btn, .fblec-drag-handle, input, textarea, button, select").length) return;

    if (row.is(".special-addiction-row, .special-heat-row")) {
      toggleConditionDetails(row);
      return;
    }

    const desc = row.children(".injury-desc, .condition-desc");
    const icon = header.find(".collapse-icon");
    desc.slideToggle(200);
    if (!icon.hasClass("fa-pills") && !icon.hasClass("fa-biohazard") && !icon.hasClass("fa-temperature-high")) {
      icon.toggleClass("fa-chevron-down fa-chevron-up");
    }
  });

  html.find(".conditions-tab").off("keydown", ".condition-details-toggle").on("keydown", ".condition-details-toggle", ev => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleConditionDetails($(ev.currentTarget).closest(".injury-row"));
  });

  // System injuries.
  function bindInjuryAction(eventType, selector, command) {
    html.find(".conditions-tab").off(eventType, selector).on(eventType, selector, event => runSpecialItemAction(event, async item => {
      const action = await command(event.currentTarget, item);
      if (!action) return;
      const result = await runStatOperation(app.actor, { ...action, itemId: item.id });
      if (result?.reason === "unresolved-duration") {
        ui.notifications.warn(localize("Notifications.TreatmentUnresolvedTime", "Resolve the healing duration into a number of days before applying treatment."));
      } else if (result?.reason === "treated") {
        ui.notifications.warn(localize("Notifications.TreatmentAlreadyApplied", "Treatment has already been applied. Reset it before choosing another result."));
      } else if (result?.changed && action.kind === "stabilize") {
        ui.notifications.info(localize("Notifications.InjuryStabilized", "Injury “{name}” has been stabilized and is no longer lethal.", { name: escapeHTML(item.name) }));
      } else if (result?.changed && action.kind === "treatment") {
        const name = escapeHTML(item.name);
        if (action.action === "fail") ui.notifications.warn(localize("Notifications.TreatmentFailed", "Treatment of “{name}” failed. Healing time was recalculated from its original value.", { name }));
        else if (action.action === "prof") ui.notifications.info(localize("Notifications.TreatmentProfessional", "Injury “{name}” was treated professionally. Healing time was recalculated from its original value.", { name }));
        else ui.notifications.info(localize("Notifications.TreatmentNormal", "Injury “{name}” was treated.", { name }));
      }
      return result;
    }));
  }

  html.find(".conditions-tab").off("change", ".injury-name-input").on("change", ".injury-name-input", async event => {
    if (!requireEditable()) return;
    const control = event.currentTarget;
    const row = $(control).closest(".injury-row");
    const item = getRowItem(row);
    if (!item) return;
    const kind = getConditionKind(item);
    const value = control.value;
    await submitStatCommand({ kind: "item-name", itemId: item.id, value });
    const live = app.actor.items.get(item.id);
    if (!isCurrent() || !live) return;
    if (getConditionKind(live) !== kind) {
      await waitForStatDrag(app);
      if (isCurrent()) await refreshRows();
    } else if (control.isConnected && control.value === value) {
      const name = kind === "wash" ? getWashDisplayName(live.name) : live.name;
      control.value = name;
      row.find(".injury-img").attr("title", name);
    }
  });
  html.find(".conditions-tab").off("change", ".injury-notes").on("change", ".injury-notes", async event => {
    if (!requireEditable()) return;
    const control = event.currentTarget;
    const item = getRowItem($(control).closest(".injury-row"));
    if (item) await submitStatCommand({ kind: "item-notes", itemId: item.id, value: control.value });
  });
  bindInjuryAction("click", ".delete-injury", async (_control, item) =>
    await confirmStatDelete(item.name, "injury") ? { kind: "item-delete" } : null);
  bindInjuryAction("click", ".heal-minus, .heal-plus", control => ({
    kind: "healing-time", delta: control.classList.contains("heal-plus") ? 1 : -1
  }));
  bindInjuryAction("click", ".toggle-lethal-btn", () => ({ kind: "stabilize" }));
  bindInjuryAction("click", ".lethal-limit-btn", control => ({
    kind: "lethal-limit", delta: control.classList.contains("lethal-limit-plus") ? 1 : -1
  }));
  bindInjuryAction("click", ".treatment-btn", control => ({ kind: "treatment", action: control.dataset.action }));
  bindInjuryAction("click", ".treatment-reset-btn", () => ({ kind: "treatment-reset" }));

  // Addiction.
  html.find(".conditions-tab").off("change", ".addiction-severity-select").on("change", ".addiction-severity-select", async (ev) => {
    const severity = Number(ev.currentTarget.value);
    await runSpecialItemAction(ev, item => correctAddictionState(app.actor, item, {
      severity, documentOptions: { render: false }
    }));
  });

  html.find(".conditions-tab").off("click", ".addiction-plus, .addiction-minus").on("click", ".addiction-plus, .addiction-minus", async (ev) => {
    const delta = $(ev.currentTarget).hasClass("addiction-plus") ? 1 : -1;
    await runSpecialItemAction(ev, item => correctAddictionState(app.actor, item, { delta, documentOptions: { render: false } }));
  });

  html.find(".conditions-tab").off("click", ".addiction-edit").on("click", ".addiction-edit", async (ev) => {
    await runSpecialItemAction(ev, async item => {
      const state = await editAddictionState(getAddictionState(item));
      if (!state) return;
      return correctAddictionState(app.actor, item, { state, documentOptions: { render: false } });
    });
  });

  html.find(".conditions-tab").off("click", ".addiction-morning").on("click", ".addiction-morning", async (ev) => {
    await runSpecialItemAction(ev, item => performAddictionMorning(app.actor, item, { documentOptions: { render: false } }));
  });

  html.find(".conditions-tab").off("click", ".addiction-advance").on("click", ".addiction-advance", async (ev) => {
    await runSpecialItemAction(ev, item => resolveAddictionMorning(app.actor, item, "success", {
      morningId: getAddictionMorning(item)?.id, documentOptions: { render: false }
    }));
  });

  html.find(".conditions-tab").off("click", ".addiction-failure").on("click", ".addiction-failure", async (ev) => {
    await runSpecialItemAction(ev, async item => {
      const morningId = getAddictionMorning(item)?.id;
      if (getAddictionMorning(item)?.status !== "pending") return;
      const hasDose = await askAddictionDose();
      if (hasDose === null) return;
      return resolveAddictionMorning(app.actor, item, hasDose ? "failure-dose" : "failure-no-dose", {
        morningId, documentOptions: { render: false }
      });
    });
  });

  html.find(".conditions-tab").off("click", ".addiction-relapse").on("click", ".addiction-relapse", async (ev) => {
    await runSpecialItemAction(ev, async item => {
      if (await askAddictionDose(false) !== true) return;
      const result = await relapseAddiction(app.actor, item, { documentOptions: { render: false } });
      try { await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content: buildAddictionRelapseMessage(app.actor.name, item.name) }); }
      catch (error) { console.error(`${MODULE_ID} | addiction relapse chat failed`, error); }
      return result;
    });
  });

  // Heat.
  html.find(".conditions-tab").off("click", ".heat-plus, .heat-minus").on("click", ".heat-plus, .heat-minus", async (ev) => {
    const btn = $(ev.currentTarget);
    const delta = btn.hasClass("heat-plus") ? 1 : -1;
    await runSpecialItemAction(ev, async item => {
      const result = await (delta > 0 ? applyHeatFailure(app.actor, item, { render: false })
        : coolHeatItem(app.actor, item, { render: false })).catch(error => {
        if (isCurrent()) syncAttributeDamageInputs(error?.appliedDamage);
        throw error;
      });
      syncAttributeDamageInputs(result?.appliedDamage);
      await postHeatResult(result, delta > 0 ? "failure" : "reduce");
      return result;
    });
  });

  html.find(".conditions-tab").off("change", ".heat-input").on("change", ".heat-input", async (ev) => {
    const match = String(ev.currentTarget.value).trim().match(/^([0-4])(?:\s*\/\s*4)?$/);
    await runSpecialItemAction(ev, item => match
      ? updateHeatItem(app.actor, item, Number(match[1]), "manual", { render: false }) : null);
  });

  html.find(".conditions-tab").off("keydown", ".heat-input").on("keydown", ".heat-input", ev => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    ev.stopPropagation();
    $(ev.currentTarget).trigger("change");
  });

  html.find(".conditions-tab").off("click", ".heat-check").on("click", ".heat-check", async (ev) => {
    const row = $(ev.currentTarget).closest(".special-heat-row");
    toggleConditionDetails(row);
  });

  // Mor.
  const morButtons = ".mor-item-x-plus, .mor-item-x-minus, .mor-item-y-plus, .mor-item-y-minus";
  html.find(".conditions-tab").off("click", morButtons).on("click", morButtons, event => {
    const classes = event.currentTarget.classList;
    const current = classes.contains("mor-item-x-plus") || classes.contains("mor-item-x-minus");
    const delta = classes.contains("mor-item-x-plus") || classes.contains("mor-item-y-plus") ? 1 : -1;
    return runSpecialItemAction(event, async item => {
      const result = await changeMor(app.actor, item, current ? "current" : "permanent", delta, { render: false }).catch(error => {
        if (isCurrent() && current && delta > 0 && ["condition-partial-failure", "condition-outcome-unknown", "timeout"].includes(error?.code)) {
          const strength = getActorAttributeState(app.actor, "strength");
          if (strength.hasValue) syncAttributeDamageInputs([{ path: strength.valuePath, value: strength.value }]);
        }
        throw error;
      });
      if (result?.changed === false && current && delta < 0) {
        ui.notifications.warn(localize("Notifications.NoCurrentMor", "There are no current Mor points to remove."));
      }
      syncAttributeDamageInputs(result?.appliedDamage);
      return result;
    });
  });

  // Custom conditions.
  const timeButtons = ".time-plus, .time-minus";
  html.find(".conditions-tab").off("click", timeButtons).on("click", timeButtons, async event => {
    if (!requireEditable()) return;
    const control = event.currentTarget;
    if (control.disabled) return;
    const button = $(control);
    const controls = button.closest(".condition-time-inline").find(timeButtons);
    const id = control.closest(".condition-row")?.dataset.conditionId;
    controls.prop("disabled", true);
    try {
      const result = await submitStatCommand({ kind: "custom-time", id, delta: button.hasClass("time-plus") ? 1 : -1 });
      if (result?.changed && isCurrent()) {
        const condition = readStatConditions(app.actor).find(entry => entry.id === id);
        if (condition) button.siblings(".condition-time").val(condition.time);
      }
    } finally { controls.prop("disabled", false); }
  });

  html.find(".add-condition").off("click").on("click", async event => {
    if (!requireEditable()) return;
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    try {
      if ((await submitStatCommand({ kind: "custom-add" }))?.changed) await refreshRows();
    } finally { button.disabled = false; }
  });

  function applyLayout(columns) {
    const tab = html.find(".conditions-tab");
    tab.removeClass("fblec-columns-1 fblec-columns-2").addClass(`fblec-columns-${columns}`);
    tab.attr("data-layout-columns", columns);
    const button = tab.find(".layout-toggle");
    const next = columns === 2 ? 1 : 2;
    button.data("columns", next).attr("data-columns", next);
    button.text(columns === 2 ? localize("UI.OneColumn", "1 column") : localize("UI.TwoColumns", "2 columns"));
    button.attr("title", columns === 2 ? localize("UI.SwitchToOneColumn", "Switch STAT to one column") : localize("UI.SwitchToTwoColumns", "Switch STAT to two columns"));
  }

  html.find(".layout-toggle").off("click").on("click", async event => {
    if (!requireEditable()) return;
    const control = event.currentTarget;
    if (control.disabled) return;
    control.disabled = true;
    const columns = Number($(control).data("columns")) === 2 ? 2 : 1;
    try {
      if ((await submitStatCommand({ kind: "layout", columns }))?.changed && isCurrent()) applyLayout(columns);
    } finally { control.disabled = false; }
  });

  const removeSelector = ".delete-condition:not(.delete-injury)";
  html.find(".conditions-tab").off("click", removeSelector).on("click", removeSelector, async event => {
    if (!requireEditable()) return;
    const button = event.currentTarget;
    if (button.disabled) return;
    const row = $(button).closest(".condition-row");
    const id = row[0]?.dataset.conditionId;
    const conditionName = row.find(".condition-name").val() || row.find(".condition-name-static").text();
    button.disabled = true;
    try {
      if (await confirmStatDelete(conditionName, "condition") && (await submitStatCommand({ kind: "custom-remove", id }))?.changed) {
        cancelStatDrag(app);
        row.remove();
      }
    } finally { button.disabled = false; }
  });

  const fields = { "condition-name": "name", "condition-time": "time", "condition-notes": "notes", "condition-desc-input": "desc" };
  const inputs = Object.keys(fields).map(name => `.condition-row[data-condition-id] .${name}`).join(", ");
  html.find(".conditions-tab").off("change", inputs).on("change", inputs, async event => {
    if (!requireEditable()) return;
    const control = event.currentTarget;
    const field = Object.keys(fields).find(name => control.classList.contains(name));
    const row = control.closest(".condition-row");
    const id = row?.dataset.conditionId;
    const value = control.value;
    const result = await submitStatCommand({ kind: "custom-edit", id, field: fields[field], value });
    if (result?.changed && field === "condition-time" && isCurrent() && control.isConnected && control.value === value) {
      const hidden = !parseStatDuration(value);
      const buttons = $(control).siblings(timeButtons);
      const focused = document.activeElement;
      if (hidden && buttons.get().includes(focused)) {
        row.querySelector(focused.classList.contains("time-plus") ? removeSelector : ".condition-name")?.focus();
      }
      buttons.prop("hidden", hidden);
    }
  });

  bindStatDrag(app, html, { editable, isCurrent, persistRowOrder });
  STAT_ROW_VIEWS.set(app, { root, refreshRows });

  async function confirmStatDelete(name, type = "entry") {
    const fallbackName = type === "condition" ? localize("Delete.ConditionFallback", "condition") : localize("Delete.InjuryFallback", "injury");
    const entryName = String(name || fallbackName);
    return confirmDangerAction({
      title: localize("Delete.ConfirmTitle", "Delete STAT entry?"),
      heading: localize("Delete.ConfirmHeading", "Confirm deletion"),
      message: localize("Delete.ConfirmMessage", "Delete “{name}”?", { name: entryName }),
      warning: localize("Delete.ConfirmWarning", "This cannot be undone."),
      confirmLabel: localize("Delete.ConfirmYes", "Delete"),
      cancelLabel: localize("Delete.ConfirmNo", "Cancel"),
      icon: "fas fa-trash"
    });
  }

  bindNativeSheetTabs(app, html);
  window.setTimeout(() => syncConditionsTabChrome(html), 0);

  if (app._customActiveTab === CONDITIONS_TAB_ID) {
    activateConditionsTab(app, html);
  }
}

function getStatScrollKey(app) {
  return app?.actor?.uuid ?? app?.actor?.id ?? app?.id ?? "default";
}

function bindStatScrollCapture(html, captureScroll) {
  const statTab = getStatScrollElements(html).statTab;
  if (!statTab || statTab.dataset.fblecScrollCaptureReady === "true") return;

  statTab.dataset.fblecScrollCaptureReady = "true";
  for (const eventName of ["pointerdown", "mousedown", "click", "change", "input", "keydown"]) {
    statTab.addEventListener(eventName, captureScroll, true);
  }
}

function captureStatScrollPosition(html, key) {
  const elements = getStatScrollElements(html);
  const position = {};

  for (const [name, element] of Object.entries(elements)) {
    if (!element) continue;
    position[name] = {
      top: Number(element.scrollTop) || 0,
      left: Number(element.scrollLeft) || 0
    };
  }

  if (!STAT_SCROLL_POSITIONS.has(key) && STAT_SCROLL_POSITIONS.size >= 50) {
    const oldestKey = STAT_SCROLL_POSITIONS.keys().next().value;
    STAT_SCROLL_POSITIONS.delete(oldestKey);
  }
  STAT_SCROLL_POSITIONS.set(key, position);
}

function restoreStatScrollPosition(html, key) {
  const position = STAT_SCROLL_POSITIONS.get(key);
  if (!position) return;

  const apply = () => {
    const elements = getStatScrollElements(html);
    for (const [name, saved] of Object.entries(position)) {
      const element = elements[name];
      if (!element || !saved) continue;
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
    }
  };

  window.setTimeout(apply, 0);
  window.setTimeout(apply, 60);
}

function getStatScrollElements(html) {
  const root = findActorSheetRoot(html);
  const base = extractHtmlElement(html);
  const statTab = queryWithin(root, `.conditions-tab[data-tab="${CONDITIONS_TAB_ID}"]`)
    ?? queryWithin(base, `.conditions-tab[data-tab="${CONDITIONS_TAB_ID}"]`);

  return {
    windowContent: queryWithin(root, ".window-content") ?? queryWithin(base, ".window-content"),
    sheetBody: queryWithin(root, ".sheet-body") ?? queryWithin(base, ".sheet-body"),
    statTab,
    conditionsList: queryWithin(statTab, ".conditions-list")
  };
}

function queryWithin(element, selector) {
  return element?.querySelector?.(selector) ?? null;
}

function extractHtmlElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}
