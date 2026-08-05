import { CONDITIONS_TAB_ID, FLAGS, MODULE_ID, TEMPLATE_PATHS } from "../constants.js";
import { escapeHTML, isPermanentTime, localize, normalizeConditionName } from "../utils.js";
import { getWashDisplayName, isWashCondition } from "../features/wash.js";
import {
  buildHeatDots,
  getAddictionState,
  getHeatDefinition,
  getHeatLevel,
  getMorState,
  getTreatmentLabel,
  isAddictionCondition,
  isHeatCondition,
  isMorCondition,
  parseHeatValue
} from "../features/special-counters.js";

function toUpperTitle(name) {
  return String(name || "").toUpperCase();
}

function isArcName(name) {
  const value = String(name || "").toUpperCase();
  return value.includes("[АРКА]") || value.includes("[ARC]");
}

function buildLethalHtml(item, editable) {
  const sys = item.system || {};
  if (sys.lethal !== "yes") return "";

  const limit = escapeHTML(sys.limit || "0");
  if (!editable) {
    return `
      <div class="injury-lethal-wrapper">
        <div class="injury-lethal">${escapeHTML(localize("Injury.Lethal", "LETHAL"))}:</div>
        <input class="lethal-limit-input" value="${limit}" readonly>
        <span class="lethal-limit-caption">${escapeHTML(localize("Injury.RemainingShort", "left"))}</span>
      </div>`;
  }

  const itemId = escapeHTML(item.id);
  return `
    <div class="injury-lethal-wrapper">
      <div class="injury-lethal">${escapeHTML(localize("Injury.Lethal", "LETHAL"))}:</div>
      <button class="lethal-limit-btn lethal-limit-minus" data-item-id="${itemId}">-</button>
      <input class="lethal-limit-input" value="${limit}" readonly>
      <button class="lethal-limit-btn lethal-limit-plus" data-item-id="${itemId}">+</button>
      <span class="lethal-limit-caption">${escapeHTML(localize("Injury.RemainingShort", "left"))}</span>
      <button class="toggle-lethal-btn" data-item-id="${itemId}" title="${escapeHTML(localize("Injury.StabilizeTitle", "Stabilize injury"))}">
        <i class="fas fa-heartbeat"></i> ${escapeHTML(localize("Injury.Stabilize", "Stabilize"))}
      </button>
    </div>`;
}

function buildTimeControlsHtml(item, editable) {
  const timeStr = String(item.system?.healingTime || "");
  const permanent = isPermanentTime(timeStr);
  const permanentClass = permanent ? "is-permanent" : "";
  const value = escapeHTML(timeStr || "0");

  if (permanent || !editable) {
    return `<input type="text" value="${value}" class="healing-time-input ${permanentClass}" readonly>`;
  }

  return `<span class="injury-healing-label">${escapeHTML(localize("Injury.Remaining", "Remaining"))}:</span>
          <button class="heal-btn heal-minus">-</button>
          <input type="text" value="${value}" class="healing-time-input" readonly>
          <button class="heal-btn heal-plus">+</button>`;
}

function isTreatmentEligible(item, editable, isNormalInjury) {
  const sys = item.system || {};
  const timeStr = String(sys.healingTime || "");
  const permanent = isPermanentTime(timeStr);
  return Boolean(editable && isNormalInjury && sys.lethal !== "yes" && !permanent);
}

function buildTreatmentBadgeHtml(item, editable, isNormalInjury) {
  if (!isTreatmentEligible(item, editable, isNormalInjury)) return "";

  const treatmentStatus = item.getFlag(MODULE_ID, FLAGS.TREATMENT_STATUS);
  if (!treatmentStatus || treatmentStatus === "none") return "";

  const label = escapeHTML(getTreatmentLabel(treatmentStatus));
  return `
    <div class="treatment-badge" title="${escapeHTML(localize("Treatment.Label", "Treatment"))}: ${label}">
      <i class="fas fa-plus-square"></i>
      <span>${label}</span>
      <button class="treatment-reset-btn" title="${escapeHTML(localize("Treatment.ResetTitle", "Reset treatment and restore original healing time"))}">↺</button>
    </div>`;
}

function buildTreatmentHtml(item, editable, isNormalInjury) {
  if (!isTreatmentEligible(item, editable, isNormalInjury)) return "";
  if (item.getFlag(MODULE_ID, FLAGS.TREATMENT_STATUS)) return "";

  return `
    <div class="treatment-wrapper">
      <span class="treatment-label">${escapeHTML(localize("Treatment.Label", "Treatment"))}:</span>
      <button class="treatment-btn" data-action="fail">${escapeHTML(localize("Treatment.Fail", "Failed"))}</button>
      <button class="treatment-btn" data-action="normal">${escapeHTML(localize("Treatment.Normal", "Treated"))}</button>
      <button class="treatment-btn" data-action="prof">${escapeHTML(localize("Treatment.Professional", "Professional"))}</button>
      <button class="treatment-btn" data-action="none">${escapeHTML(localize("Treatment.NotRequired", "Not required"))}</button>
    </div>`;
}

async function enrichEffect(item) {
  return TextEditor.enrichHTML(item.system?.effect || "", {
    async: true,
    rollData: item.getRollData?.() || {}
  });
}

async function renderCustomCondition(condition, editable) {
  const rawName = condition.name || "";
  const isArc = isArcName(rawName);
  const time = String(condition.time || "0");

  if (isArc) {
    return renderTemplate(TEMPLATE_PATHS.customArc, {
      id: condition.id,
      order: Number(condition.order || 0),
      title: toUpperTitle(rawName),
      desc: condition.desc || "",
      editable
    });
  }

  return renderTemplate(TEMPLATE_PATHS.customCondition, {
    id: condition.id,
    order: Number(condition.order || 0),
    name: rawName,
    time,
    notes: condition.notes || "",
    desc: condition.desc || "",
    permanentClass: isPermanentTime(time) ? "is-permanent" : "",
    showTimeButtons: !isPermanentTime(time),
    editable
  });
}

function getAddictionStatusText(state) {
  if (state.phase === "down" || state.phase === "up") return `d${state.die}`;
  if (state.phase === "flat") return localize("Addiction.DaysShort", "{days} d.", { days: state.daysLeft });
  return "";
}

function getAddictionStatusTitle(state) {
  if (state.phase === "down") return localize("Addiction.PhaseDown", "Decline");
  if (state.phase === "flat") return localize("Addiction.PhaseFlat", "Withdrawal");
  if (state.phase === "up") return localize("Addiction.PhaseUp", "Recovery");
  return localize("Addiction.Stage", "Current stage");
}

async function renderInjury(item, editable) {
  const name = item.name || "";
  const effect = await enrichEffect(item);
  const common = {
    itemId: item.id,
    order: Number(item.getFlag(MODULE_ID, FLAGS.ORDER) ?? item.sort ?? 0),
    name,
    img: item.img || "",
    effect,
    editable
  };

  const isArc = isArcName(name);
  if (isArc) {
    return renderTemplate(TEMPLATE_PATHS.injuryArc, {
      ...common,
      title: toUpperTitle(name),
      lethalHtml: buildLethalHtml(item, editable)
    });
  }

  if (isHeatCondition(item)) {
    const heat = getHeatDefinition();
    const value = parseHeatValue(item);
    const level = getHeatLevel(value);
    return renderTemplate(TEMPLATE_PATHS.heat, {
      ...common,
      value,
      max: heat.max,
      dots: buildHeatDots(value),
      levelLabel: level.label,
      levelSummary: level.summary,
      levelConsequence: level.consequence
    });
  }

  if (isMorCondition(item)) {
    const mor = getMorState(item);
    return renderTemplate(TEMPLATE_PATHS.mor, {
      ...common,
      current: mor.current,
      permanent: mor.permanent
    });
  }

  if (isAddictionCondition(item)) {
    const state = getAddictionState(item);
    return renderTemplate(TEMPLATE_PATHS.addiction, {
      ...common,
      statusText: getAddictionStatusText(state),
      statusTitle: getAddictionStatusTitle(state),
      severityOptions: [
        { value: 1, label: localize("Addiction.SeverityLight", "Light"), selected: state.severity === 1 },
        { value: 5, label: localize("Addiction.SeverityMedium", "Medium"), selected: state.severity === 5 },
        { value: 10, label: localize("Addiction.SeveritySevere", "Severe"), selected: state.severity === 10 }
      ]
    });
  }

  const isWash = isWashCondition(item);
  const isNormalInjury = !isArc && !isMorCondition(item) && !isAddictionCondition(item) && !isHeatCondition(item) && !isWash;
  return renderTemplate(TEMPLATE_PATHS.injury, {
    ...common,
    name: isWash ? getWashDisplayName(name) : name,
    notes: item.getFlag(MODULE_ID, FLAGS.NOTES) || "",
    timeControlsHtml: buildTimeControlsHtml(item, editable),
    lethalHtml: buildLethalHtml(item, editable),
    treatmentBadgeHtml: buildTreatmentBadgeHtml(item, editable, isNormalInjury),
    treatmentHtml: buildTreatmentHtml(item, editable, isNormalInjury)
  });
}

export async function renderConditionItemRow(item, editable) {
  return renderInjury(item, editable);
}

export async function renderConditionsRows({ customConditions, injuries, editable }) {
  const arcRows = [];
  const normalRows = [];

  for (let index = 0; index < customConditions.length; index += 1) {
    const condition = customConditions[index];
    const rendered = await renderCustomCondition(condition, editable);
    const entry = { html: rendered, order: Number(condition.order ?? index * 10) };
    if (isArcName(condition.name)) arcRows.push(entry);
    else normalRows.push(entry);
  }

  for (let index = 0; index < injuries.length; index += 1) {
    const injury = injuries[index];
    const rendered = await renderInjury(injury, editable);
    const explicitOrder = injury.getFlag(MODULE_ID, FLAGS.ORDER);
    const fallbackOrder = Number(injury.sort ?? 10000 + index * 10);
    const entry = { html: rendered, order: Number(explicitOrder ?? fallbackOrder) };
    if (isArcName(injury.name)) arcRows.push(entry);
    else normalRows.push(entry);
  }

  const byOrder = (a, b) => a.order - b.order;
  return arcRows.sort(byOrder).map(row => row.html).join("") + normalRows.sort(byOrder).map(row => row.html).join("");
}

export async function renderStatTab({ tabGroup, rowsHtml, providerSectionsHtml = "", editable, layoutColumns = 1 }) {
  const columns = Number(layoutColumns) === 2 ? 2 : 1;
  return renderTemplate(TEMPLATE_PATHS.statTab, {
    tabGroup,
    tabId: CONDITIONS_TAB_ID,
    rowsHtml,
    providerSectionsHtml,
    editable,
    layoutColumns: columns,
    nextLayoutColumns: columns === 2 ? 1 : 2,
    layoutButtonLabel: columns === 2 ? localize("UI.OneColumn", "1 column") : localize("UI.TwoColumns", "2 columns"),
    layoutButtonTitle: columns === 2 ? localize("UI.SwitchToOneColumn", "Switch STAT to one column") : localize("UI.SwitchToTwoColumns", "Switch STAT to two columns")
  });
}
