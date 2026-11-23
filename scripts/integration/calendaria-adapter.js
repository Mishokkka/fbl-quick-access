const MODULE_ID = "calendaria";
let ready = false;
let readyApi = null;

export function markCalendariaReady(data) {
  ready = true;
  readyApi = data?.api ?? globalThis.CALENDARIA?.api ?? readyApi;
}

export function hasCalendariaReadyFired() {
  return ready;
}

export function isCalendariaModuleActive() {
  const module = globalThis.game?.modules?.get?.(MODULE_ID);
  return module ? module.active !== false : Boolean(globalThis.CALENDARIA?.api || readyApi);
}

export function getCalendariaApi() {
  if (!isCalendariaModuleActive()) return null;
  return globalThis.CALENDARIA?.api ?? readyApi ?? game.modules?.get?.(MODULE_ID)?.api ?? null;
}

/** The dayChange hook uses zero-based month and day. The year is already public. */
export function calendariaHookComponentToPublicDate(components) {
  const month = calendarNumber(components?.month);
  const day = calendarNumber(components?.dayOfMonth ?? components?.day);
  return normalizeCalendariaDate({ year: components?.year, month: month + 1, day: day + 1 });
}

export function normalizeCalendariaDate(date) {
  const year = calendarNumber(date?.year);
  const month = calendarNumber(date?.month);
  const day = calendarNumber(date?.day);
  if (![year, month, day].every(Number.isSafeInteger) || month < 1 || day < 1) return null;
  return { year, month, day };
}

export function calendariaDateKey(date) {
  const value = normalizeCalendariaDate(date);
  return value ? `${value.year}:${value.month}:${value.day}` : "invalid-date";
}

export function sameCalendariaDay(left, right) {
  const key = calendariaDateKey(left);
  return key !== "invalid-date" && key === calendariaDateKey(right);
}

export function formatCalendariaDate(date) {
  const value = normalizeCalendariaDate(date);
  return value ? `${value.day}.${value.month}.${value.year}` : "—";
}

export function getCalendariaContext(dateOverride = null) {
  const api = getCalendariaApi();
  try {
    const calendar = api?.getActiveCalendar?.();
    const calendarId = getCalendarId(calendar);
    const date = normalizeCalendariaDate(dateOverride ?? api?.getCurrentDateTime?.());
    if (!calendarId || !date) return null;
    return { api, calendar, calendarId, date };
  } catch (_error) {
    return null;
  }
}

export function getCalendariaQuarterInfo() {
  const api = getCalendariaApi();
  try {
    const dateTime = api?.getCurrentDateTime?.();
    const date = normalizeCalendariaDate(dateTime);
    if (!date) return null;
    const calendar = api.getActiveCalendar?.();
    const calendarId = getCalendarId(calendar);
    const hours = positiveClockUnit(calendar?.days?.hoursPerDay, 24);
    const minutes = positiveClockUnit(calendar?.days?.minutesPerHour, 60);
    const seconds = positiveClockUnit(calendar?.days?.secondsPerMinute, 60);
    const time = (calendarNumber(dateTime.hour) || 0) + (calendarNumber(dateTime.minute) || 0) / minutes
      + (calendarNumber(dateTime.second) || 0) / (minutes * seconds);
    const quarterIndex = Math.max(0, Math.min(3, Math.floor(time * 4 / hours)));
    const suffix = `${calendariaDateKey(date)}:q${quarterIndex}`;
    const legacyKey = `calendaria:${suffix}`;
    return { key: calendarId ? `calendaria:${calendarId}:${suffix}` : legacyKey, legacyKey, quarterIndex, dateTime,
      dateLabel: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` };
  } catch (_error) {
    return null;
  }
}

function getCalendarId(calendar) {
  return String(calendar?.metadata?.id ?? calendar?.id ?? "").trim();
}

function calendarNumber(value) {
  if (typeof value === "number" || (typeof value === "string" && value.trim())) return Number(value);
  return NaN;
}

function positiveClockUnit(value, fallback) {
  const number = calendarNumber(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
