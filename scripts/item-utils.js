import { MAX_QUICK_WEIGHT, MODULE_ID } from "./constants.js";
import { buildFirearmTooltipSection } from "./firearms.js";
import { qaLocalize } from "./i18n.js";
import {
  compactPlainText,
  decodeHtmlEntities,
  escapeHtml,
  extractText,
  humanizeKey,
  localizeOrFallback,
  normalizeText,
  stripHtml
} from "./utils.js";

const QUICK_ACCESS_ITEM_TYPES = new Set(["weapon", "armor", "gear", "rawMaterial"]);

export function isAllowedQuickItem(item) {
  return isQuickAccessItemType(item) && getItemWeightValue(item) <= MAX_QUICK_WEIGHT;
}

export function isQuickAccessItemType(item) {
  return QUICK_ACCESS_ITEM_TYPES.has(String(item?.type ?? ""));
}

export function getRawItemWeight(item) {
  const weight = item.system?.weight;

  if (weight && typeof weight === "object") {
    return weight.value ?? weight.max ?? weight.current ?? "regular";
  }

  return weight ?? "regular";
}

export function getItemWeightValue(item) {
  const rawWeight = getRawItemWeight(item);

  if (typeof rawWeight === "number" && Number.isFinite(rawWeight)) return rawWeight;

  const normalized = String(rawWeight ?? "regular").trim().toLowerCase();
  const systemMap = CONFIG.fbl?.encumbrance ?? {};
  const mapped = systemMap[normalized];
  if (Number.isFinite(Number(mapped))) return Number(mapped);

  const aliases = {
    none: 0,
    tiny: 0,
    negligible: 0,
    light: 0.5,
    normal: 1,
    regular: 1,
    item: 1,
    heavy: 2,
    veryheavy: 3,
    "very-heavy": 3,
    massive: 4
  };

  if (Object.hasOwn(aliases, normalized)) return aliases[normalized];

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric;

  return 1;
}

export function getItemCarryState(item) {
  const flagState = readItemFlagState(item);
  const normalizedFlagState = normalizeItemCarryValue(flagState);
  if (normalizedFlagState) return normalizedFlagState;

  const system = item?.system ?? {};
  const candidates = [
    { value: readPath(system, "location") },
    { value: readPath(system, "location.value") },
    { value: readPath(system, "carryState") },
    { value: readPath(system, "carryState.value") },
    { value: readPath(system, "state") },
    { value: readPath(system, "state.value") },
    { value: readPath(system, "carried"), booleanState: "backpack" },
    { value: readPath(system, "carried.value"), booleanState: "backpack" },
    { value: readPath(system, "stored"), booleanState: "backpack" },
    { value: readPath(system, "stored.value"), booleanState: "backpack" },
    { value: readPath(system, "equipped"), booleanState: "equipped" },
    { value: readPath(system, "equipped.value"), booleanState: "equipped" },
    { value: readPath(system, "dropped"), booleanState: "dropped" },
    { value: readPath(system, "dropped.value"), booleanState: "dropped" }
  ];

  for (const candidate of candidates) {
    const normalized = normalizeItemCarryValue(candidate.value, candidate.booleanState);
    if (normalized) return normalized;
  }

  return "";
}

export function isItemCarriedForEncumbrance(item) {
  const state = getItemCarryState(item);
  return Boolean(state) && state !== "dropped";
}

export function normalizeItemCarryValue(value, booleanState = "") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? (booleanState || "true") : "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);

  const text = normalizeText(String(value));
  if (!text) return "";

  const aliases = {
    equipped: "equipped",
    equip: "equipped",
    worn: "equipped",
    carried: "backpack",
    carry: "backpack",
    backpack: "backpack",
    bag: "backpack",
    inventory: "backpack",
    stored: "backpack",
    dropped: "dropped",
    drop: "dropped",
    ground: "dropped",
    floor: "dropped",
    stash: "dropped",
    экипировано: "equipped",
    надето: "equipped",
    вруках: "equipped",
    рюкзак: "backpack",
    снаряжение: "backpack",
    переносится: "backpack",
    брошено: "dropped",
    сброшено: "dropped",
    земля: "dropped"
  };

  return aliases[text] ?? text;
}

function readItemFlagState(item) {
  if (typeof item?.getFlag === "function") {
    const state = item.getFlag("forbidden-lands", "state");
    if (state) return state;
  }

  return item?.flags?.["forbidden-lands"]?.state
    ?? item?.flags?.state
    ?? "";
}

function readPath(object, path) {
  return path.split(".").reduce((current, key) => current?.[key], object);
}

export function getItemWeightLabel(item) {
  const raw = getRawItemWeight(item);
  const key = String(raw ?? "regular").trim().toLowerCase();

  const labels = {
    none: "WEIGHT.NONE",
    tiny: "WEIGHT.TINY",
    light: "WEIGHT.LIGHT",
    regular: "WEIGHT.REGULAR",
    normal: "WEIGHT.REGULAR",
    heavy: "WEIGHT.HEAVY"
  };

  const labelKey = labels[key];
  return labelKey ? game.i18n.localize(labelKey) : String(raw ?? "regular");
}

export async function buildItemTooltipHtml(item) {
  // Talent-tab entries are most useful as quick rules text. Talents stay
  // description-only; spells keep their tactical fields plus description.
  if (isDescriptionOnlyTooltipItem(item)) return buildDescriptionOnlyTooltipHtml(item);
  if (String(item?.type ?? "").toLowerCase() === "spell") return buildSpellTooltipHtml(item);

  const stats = buildMainTabTooltipStats(item);
  const firearmSection = buildFirearmTooltipSection(item);
  const textBlocks = await buildTooltipTextBlocks(item);
  const img = item.img ? `<img class="fblqa-item-tooltip-img" src="${escapeHtml(item.img)}" alt="">` : "";

  return `
    <div class="fblqa-item-tooltip-header">
      ${img}
      <div class="fblqa-item-tooltip-title">${escapeHtml(item.name)}</div>
    </div>
    ${stats.length ? `<div class="fblqa-item-tooltip-stats">${stats.map(renderTooltipStat).join("")}</div>` : ""}
    ${firearmSection}
    ${textBlocks}
  `;
}

function isDescriptionOnlyTooltipItem(item) {
  return String(item?.type ?? "").toLowerCase() === "talent";
}

async function buildDescriptionOnlyTooltipHtml(item) {
  const text = getDescriptionOnlyText(item);
  if (!text) return "";

  const html = await enrichTooltipText(text, item);
  return `<div class="fblqa-rich-text fblqa-description-only-tooltip">${html}</div>`;
}

function getDescriptionOnlyText(item) {
  const system = item.system ?? {};
  const candidates = [
    system.description,
    system.effect,
    system.text,
    system.text?.value,
    system.description?.value
  ];

  for (const candidate of candidates) {
    const text = decodeHtmlEntities(extractText(candidate));
    if (compactPlainText(stripHtml(text))) return text;
  }

  return "";
}

async function buildSpellTooltipHtml(item) {
  const system = item.system ?? {};
  const stats = [];

  addTooltipStat(stats, "Rank", system.rank);
  addTooltipStat(stats, "Type", formatSpellType(system.spellType ?? system.type));
  addTooltipStat(stats, "Range", formatPlainValue(system.range));
  addTooltipStat(stats, "Duration", formatPlainValue(system.duration));
  addTooltipStat(stats, "Ingredients", formatPlainValue(system.ingredient ?? system.ingredients));

  const description = getDescriptionOnlyText(item);
  const descriptionHtml = description
    ? `<div class="fblqa-rich-text fblqa-spell-tooltip-description">${await enrichTooltipText(description, item)}</div>`
    : "";

  return `
    ${stats.length ? `<div class="fblqa-item-tooltip-stats fblqa-spell-tooltip-stats">${stats.map(renderTooltipStat).join("")}</div>` : ""}
    ${descriptionHtml}
  `;
}

function formatSpellType(value) {
  if (!value) return "";
  const text = String(value).trim();
  const localized = game.i18n.localize(text);
  return localized && localized !== text ? localized : humanizeKey(text);
}

function buildMainTabTooltipStats(item) {
  const stats = [];
  const system = item.system ?? {};

  addTooltipStat(stats, qaLocalize("Tooltip.Type", "Тип"), localizeItemType(item.type));
  if (["weapon", "armor", "gear", "rawMaterial"].includes(item.type)) {
    addTooltipStat(stats, qaLocalize("Tooltip.Weight", "Вес"), getItemWeightLabel(item));
  }

  if (item.type === "weapon") {
    const category = normalizeWeaponCategory(system.category);
    addTooltipStat(stats, qaLocalize("Tooltip.Category", "Категория"), formatPlainValue(system.category));
    addTooltipStat(stats, qaLocalize("Tooltip.Bonus", "Бонус"), getNestedValue(system.bonus, "value"));
    addTooltipStat(stats, qaLocalize("Tooltip.Damage", "Урон"), system.damage);
    addTooltipStat(stats, qaLocalize("Tooltip.Range", "Дальность"), formatPlainValue(system.range));
    addTooltipStat(stats, qaLocalize("Tooltip.Grip", "Хват"), formatPlainValue(system.grip));
    if (category === "ranged") addTooltipStat(stats, qaLocalize("Tooltip.Ammo", "Боеприпас"), formatPlainValue(system.ammo));

    // Boolean weapon features are shown exactly like the Main tab: melee and ranged
    // use different sets, so inactive category-only fields stay hidden.
    addTooltipStat(stats, qaLocalize("Tooltip.Features", "Свойства"), formatWeaponFeatures(system.features, category));
  } else if (item.type === "armor") {
    addTooltipStat(stats, qaLocalize("Tooltip.Bonus", "Бонус"), getNestedValue(system.bonus, "value"));
    addTooltipStat(stats, qaLocalize("Tooltip.Part", "Часть"), formatPlainValue(system.part));
    addTooltipStat(stats, qaLocalize("Tooltip.Features", "Свойства"), formatArmorFeatures(system.features));
  } else if (item.type === "gear") {
    addTooltipStat(stats, qaLocalize("Tooltip.Bonus", "Бонус"), getNestedValue(system.bonus, "value"));
  }

  return stats;
}

function addTooltipStat(stats, label, value) {
  const formatted = formatTooltipValue(value);
  if (!formatted) return;
  stats.push({ label, value: formatted });
}

function renderTooltipStat(stat) {
  return `
    <div class="fblqa-item-tooltip-stat">
      <span class="fblqa-item-tooltip-stat-label">${escapeHtml(stat.label)}</span>
      <span class="fblqa-item-tooltip-stat-value">${stat.value}</span>
    </div>
  `;
}

function formatTooltipValue(value) {
  if (value === null || value === undefined || value === false || value === "") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  if (typeof value === "boolean") return value ? qaLocalize("Common.Yes", "Да") : "";
  return escapeHtml(String(value));
}

function getNestedValue(object, key) {
  if (object && typeof object === "object") return object[key];
  return undefined;
}

function formatPlainValue(value) {
  if (value === null || value === undefined || value === false || value === "") return "";
  if (typeof value === "string") return humanizeKey(value);
  return value;
}

function formatWeaponFeatures(features, category) {
  if (!features || typeof features !== "object") return "";

  const allowedFeatures = category === "ranged"
    ? ["slowReload"]
    : ["edged", "pointed", "blunt", "parrying", "shield", "hook"];

  return allowedFeatures
    .filter((key) => features[key] === true)
    .map((key) => localizeFeatureLabel(key))
    .join(", ");
}

function formatArmorFeatures(features) {
  if (!features) return "";
  return compactPlainText(stripHtml(decodeHtmlEntities(extractText(features))));
}

function normalizeWeaponCategory(value) {
  const category = String(value ?? "melee").trim().toLowerCase();
  return category === "ranged" ? "ranged" : "melee";
}

function localizeFeatureLabel(key) {
  const labelKeys = {
    edged: "WEAPON.FEATURES.EDGED",
    pointed: "WEAPON.FEATURES.POINTED",
    blunt: "WEAPON.FEATURES.BLUNT",
    parrying: "WEAPON.FEATURES.PARRYING",
    shield: "WEAPON.FEATURES.SHIELD",
    hook: "WEAPON.FEATURES.HOOK",
    slowReload: "WEAPON.FEATURES.SLOW_RELOAD"
  };

  return localizeOrFallback(labelKeys[key], humanizeKey(key));
}

async function buildTooltipTextBlocks(item) {
  const blocks = [];

  // Weapon Other Features is a separate rich-text editor on the Main tab.
  // It should not be mixed into the small stat grid, otherwise HTML gets crushed.
  const otherFeatures = await buildWeaponOtherFeaturesBlock(item);
  if (otherFeatures) blocks.push(otherFeatures);

  const fieldSpecs = [
    { key: "effect", flag: "Effect", label: qaLocalize("Tooltip.Effect", "Эффект") },
    { key: "description", flag: "Description", label: qaLocalize("Tooltip.Description", "Описание") },
    { key: "appearance", flag: "Appearance", label: qaLocalize("Tooltip.Appearance", "Внешний вид") },
    { key: "drawback", flag: "Drawback", label: qaLocalize("Tooltip.Drawback", "Недостаток") }
  ];

  for (const spec of fieldSpecs) {
    const block = await buildVisibleTooltipTextBlock(item, spec);
    if (block) blocks.push(block);
  }

  return blocks.join("");
}

async function buildWeaponOtherFeaturesBlock(item) {
  if (item.type !== "weapon") return "";

  const text = decodeHtmlEntities(extractText(item.system?.features?.others));
  if (!text) return "";

  const normalized = compactPlainText(stripHtml(text));
  if (!normalized) return "";

  const label = localizeOrFallback("WEAPON.FEATURES.OTHERS", "Other Features");
  const html = await enrichTooltipText(text, item);

  return `
    <section class="fblqa-item-tooltip-section fblqa-item-tooltip-description">
      <h4>${escapeHtml(label)}</h4>
      <div class="fblqa-rich-text">${html}</div>
    </section>
  `;
}

async function buildVisibleTooltipTextBlock(item, { key, flag, label }) {
  if (!isForbiddenLandsRichFieldVisible(item, flag)) return "";

  const text = decodeHtmlEntities(extractText(item.system?.[key]));
  if (!text) return "";

  const normalized = compactPlainText(stripHtml(text));
  if (!normalized) return "";

  const html = await enrichTooltipText(text, item);
  return `
    <section class="fblqa-item-tooltip-section fblqa-item-tooltip-description">
      <h4>${escapeHtml(label)}</h4>
      <div class="fblqa-rich-text">${html}</div>
    </section>
  `;
}

function isForbiddenLandsRichFieldVisible(item, flag) {
  if (!flag) return true;

  const settingKey = `show${flag}Field`;
  try {
    if (game.settings?.settings?.has?.(`forbidden-lands.${settingKey}`)) {
      const settingValue = game.settings.get("forbidden-lands", settingKey);
      if (settingValue === false) return false;
    }
  } catch (_error) {
    // Settings may be unavailable during early render. In that case, defer to item flags.
  }

  const hidden = typeof item.getFlag === "function"
    ? item.getFlag("forbidden-lands", flag)
    : item.flags?.["forbidden-lands"]?.[flag];

  return !hidden;
}

async function enrichTooltipText(text, item) {
  const raw = decodeHtmlEntities(String(text ?? "").trim());
  if (!raw) return "";

  if (globalThis.TextEditor?.enrichHTML) {
    try {
      return await TextEditor.enrichHTML(raw, {
        async: true,
        secrets: item.isOwner,
        relativeTo: item
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | tooltip text enrichment failed`, error);
    }
  }

  return escapeHtml(raw).replace(/\n/g, "<br>");
}

function localizeItemType(type) {
  const localized = game.i18n.localize(type);
  if (localized && localized !== type) return localized;
  return humanizeKey(type);
}
