/**
 * Unified Calendaria integration adapter shared across State Progression,
 * Rest quarter-day tracking, and Addiction calendar day keys.
 */

let calendariaReadySeen = false;
let calendariaReadyApi = null;
let readyHookRegistered = false;

export function registerCalendariaReadyHook(callback = null) {
  if (!readyHookRegistered && globalThis.Hooks?.on) {
    readyHookRegistered = true;
    globalThis.Hooks.on("calendaria.ready", (data) => {
      markCalendariaReady(data);
    });
  }
  if (typeof callback === "function" && globalThis.Hooks?.on) {
    globalThis.Hooks.on("calendaria.ready", (data) => {
      markCalendariaReady(data);
      void callback(data);
    });
  }
}

export function markCalendariaReady(data = null) {
  calendariaReadySeen = true;
  calendariaReadyApi = data?.api ?? globalThis.CALENDARIA?.api ?? calendariaReadyApi;
}

export function hasCalendariaReadyFired() {
  return calendariaReadySeen;
}

export function isCalendariaModuleActive() {
  const mod = globalThis.game?.modules?.get?.("calendaria");
  if (mod) return Boolean(mod.active);
  return false;
}

export function getCalendariaApi({ requireActiveModule = true } = {}) {
  const mod = globalThis.game?.modules?.get?.("calendaria");
  if (requireActiveModule) {
    if (!mod?.active) return null;
  } else if (mod && !mod.active) {
    return null;
  }
  return globalThis.CALENDARIA?.api ?? calendariaReadyApi ?? mod?.api ?? null;
}

/** Calendaria's dayChange payload uses internal 0-indexed month/day fields. */
export function calendariaHookComponentToPublicDate(components) {
  if (!components || typeof components !== "object") return null;
  const year = Number(components.year);
  const month = Number(components.month);
  const dayOfMonth = Number(components.dayOfMonth ?? components.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(dayOfMonth)) return null;
  return {
    year,
    month: month + 1,
    day: dayOfMonth + 1
  };
}

export function normalizeCalendariaDate(date) {
  if (!date || typeof date !== "object") return null;
  const year = Number(date.year);
  const month = Number(date.month);
  const day = Number(date.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || day < 1) return null;
  return { year, month, day };
}

export function calendariaDateKey(date) {
  const normalized = normalizeCalendariaDate(date);
  if (!normalized) return "invalid-date";
  return `${normalized.year}:${normalized.month}:${normalized.day}`;
}

export function sameCalendariaDay(a, b) {
  const left = normalizeCalendariaDate(a);
  const right = normalizeCalendariaDate(b);
  return Boolean(left && right && left.year === right.year && left.month === right.month && left.day === right.day);
}

export function formatCalendariaDate(date) {
  const value = normalizeCalendariaDate(date);
  if (!value) return "—";
  return `${value.day}.${value.month}.${value.year}`;
}

export function getCalendariaContext(dateOverride = null) {
  const api = getCalendariaApi({ requireActiveModule: true });
  if (!api?.getCurrentDateTime || !api?.getActiveCalendar || !api?.daysBetween || !api?.addDays) return null;

  try {
    const calendar = api.getActiveCalendar();
    const calendarId = String(calendar?.metadata?.id ?? calendar?.id ?? calendar?.name ?? "").trim();
    const date = normalizeCalendariaDate(dateOverride ?? api.getCurrentDateTime());
    if (!calendarId || !date) return null;
    return { api, calendar, calendarId, date };
  } catch (_error) {
    return null;
  }
}

export function getCalendariaQuarterInfo() {
  const api = getCalendariaApi({ requireActiveModule: false });
  if (!api?.getCurrentDateTime) return null;

  try {
    const dateTime = api.getCurrentDateTime();
    if (!dateTime || typeof dateTime !== "object") return null;

    const year = Number(dateTime.year);
    const month = Number(dateTime.month);
    const day = Number(dateTime.day);
    const hour = Number(dateTime.hour);
    if (![year, month, day, hour].every(Number.isFinite)) return null;

    const calendar = api.getActiveCalendar?.();
    const calendarId = String(calendar?.metadata?.id ?? calendar?.id ?? "").trim();
    const hoursPerDay = Number(calendar?.days?.hoursPerDay) || 24;
    const quarterHours = Math.max(1, hoursPerDay / 4);
    const quarterIndex = Math.max(0, Math.min(3, Math.floor(hour / quarterHours)));
    const dayPrefix = calendarId
      ? `calendaria:${calendarId}:${year}:${month}:${day}`
      : `calendaria:${year}:${month}:${day}`;

    return {
      key: `${dayPrefix}:q${quarterIndex}`,
      quarterIndex,
      dateLabel: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    };
  } catch (_error) {
    return null;
  }
}
