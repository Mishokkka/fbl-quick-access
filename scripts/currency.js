import { CURRENCIES } from "./constants.js";
import { getActorCurrencyValue } from "./actor-data.js";
import { qaLocalize } from "./i18n.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export function getCurrencyValue(actor, key) {
  return getActorCurrencyValue(actor, key);
}

export function getCurrencyAbbreviation(currency) {
  return qaLocalize(currency?.abbrKey, currency?.abbrFallback ?? currency?.key ?? "");
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
