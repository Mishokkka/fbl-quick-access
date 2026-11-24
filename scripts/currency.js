import { CURRENCIES } from "./constants.js";
import { getActorCurrencyPath, getActorCurrencyValue, getProperty } from "./actor-data.js";
import { qaLocalize } from "./i18n.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export function getCurrencyValue(actor, key) {
  return getActorCurrencyValue(actor, key);
}

export function readCurrencyBalances(actor) {
  return Object.fromEntries(CURRENCIES.map(({ key }) => {
    const raw = getProperty(actor, getActorCurrencyPath(actor, key)) ?? 0;
    const value = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid ${key} balance`);
    return [key, value];
  }));
}

export function currencyError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function writeCurrencyUpdate(actor, update) {
  const socket = globalThis.game?.socket;
  if (socket?.connected === false) throw currencyError("socket-unavailable", "Foundry socket is disconnected");
  const sourceBefore = actor._source ?? actor;
  const expected = Object.entries(update).map(([path, value]) => ({ path, value, before: getProperty(sourceBefore, path) }));
  const unknownOutcome = () => currencyError("outcome-unknown", "Currency update outcome is unknown");
  let onDisconnect;
  const disconnected = new Promise((_resolve, reject) => { onDisconnect = () => reject(unknownOutcome()); });
  const canWatch = typeof socket?.on === "function" && typeof socket?.off === "function";
  if (canWatch) socket.on("disconnect", onDisconnect);
  try {
    const writing = actor.update(update);
    await Promise.race([writing, disconnected]);
  } catch (error) {
    if (socket?.connected === false || ["timeout", "ETIMEDOUT"].includes(error?.code) || error?.name === "TimeoutError") {
      throw unknownOutcome();
    }
    throw error;
  } finally {
    if (canWatch) socket.off("disconnect", onDisconnect);
  }

  const sourceAfter = actor._source ?? actor;
  const actual = expected.map(entry => ({ ...entry, after: getProperty(sourceAfter, entry.path) }));
  if (actual.some(({ value, after }) => after !== value)) {
    if (actual.some(({ before, after }) => after !== before)) throw unknownOutcome();
    throw currencyError("write-not-persisted", "Currency update was not persisted");
  }
}

export function getCurrencyAbbreviation(currency) {
  const fallback = currency?.abbrFallback ?? currency?.key ?? "";
  if (!currency?.abbrKey) return fallback;
  return qaLocalize(currency.abbrKey, fallback);
}

export function parseCurrencyExpression(rawValue) {
  const text = String(rawValue ?? "").replace(/\s+/g, "");

  if (!text) return { ok: false, value: 0, relative: false };
  if (!/^[+\-]?\d+(?:[+\-]\d+)*$/.test(text)) {
    return { ok: false, value: 0, relative: false };
  }

  const tokens = text.match(/[+\-]?\d+/g);
  if (!tokens?.length) return { ok: false, value: 0, relative: false };

  const relative = /^[+\-]/.test(text);
  try {
    const value = tokens.reduce((sum, token) => sum + BigInt(token), 0n);
    if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
      return { ok: false, value: 0, relative, reason: "unsafe-integer" };
    }
    return { ok: true, value: Number(value), relative };
  } catch (_error) {
    return { ok: false, value: 0, relative };
  }
}

export function getWalletCopperTotal(actor) {
  let total = 0n;
  for (const currency of CURRENCIES) {
    const value = getCurrencyValue(actor, currency.key);
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value))) continue;
    total += BigInt(Math.trunc(value)) * BigInt(currency.unit);
  }

  if (total > MAX_SAFE_BIGINT) return Number.MAX_SAFE_INTEGER;
  if (total < MIN_SAFE_BIGINT) return Number.MIN_SAFE_INTEGER;
  return Number(total);
}
