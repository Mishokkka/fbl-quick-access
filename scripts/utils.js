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

export function actorKey(actor) {
  const key = String(actor?.uuid ?? actor?.id ?? actor ?? "unknown");
  return /^Actor\.[^.]+$/.test(key) ? key.slice(6) : key;
}

export function makeEntryId(prefix = "entry") {
  const random = globalThis.crypto?.randomUUID?.()
    ?? globalThis.foundry?.utils?.randomID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
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

export function readNumericValue(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
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
  const localized = globalThis.game?.i18n?.localize?.(key);
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

const BASIC_HTML_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" });

export function decodeHtmlEntities(value) {
  const text = String(value ?? "");
  if (!/&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i.test(text)) return text;

  const textarea = globalThis.document?.createElement?.("textarea");
  if (typeof textarea?.value === "string") {
    textarea.innerHTML = text;
    return textarea.value;
  }

  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, named) => {
    if (named) return Object.hasOwn(BASIC_HTML_ENTITIES, named.toLowerCase()) ? BASIC_HTML_ENTITIES[named.toLowerCase()] : match;
    const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function stripHtml(text) {
  const raw = String(text ?? "");
  if (!raw) return "";

  const template = globalThis.document?.createElement?.("template");
  if (template?.content) {
    template.innerHTML = raw;
    for (const node of template.content.querySelectorAll?.("script, style, noscript") ?? []) node.remove();
    return template.content.textContent ?? "";
  }
  return decodeHtmlEntities(raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, ""));
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
