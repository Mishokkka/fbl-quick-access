import { SYSTEM_ID } from "./constants.js";
import {
  findActorSheetRoot,
  findCombatTab as adapterFindCombatTab,
  findGearTab as adapterFindGearTab,
  findMainTab as adapterFindMainTab,
  findTalentTab as adapterFindTalentTab
} from "./sheet-adapter/forbidden-lands-v1.js";

export function getActorFromApp(app) {
  const candidate = app?.actor ?? app?.document ?? app?.object;
  return candidate?.documentName === "Actor" ? candidate : null;
}

export function getRootElement(htmlOrElement) {
  return findActorSheetRoot(htmlOrElement);
}

export function findGearTab(root) {
  return adapterFindGearTab(root);
}

export function findCombatTab(root) {
  return adapterFindCombatTab(root);
}

export function findTalentTab(root) {
  return adapterFindTalentTab(root);
}

export function findMainTab(root) {
  return adapterFindMainTab(root);
}


export function isForbiddenLandsCharacter(actor) {
  return game.system?.id === SYSTEM_ID && actor?.type === "character";
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? 0);
  if (Number.isInteger(number)) return String(number);
  return String(Math.round(number * 10) / 10);
}

export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function localizeOrFallback(key, fallback) {
  const localized = game.i18n.localize(key);
  return localized && localized !== key ? localized : fallback;
}

export function humanizeKey(value) {
  const text = String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();

  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function decodeHtmlEntities(value) {
  const text = String(value ?? "");
  if (!/[&][a-zA-Z#0-9]+;/.test(text)) return text;

  const element = document.createElement("textarea");
  element.innerHTML = text;
  return element.value;
}

export function stripHtml(text) {
  const element = document.createElement("div");
  element.innerHTML = String(text ?? "");
  return element.textContent ?? element.innerText ?? "";
}

export function compactPlainText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return extractText(value.value)
      || extractText(value.description)
      || extractText(value.text)
      || extractText(value.content);
  }
  return String(value).trim();
}

const SCHEDULED_SHEET_REFRESHES = new WeakMap();

export function scheduleSheetRefresh(app) {
  if (!app || typeof app.render !== "function") return;

  const existing = SCHEDULED_SHEET_REFRESHES.get(app);
  if (existing) window.clearTimeout(existing);

  const timeout = window.setTimeout(() => {
    SCHEDULED_SHEET_REFRESHES.delete(app);
    if (app.rendered === false || (Number.isFinite(Number(app.state)) && Number(app.state) < 0)) return;
    app.render(false);
  }, 0);

  SCHEDULED_SHEET_REFRESHES.set(app, timeout);
}

export function rerenderSheet(app) {
  scheduleSheetRefresh(app);
}
