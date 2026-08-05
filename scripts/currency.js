import { CURRENCIES } from "./constants.js";
import { getActorCurrencyValue } from "./actor-data.js";

export function getCurrencyValue(actor, key) {
  return getActorCurrencyValue(actor, key);
}

export function parseCurrencyExpression(rawValue) {
  const text = String(rawValue ?? "").replace(/\s+/g, "");

  if (!text) return { ok: false, value: 0, relative: false };
  if (!/^[+\-]?\d+(?:[+\-]\d+)*$/.test(text)) {
    return { ok: false, value: 0, relative: false };
  }

  const tokens = text.match(/[+\-]?\d+/g);
  if (!tokens?.length) return { ok: false, value: 0, relative: false };

  const value = tokens.reduce((sum, token) => sum + Number.parseInt(token, 10), 0);
  const relative = /^[+\-]/.test(text);

  if (!Number.isFinite(value)) return { ok: false, value: 0, relative };

  return { ok: true, value, relative };
}

export function getWalletCopperTotal(actor) {
  return CURRENCIES.reduce((sum, currency) => {
    return sum + getCurrencyValue(actor, currency.key) * currency.unit;
  }, 0);
}
