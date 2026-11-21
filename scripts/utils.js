import { SYSTEM_ID } from "./constants.js";
import { readNumericValue } from "./document-writes.js";

export function getActorFromApp(app) {
  const candidate = app?.actor ?? app?.document ?? app?.object;
  return candidate?.documentName === "Actor" ? candidate : null;
}

export function actorKey(actor) {
  return String(actor?.uuid ?? actor?.id ?? actor ?? "unknown");
}

export function makeEntryId(prefix = "entry") {
  const random = globalThis.crypto?.randomUUID?.()
    ?? globalThis.foundry?.utils?.randomID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function isForbiddenLandsCharacter(actor) {
  return game.system?.id === SYSTEM_ID && actor?.type === "character";
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = readNumericValue(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function formatNumber(value) {
  const number = readNumericValue(value);
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

const BASIC_HTML_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0"
});

export function decodeHtmlEntities(value) {
  const text = String(value ?? "");
  if (!/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/.test(text)) return text;

  if (typeof globalThis.DOMParser === "function") {
    const doc = new globalThis.DOMParser().parseFromString(
      `<textarea>${text.replace(/<\/textarea/gi, "&lt;/textarea")}</textarea>`,
      "text/html"
    );
    const decoded = doc.querySelector("textarea")?.value;
    if (typeof decoded === "string") return decoded;
  }

  if (typeof globalThis.document?.createElement === "function") {
    const template = globalThis.document.createElement("template");
    const textarea = globalThis.document.createElement("textarea");
    if (template?.content && textarea) {
      textarea.innerHTML = text;
      return textarea.value;
    }
  }

  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, named) => {
    if (dec) {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return BASIC_HTML_ENTITIES[named.toLowerCase()] ?? match;
  });
}

/**
 * Strip HTML markup safely without executing inline handlers or fetching subresources.
 * Uses an inert DOMParser / <template> document when available.
 */
export function stripHtml(text) {
  const raw = String(text ?? "");
  if (!raw) return "";

  if (typeof globalThis.DOMParser === "function") {
    const doc = new globalThis.DOMParser().parseFromString(raw, "text/html");
    for (const node of doc.querySelectorAll("script, style, noscript")) node.remove();
    return doc.body?.textContent ?? "";
  }

  if (typeof globalThis.document?.createElement === "function") {
    const template = globalThis.document.createElement("template");
    if (template?.content) {
      template.innerHTML = raw;
      for (const node of template.content.querySelectorAll?.("script, style, noscript") ?? []) node.remove();
      return template.content.textContent ?? "";
    }
  }

  return raw
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "");
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
