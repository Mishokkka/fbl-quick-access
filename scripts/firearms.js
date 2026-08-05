import { MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { escapeHtml, humanizeKey } from "./utils.js";

const FL_FIREARMS_ID = "fl-firearms";

/**
 * Optional integration point for the companion firearms module.
 *
 * This module deliberately treats fl-firearms as the source of truth:
 * no flag reads, no item-sheet HTML parsing, and no local copy of the firearm
 * feature catalog. If fl-firearms is missing or inactive, this file returns an
 * empty section and the regular item tooltip remains unchanged.
 */
export function buildFirearmTooltipSection(item) {
  const data = getFirearmTooltipData(item);
  if (!data) return "";

  const fields = buildFirearmFields(data);
  const features = Array.isArray(data.features) ? data.features : [];

  return `
    <section class="fblqa-item-tooltip-section fblqa-firearm-tooltip-section">
      ${fields.length ? `<div class="fblqa-firearm-fields">${fields.map(renderFirearmField).join("")}</div>` : ""}
      ${features.length ? `<div class="fblqa-firearm-features">${features.map(renderFirearmFeature).join("")}</div>` : ""}
    </section>
  `;
}

function getFirearmTooltipData(item) {
  const api = getFirearmsApi();
  if (!api) return null;

  try {
    const data = api.getFirearmTooltipData(item);
    return data?.isFirearm ? data : null;
  } catch (error) {
    console.warn(`${MODULE_ID} | fl-firearms tooltip integration failed`, error);
    return null;
  }
}

function getFirearmsApi() {
  const module = game.modules?.get?.(FL_FIREARMS_ID);
  if (!module?.active) return null;

  const api = module.api;
  return typeof api?.getFirearmTooltipData === "function" ? api : null;
}

function buildFirearmFields(data) {
  const fields = [];

  addFirearmField(fields, qaLocalize("Firearms.Type", "Тип"), formatFirearmType(data.firearmType));

  // MAG reload uses the magazine capacity field, so showing a separate
  // "Перезарядка MAG" badge only repeats information without adding meaning.
  if (!isMagazineReload(data.reloadType)) {
    addFirearmField(fields, qaLocalize("Firearms.Reload", "Перезарядка"), formatReload(data));
  }

  addFirearmField(fields, qaLocalize("Firearms.Magazine", "Магазин"), data.magCapacity);
  addFirearmField(fields, qaLocalize("Firearms.AP", "БП"), formatAp(data));

  return fields;
}

function addFirearmField(fields, label, value) {
  const formatted = formatTooltipText(value);
  if (!formatted) return;
  fields.push({ label, value: formatted });
}

function renderFirearmField(field) {
  return `
    <div class="fblqa-firearm-field">
      <span class="fblqa-firearm-field-label">${escapeHtml(field.label)}</span>
      <span class="fblqa-firearm-field-value">${escapeHtml(field.value)}</span>
    </div>
  `;
}

function renderFirearmFeature(feature) {
  if (!feature || typeof feature !== "object") return "";

  const label = formatTooltipText(feature.label ?? feature.key);
  if (!label) return "";

  const value = feature.hasInput ? formatTooltipText(feature.value) : "";
  const title = value
    ? `${escapeHtml(label)} <span class="fblqa-firearm-feature-value">${escapeHtml(value)}</span>`
    : escapeHtml(label);

  // fl-firearms may provide rich descriptions, but this tooltip intentionally
  // keeps firearm features as compact player-facing labels. The descriptions
  // remain owned by fl-firearms and are not duplicated here.
  return `
    <div class="fblqa-firearm-feature">
      <div class="fblqa-firearm-feature-title">${title}</div>
    </div>
  `;
}

function formatReload(data) {
  const type = formatPlain(data.reloadType);
  const value = formatTooltipText(data.reloadValue);

  if (type && value) return `${type} ${value}`;
  return type || value;
}

function formatAp(data) {
  const value = formatTooltipText(data.apValue);
  if (!value) return "";

  const op = formatTooltipText(data.apOp);
  return op ? `${op} ${value}` : value;
}

function formatFirearmType(value) {
  const text = formatTooltipText(value);
  if (!text) return "";

  const normalized = text.trim().toLowerCase();
  const labels = {
    regular: qaLocalize("Firearms.Regular", "Обычный"),
    artifact: qaLocalize("Firearms.Artifact", "Артефакт")
  };

  return labels[normalized] ?? humanizeKey(text);
}

function formatPlain(value) {
  const text = formatTooltipText(value);
  return text ? humanizeKey(text) : "";
}

function isMagazineReload(value) {
  return formatTooltipText(value).trim().toLowerCase() === "mag";
}

function formatTooltipText(value) {
  if (value === null || value === undefined || value === false || value === "") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  if (Array.isArray(value)) return value.map(formatTooltipText).filter(Boolean).join(", ");
  if (typeof value === "boolean") return value ? qaLocalize("Common.Yes", "Да") : "";
  return String(value).trim();
}

