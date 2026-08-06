export const MODULE_ID = "fbl-quick-access";
export const FLAG_SLOTS = "slots";
export const GEAR_CARD_VIEW_STORAGE_PREFIX = "fblqa.gearCardView";
export const WALLET_EXPANDED_STORAGE_PREFIX = "fblqa.walletExpanded";
export const FLAG_GEAR_ORDER = "gearOrder";
export const FLAG_COMPACT_BORDERS = "compactDecorativeBorders";
export const FLAG_SHORT_REST_RECOVERY = "shortRestRecovery";
export const FLAG_REPUTATION_ENTRIES = "reputationEntries";
export const FLAG_BIOGRAPHY_PROFILE = "biographyProfile";
export const SYSTEM_ID = "forbidden-lands";

export const SETTINGS = Object.freeze({
  PLAYERS_CAN_RESET_SHORT_REST: "playersCanResetShortRest",
  POST_NO_CHANGE_REST_CARDS: "postNoChangeRestCards"
});

export const MAX_SLOTS = 10;
export const MAX_QUICK_WEIGHT = 1;
export const ITEM_TOOLTIP_DELAY_MS = 1000;
// Forbidden Lands denominations, normalized to copper for wallet arithmetic.
export const CURRENCIES = [
  { key: "gold", abbrKey: "Wallet.CurrencyAbbr.Gold", abbrFallback: "GP", label: "CURRENCY.GOLD", unit: 100 },
  { key: "silver", abbrKey: "Wallet.CurrencyAbbr.Silver", abbrFallback: "SP", label: "CURRENCY.SILVER", unit: 10 },
  { key: "copper", abbrKey: "Wallet.CurrencyAbbr.Copper", abbrFallback: "CP", label: "CURRENCY.COPPER", unit: 1 }
];

export const CURRENCY_BY_KEY = Object.fromEntries(
  CURRENCIES.map((currency) => [currency.key, currency])
);
