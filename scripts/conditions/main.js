import { CONDITIONS_TAB_ID, FLAGS, LEGACY_MODULE_ID, MODULE_ID, flagDeletePath, flagUpdatePath } from "./constants.js";
import { confirmDangerAction } from "../dialogs.js";
import { findActorSheetRoot } from "../sheet-adapter/forbidden-lands-v1.js";
import { registerSettings } from "./settings.js";
import { migrateActorData, runWorldMigration } from "./migrations.js";
import {
  applyActorAttributeDamage,
  canUserEditActor,
  createChatMessage,
  escapeHTML,
  localize,
  makeCustomCondition,
  normalizeConditionName,
  normalizeCustomConditionList,
  rollToMessage
} from "./utils.js";
import { removeOtherWashStates, transitionWashLevel, isWashCondition } from "./features/wash.js";
import {
  getAddictionState,
  getHeatDefinition,
  getHeatLevel,
  getMorState,
  normalizeAddictionSeverityChange,
  parseHeatValue,
  updateAddictionModifiers,
  updateHeatItem,
  updateMorItem
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
import {
  buildAddictionRelapseMessage,
  buildHeatChangeMessage,
  buildHeatCheckMessage,
  buildMorGainMessage,
  buildMorRemoveMessage
} from "./services/chat-service.js";
import { advanceAddictionCycle, performAddictionMorning } from "./services/addiction-service.js";
import { activateStatProviderListeners, renderStatProviderSections } from "../integration/stat-providers.js";

const STAT_SCROLL_POSITIONS = new Map();

export function initExpandedConditions() {
  registerSettings();
}

export async function readyExpandedConditions() {
  if (game.modules.get(LEGACY_MODULE_ID)?.active) {
    ui.notifications.warn(localize("Notifications.LegacyModuleActive", "Disable the legacy Expanded Conditions module. Its features are now integrated into Quick Access."));
  }
  await runWorldMigration();
}

export async function handleExpandedConditionsCreateItem(item, options, userId) {
  if (game.user.id !== userId) return;
  if (item.type !== "criticalInjury") return;
  if (!isWashCondition(item)) return;

  const actor = item.parent;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;

  await removeOtherWashStates(actor, item);
}

export async function renderExpandedConditions(app, html) {
  if (app.actor?.type !== "character") return;

  const root = findActorSheetRoot(html);
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

  if (game.user.isGM || app.actor.isOwner) await migrateActorData(app.actor);

  const customNormalization = normalizeCustomConditionList(foundry.utils.deepClone(app.actor.getFlag(MODULE_ID, FLAGS.LIST) || []));
  let customConditions = customNormalization.list;
  if (customNormalization.changed) await app.actor.update({ [flagUpdatePath(FLAGS.LIST)]: customConditions }, { render: false });

  let layoutColumns = Number(app.actor.getFlag(MODULE_ID, FLAGS.LAYOUT_COLUMNS)) === 2 ? 2 : 1;
  const scrollKey = getStatScrollKey(app);
  const captureScroll = () => captureStatScrollPosition(html, scrollKey);
  const restoreScroll = () => restoreStatScrollPosition(html, scrollKey);

  const getInjuries = () => app.actor.items.filter(i => i.type === "criticalInjury");

  async function buildRows() {
    return renderConditionsRows({
      customConditions,
      injuries: getInjuries(),
      editable
    });
  }

  async function refreshRows() {
    return refreshConditionsRows({ html, buildRows, captureScroll, restoreScroll });
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
    layoutColumns
  });
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

  async function saveCustom() {
    if (!editable) return;

    const rowsById = new Map();

    html.find(".conditions-rows > .condition-row[data-condition-id]").each((i, el) => {
      const row = $(el);
      const id = String(row.data("condition-id") || "");
      const previous = foundry.utils.deepClone(customConditions.find(condition => condition.id === id) || { id });
      const order = Number(row.data("order") ?? i * 10);

      if (row.hasClass("arc-row")) {
        previous.desc = row.find(".condition-desc-input").val() ?? previous.desc ?? "";
        previous.order = Number.isFinite(order) ? order : i * 10;
        rowsById.set(id, makeCustomCondition(previous));
        return;
      }

      rowsById.set(id, makeCustomCondition({
        id,
        order: Number.isFinite(order) ? order : i * 10,
        name: row.find(".condition-name").val() ?? previous.name ?? "",
        time: row.find(".condition-time").val() ?? previous.time ?? "0",
        notes: row.find(".condition-notes").val() ?? previous.notes ?? "",
        desc: row.find(".condition-desc-input").val() ?? previous.desc ?? ""
      }));
    });

    const updated = Array.from(rowsById.values()).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    customConditions = updated;
    await app.actor.update({ [flagUpdatePath(FLAGS.LIST)]: updated }, { render: false });
  }

  async function persistRowOrder() {
    if (!editable) return;

    const customMap = new Map(customConditions.map(condition => [condition.id, foundry.utils.deepClone(condition)]));
    const itemUpdates = [];

    html.find(".conditions-rows > [data-row-kind]").each((i, el) => {
      const row = $(el);
      const order = i * 10;
      row.attr("data-order", order).data("order", order);

      const kind = String(row.data("row-kind") || "");
      if (kind === "custom") {
        const id = String(row.data("condition-id") || "");
        const condition = customMap.get(id);
        if (condition) condition.order = order;
      } else if (kind === "item") {
        const itemId = String(row.data("item-id") || "");
        if (itemId) itemUpdates.push({ _id: itemId, [flagUpdatePath(FLAGS.ORDER)]: order });
      }
    });

    customConditions = Array.from(customMap.values()).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    await app.actor.update({ [flagUpdatePath(FLAGS.LIST)]: customConditions }, { render: false });
    if (itemUpdates.length) await app.actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false });
  }


  function getRowItem(row) {
    return app.actor.items.get(row.data("item-id"));
  }

  async function refreshItemRow(item, rowHint = null) {
    if (!item || !app.actor.items.get(item.id)) return null;

    captureScroll();
    const current = rowHint?.jquery
      ? rowHint
      : rowHint instanceof HTMLElement
        ? $(rowHint)
        : html.find(`.conditions-rows > [data-item-id="${item.id}"]`).first();
    if (!current?.length) {
      await refreshRows();
      return null;
    }

    const description = current.children(".injury-desc, .condition-desc");
    const wasExpanded = description.length > 0 && description.css("display") !== "none";
    const rowHtml = await renderConditionItemRow(item, editable);
    const replacement = $(rowHtml);
    current.replaceWith(replacement);
    if (wasExpanded) replacement.children(".injury-desc, .condition-desc").show();
    restoreScroll();
    return replacement;
  }

  async function updateItemAndRefresh(item, update, rowHint = null) {
    if (!item) return null;
    await item.update(update, { render: false });
    return refreshItemRow(item, rowHint);
  }

  async function deleteItemAndRemoveRow(item, rowHint = null) {
    if (!item) return;
    const row = rowHint?.jquery ? rowHint : rowHint instanceof HTMLElement ? $(rowHint) : null;
    await item.delete({ render: false });
    row?.remove();
  }

  async function refreshAfterSpecialItemAction(item, row, result = null) {
    if (result?.cured || !app.actor.items.get(item.id)) {
      row?.remove?.();
      return;
    }
    await refreshItemRow(item, row);
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

  html.find(".conditions-tab").off("click", ".injury-header, .condition-header").on("click", ".injury-header, .condition-header", (ev) => {
    const header = $(ev.currentTarget);
    const row = header.parent();

    if (row.hasClass("special-addiction-row")) {
      if (!$(ev.target).closest(".addiction-collapse-toggle").length) return;
    } else {
      if ($(ev.target).closest(".injury-healing-inline, .condition-time-inline, .mor-controls, .heat-controls, .addiction-delete-btn, .fblec-drag-handle, input, textarea, button, select").length) return;
    }

    const desc = row.children(".injury-desc, .condition-desc");
    const icon = header.find(".collapse-icon");
    desc.slideToggle(200);
    if (!icon.hasClass("fa-pills") && !icon.hasClass("fa-biohazard") && !icon.hasClass("fa-temperature-high")) {
      icon.toggleClass("fa-chevron-down fa-chevron-up");
    }
  });

  // System injuries.
  html.find(".conditions-tab").off("change", ".injury-name-input").on("change", ".injury-name-input", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".injury-row"));
    if (item) await updateItemAndRefresh(item, { name: ev.currentTarget.value }, $(ev.currentTarget).closest(".injury-row"));
  });

  html.find(".conditions-tab").off("change", ".injury-notes").on("change", ".injury-notes", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".injury-row"));
    if (item) await item.update({ [flagUpdatePath(FLAGS.NOTES)]: ev.currentTarget.value }, { render: false });
  });

  html.find(".conditions-tab").off("click", ".delete-injury").on("click", ".delete-injury", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".injury-row"));
    if (!item) return;
    if (!(await confirmStatDelete(item.name, "injury"))) return;
    await deleteItemAndRemoveRow(item, $(ev.currentTarget).closest(".injury-row"));
  });

  html.find(".conditions-tab").off("click", ".heal-minus, .heal-plus").on("click", ".heal-minus, .heal-plus", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const item = getRowItem(btn.closest(".injury-row"));
    if (!item) return;

    const timeStr = item.system.healingTime || "0";
    const match = timeStr.match(/(\d+)/);
    if (!match) return;

    let currentVal = parseInt(match[0], 10);
    if (btn.hasClass("heal-plus")) currentVal += 1;
    else currentVal = Math.max(0, currentVal - 1);

    if (currentVal === 0 && isWashCondition(item) && btn.hasClass("heal-minus")) {
      await transitionWashLevel(app.actor, item.name, { render: false });
      await refreshRows();
    } else {
      const newStr = timeStr.replace(/(\d+)/, currentVal);
      await updateItemAndRefresh(item, { "system.healingTime": newStr }, btn.closest(".injury-row"));
    }
  });

  html.find(".conditions-tab").off("click", ".toggle-lethal-btn").on("click", ".toggle-lethal-btn", async (ev) => {
    if (!requireEditable()) return;
    const item = app.actor.items.get($(ev.currentTarget).data("item-id"));
    if (item) {
      await updateItemAndRefresh(item, { "system.lethal": "no" }, $(ev.currentTarget).closest(".injury-row"));
      ui.notifications.info(localize("Notifications.InjuryStabilized", "Injury “{name}” has been stabilized and is no longer lethal.", { name: escapeHTML(item.name) }));
    }
  });

  html.find(".conditions-tab").off("click", ".lethal-limit-btn").on("click", ".lethal-limit-btn", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const item = app.actor.items.get(btn.data("item-id"));
    if (!item) return;

    const limitStr = item.system.limit || "0";
    const match = limitStr.match(/(\d+)/);
    if (!match) return;

    let currentVal = parseInt(match[0], 10);
    currentVal = btn.hasClass("lethal-limit-plus") ? currentVal + 1 : Math.max(0, currentVal - 1);
    const newStr = limitStr.replace(/(\d+)/, currentVal);
    await updateItemAndRefresh(item, { "system.limit": newStr }, btn.closest(".injury-row"));
  });

  html.find(".conditions-tab").off("click", ".treatment-btn").on("click", ".treatment-btn", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const row = btn.closest(".injury-row");
    const item = getRowItem(row);
    if (!item) return;

    if (item.getFlag(MODULE_ID, FLAGS.TREATMENT_STATUS)) {
      ui.notifications.warn(localize("Notifications.TreatmentAlreadyApplied", "Treatment has already been applied. Reset it before choosing another result."));
      return;
    }

    const action = btn.data("action");
    const treatmentData = item.getFlag(MODULE_ID, FLAGS.TREATMENT_DATA) || {};
    const originalTimeStr = String(treatmentData.originalHealingTime ?? item.system.healingTime ?? "0");
    const match = originalTimeStr.match(/(\d+)/);

    if (match) {
      const originalVal = parseInt(match[0], 10);
      let newVal = originalVal;

      if (action === "fail") {
        newVal = originalVal * 2;
        ui.notifications.warn(localize("Notifications.TreatmentFailed", "Treatment of “{name}” failed. Healing time was recalculated from its original value.", { name: escapeHTML(item.name) }));
      } else if (action === "prof") {
        newVal = Math.ceil(originalVal / 2);
        ui.notifications.info(localize("Notifications.TreatmentProfessional", "Injury “{name}” was treated professionally. Healing time was recalculated from its original value.", { name: escapeHTML(item.name) }));
      } else if (action === "normal") {
        ui.notifications.info(localize("Notifications.TreatmentNormal", "Injury “{name}” was treated.", { name: escapeHTML(item.name) }));
      }

      const newTimeStr = originalTimeStr.replace(/(\d+)/, newVal);
      await item.update({
        "system.healingTime": newTimeStr,
        [flagUpdatePath(FLAGS.TREATMENT_STATUS)]: action,
        [flagUpdatePath(FLAGS.TREATMENT_DATA)]: {
          originalHealingTime: originalTimeStr,
          adjustedHealingTime: newTimeStr,
          action
        }
      }, { render: false });
    } else {
      await item.update({
        [flagUpdatePath(FLAGS.TREATMENT_STATUS)]: action,
        [flagUpdatePath(FLAGS.TREATMENT_DATA)]: {
          originalHealingTime: originalTimeStr,
          adjustedHealingTime: originalTimeStr,
          action
        }
      }, { render: false });
    }
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".treatment-reset-btn").on("click", ".treatment-reset-btn", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".injury-row"));
    if (!item) return;
    const treatmentData = item.getFlag(MODULE_ID, FLAGS.TREATMENT_DATA) || {};
    const update = {
      [flagDeletePath(FLAGS.TREATMENT_STATUS)]: null,
      [flagDeletePath(FLAGS.TREATMENT_DATA)]: null
    };
    if (treatmentData.originalHealingTime !== undefined) update["system.healingTime"] = treatmentData.originalHealingTime;
    await updateItemAndRefresh(item, update, $(ev.currentTarget).closest(".injury-row"));
  });

  // Addiction.
  html.find(".conditions-tab").off("change", ".addiction-severity-select").on("change", ".addiction-severity-select", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".special-addiction-row"));
    if (!item) return;

    const state = normalizeAddictionSeverityChange(
      getAddictionState(item),
      parseInt(ev.currentTarget.value, 10)
    );
    const row = $(ev.currentTarget).closest(".special-addiction-row");
    await item.update({ [flagUpdatePath(FLAGS.ADDICTION_STATE)]: state }, { render: false });
    await updateAddictionModifiers(item, state, { render: false });
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".addiction-morning").on("click", ".addiction-morning", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".special-addiction-row"));
    if (!item) return;

    const row = $(ev.currentTarget).closest(".special-addiction-row");
    const result = await performAddictionMorning(app.actor, item, { documentOptions: { render: false } });
    await refreshAfterSpecialItemAction(item, row, result);
  });

  html.find(".conditions-tab").off("click", ".addiction-advance").on("click", ".addiction-advance", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".special-addiction-row"));
    if (!item) return;

    const row = $(ev.currentTarget).closest(".special-addiction-row");
    const result = await advanceAddictionCycle(app.actor, item, { documentOptions: { render: false } });
    await refreshAfterSpecialItemAction(item, row, result);
  });

  html.find(".conditions-tab").off("click", ".addiction-relapse").on("click", ".addiction-relapse", async (ev) => {
    if (!requireEditable()) return;
    const item = getRowItem($(ev.currentTarget).closest(".special-addiction-row"));
    if (!item) return;

    const state = getAddictionState(item);
    state.phase = "down";
    state.die = 12;
    state.daysLeft = 0;

    const content = buildAddictionRelapseMessage(app.actor.name, item.name);
    await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content });

    await item.update({ [flagUpdatePath(FLAGS.ADDICTION_STATE)]: state }, { render: false });
    await updateAddictionModifiers(item, state, { render: false });
    await refreshItemRow(item, $(ev.currentTarget).closest(".special-addiction-row"));
  });

  // Heat.
  html.find(".conditions-tab").off("click", ".heat-plus, .heat-minus").on("click", ".heat-plus, .heat-minus", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const row = btn.closest(".special-heat-row");
    const item = getRowItem(row);
    if (!item) return;

    const currentValue = parseHeatValue(item);
    const delta = btn.hasClass("heat-plus") ? 1 : -1;
    const result = await updateHeatItem(app.actor, item, currentValue + delta, "manual", { render: false });
    syncAttributeDamageInputs(result?.appliedDamage);
    if (result?.changed) {
      const mode = result.value < result.previousValue ? "reduce" : "gain";
      const content = buildHeatChangeMessage(app.actor.name, result, mode);
      await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content });
    }
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".heat-exposure").on("click", ".heat-exposure", async (ev) => {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".special-heat-row");
    const item = getRowItem(row);
    if (!item) return;
    const result = await updateHeatItem(app.actor, item, parseHeatValue(item) + 1, "exposure", { render: false });
    syncAttributeDamageInputs(result?.appliedDamage);
    if (result?.changed) {
      const content = buildHeatChangeMessage(app.actor.name, result, "gain");
      await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content });
    }
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".heat-rest").on("click", ".heat-rest", async (ev) => {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".special-heat-row");
    const item = getRowItem(row);
    if (!item) return;
    const result = await updateHeatItem(app.actor, item, parseHeatValue(item) - 1, "rest", { render: false });
    syncAttributeDamageInputs(result?.appliedDamage);
    if (result?.changed) {
      const content = buildHeatChangeMessage(app.actor.name, result, "reduce");
      await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content });
    }
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".heat-check").on("click", ".heat-check", async (ev) => {
    const row = $(ev.currentTarget).closest(".special-heat-row");
    const item = getRowItem(row);
    if (!item) return;

    const heat = getHeatDefinition();
    const value = parseHeatValue(item);
    const level = getHeatLevel(value);

    // This action only posts a rules summary and does not mutate actor data.
    const content = buildHeatCheckMessage(app.actor.name, value, heat, level);
    await createChatMessage({ speaker: ChatMessage.getSpeaker({ actor: app.actor }), content });
  });

  // Mor.
  html.find(".conditions-tab").off("click", ".mor-item-x-plus").on("click", ".mor-item-x-plus", async (ev) => {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".special-mor-row");
    const item = getRowItem(row);
    if (!item) return;

    let x = parseInt(row.find('.mor-input[data-type="x"]').val(), 10) || 0;
    let y = parseInt(row.find('.mor-input[data-type="y"]').val(), 10) || 0;

    x += 1;
    const diceCount = x + y;
    const roll = await new Roll(`${diceCount}d6`).evaluate();
    const ones = roll.terms[0].results.filter(r => r.result === 1).length;
    const appliedDamage = ones > 0 ? await applyActorAttributeDamage(app.actor, { strength: ones }, { render: false }) : [];
    syncAttributeDamageInputs(appliedDamage);
    const state = { current: x, permanent: y };
    const flavor = buildMorGainMessage(app.actor.name, state, diceCount, ones, appliedDamage);

    await rollToMessage(roll, { speaker: ChatMessage.getSpeaker({ actor: app.actor }), flavor });
    await updateMorItem(item, x, y, { render: false });
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".mor-item-x-minus").on("click", ".mor-item-x-minus", async (ev) => {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".special-mor-row");
    const item = getRowItem(row);
    if (!item) return;

    let x = parseInt(row.find('.mor-input[data-type="x"]').val(), 10) || 0;
    let y = parseInt(row.find('.mor-input[data-type="y"]').val(), 10) || 0;

    if (x <= 0) return ui.notifications.warn(localize("Notifications.NoCurrentMor", "There are no current Mor points to remove."));
    x -= 1;

    const roll = await new Roll("1d6").evaluate();
    const becamePermanent = roll.total === 1;
    if (becamePermanent) y += 1;
    const state = { current: x, permanent: y };
    const flavor = buildMorRemoveMessage(app.actor.name, roll.total, state, becamePermanent);

    await rollToMessage(roll, { speaker: ChatMessage.getSpeaker({ actor: app.actor }), flavor });
    await updateMorItem(item, x, y, { render: false });
    await refreshItemRow(item, row);
  });

  html.find(".conditions-tab").off("click", ".mor-item-y-plus, .mor-item-y-minus").on("click", ".mor-item-y-plus, .mor-item-y-minus", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const row = btn.closest(".special-mor-row");
    const item = getRowItem(row);
    if (!item) return;

    const mor = getMorState(item);
    const x = mor.current;
    let y = mor.permanent;

    if (btn.hasClass("mor-item-y-plus")) y += 1;
    else y = Math.max(0, y - 1);

    await updateMorItem(item, x, y, { render: false });
    await refreshItemRow(item, row);
  });

  // Custom conditions.
  html.find(".conditions-tab").off("click", ".time-plus, .time-minus").on("click", ".time-plus, .time-minus", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    const input = btn.siblings(".condition-time");
    const timeStr = input.val() || "0";
    const match = timeStr.match(/(\d+)/);
    if (!match) return;

    const num = parseInt(match[0], 10) + (btn.hasClass("time-plus") ? 1 : -1);
    const newStr = timeStr.replace(/(\d+)/, Math.max(0, num));
    input.val(newStr);
    await saveCustom();
  });

  html.find(".add-condition").off("click").on("click", async () => {
    if (!requireEditable()) return;
    customConditions.push(makeCustomCondition({}, (customConditions.length + app.actor.items.size + 1) * 10));
    await app.actor.update({ [flagUpdatePath(FLAGS.LIST)]: customConditions }, { render: false });
    await refreshRows();
  });

  html.find(".layout-toggle").off("click").on("click", async (ev) => {
    if (!requireEditable()) return;
    const btn = $(ev.currentTarget);
    layoutColumns = Number(btn.data("columns")) === 2 ? 2 : 1;
    await app.actor.update({ [flagUpdatePath(FLAGS.LAYOUT_COLUMNS)]: layoutColumns }, { render: false });

    const tab = html.find(".conditions-tab");
    tab.removeClass("fblec-columns-1 fblec-columns-2").addClass(`fblec-columns-${layoutColumns}`);
    tab.attr("data-layout-columns", layoutColumns);

    const next = layoutColumns === 2 ? 1 : 2;
    btn.data("columns", next).attr("data-columns", next);
    btn.text(layoutColumns === 2 ? localize("UI.OneColumn", "1 column") : localize("UI.TwoColumns", "2 columns"));
    btn.attr("title", layoutColumns === 2 ? localize("UI.SwitchToOneColumn", "Switch STAT to one column") : localize("UI.SwitchToTwoColumns", "Switch STAT to two columns"));
  });

  html.find(".conditions-tab").off("click", ".delete-condition:not(.delete-injury)").on("click", ".delete-condition:not(.delete-injury)", async (ev) => {
    if (!requireEditable()) return;
    const row = $(ev.currentTarget).closest(".condition-row");
    const id = String(row.data("condition-id") || "");
    const conditionName = customConditions.find(condition => condition.id === id)?.name || row.find(".condition-name").val() || row.find(".condition-name-static").text() || localize("Delete.ConditionFallback", "condition");
    if (!(await confirmStatDelete(conditionName, "condition"))) return;
    customConditions = customConditions.filter(condition => condition.id !== id);
    row.remove();
    await app.actor.update({ [flagUpdatePath(FLAGS.LIST)]: customConditions }, { render: false });
  });

  html.find(".conditions-tab").off("change", ".condition-name, .condition-time, .condition-notes, .condition-desc-input")
    .on("change", ".condition-name, .condition-time, .condition-notes, .condition-desc-input", saveCustom);

  let pointerDrag = null;

  function getSortableRowFromPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const row = $(element).closest(".condition-row:not(.arc-row), .injury-row:not(.arc-row)")[0];
    const list = html.find(".conditions-rows")[0];
    if (!row || !list?.contains(row) || row === pointerDrag?.row) return null;
    return row;
  }

  async function finishPointerDrag(save = true) {
    if (!pointerDrag) return;

    const row = pointerDrag.row;
    $(document).off("mousemove.fblecSort mouseup.fblecSort");
    $(row).removeClass("fblec-dragging");
    pointerDrag = null;

    if (save && editable) await persistRowOrder();
  }

  html.find(".conditions-tab").off("mousedown", ".fblec-drag-handle").on("mousedown", ".fblec-drag-handle", (ev) => {
    if (!editable || ev.button !== 0) return;

    const row = $(ev.currentTarget).closest(".condition-row:not(.arc-row), .injury-row:not(.arc-row)")[0];
    if (!row) return;

    ev.preventDefault();
    ev.stopPropagation();

    pointerDrag = { row, startX: ev.clientX, startY: ev.clientY, active: false };

    $(document).off("mousemove.fblecSort mouseup.fblecSort");
    $(document).on("mousemove.fblecSort", (moveEv) => {
      if (!pointerDrag) return;

      const distance = Math.abs(moveEv.clientX - pointerDrag.startX) + Math.abs(moveEv.clientY - pointerDrag.startY);
      if (!pointerDrag.active && distance < 4) return;
      if (!pointerDrag.active) {
        pointerDrag.active = true;
        $(pointerDrag.row).addClass("fblec-dragging");
      }

      const target = getSortableRowFromPoint(moveEv.clientX, moveEv.clientY);
      if (!target) return;

      const rect = target.getBoundingClientRect();
      const twoColumns = html.find(".conditions-tab").hasClass("fblec-columns-2");
      const before = twoColumns
        ? (moveEv.clientY < rect.top + rect.height / 2 || (Math.abs(moveEv.clientY - (rect.top + rect.height / 2)) < 8 && moveEv.clientX < rect.left + rect.width / 2))
        : moveEv.clientY < rect.top + rect.height / 2;

      if (before) target.before(pointerDrag.row);
      else target.after(pointerDrag.row);
    });

    $(document).on("mouseup.fblecSort", async () => {
      const shouldSave = Boolean(pointerDrag?.active);
      await finishPointerDrag(shouldSave);
    });
  });


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
