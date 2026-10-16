import { getFirearmTooltipData } from "./firearms.js";
import { decodeHtmlEntities, extractText } from "./utils.js";

const native = {
  edged: ["EDGED", "Режущее", "Edged"], pointed: ["POINTED", "Колющее", "Pointed"],
  blunt: ["BLUNT", "Дробящее", "Blunt"], parrying: ["PARRYING", "Парирующее", "Parrying"],
  shield: ["SHIELD", "Щит", "Shield"], hook: ["HOOK", "Зацеп", "Hook"],
  slowReload: ["SLOW_RELOAD", "Медленная перезарядка", "Slow Reload"]
};
const normalize = value => String(value ?? "").trim().toLocaleLowerCase();

/** Use the same rule journal as FL Firearms; respect both document permissions. */
function rule(labels, fallback = "") {
  const journal = game.journal?.find?.(entry => entry.name === "Rich Info Tooltips");
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  if (!journal?.testUserPermission?.(game.user, observer)) return null;
  const names = new Set(labels.map(normalize).filter(Boolean));
  const page = journal.pages?.find?.(entry => names.has(normalize(entry.name)));
  if (!page?.testUserPermission?.(game.user, observer)) return null;
  const content = page.text?.content ?? page.system?.text?.content ?? fallback;
  return {html: typeof content === "string" ? content : "",
    relativeTo: page, secrets: Boolean(page.isOwner)};
}

/** Resolve a public FL Firearms descriptor without fetching the optional API again. */
export function getFirearmFeatureInfo(feature) {
  if (!feature || typeof feature.key !== "string") return null;
  const label = String(feature.label ?? feature.key);
  return {label, ...(rule([label, feature.key], feature.descriptionHtml) ?? {html: ""})};
}

/** Resolve one real, active property. Missing rules stay plain labels in callers. */
export function getItemFeatureInfo(item, key) {
  if (!["weapon", "gear"].includes(item?.type)) return null;
  if (key === "others") {
    const html = decodeHtmlEntities(extractText(typeof item.system?.features === "string" ? item.system.features : item.system?.features?.others));
    return html.trim() ? {label: game.i18n.localize("WEAPON.FEATURES.OTHERS"), html,
      relativeTo: item, secrets: Boolean(item.isOwner)} : null;
  }
  if (item.type !== "weapon") return null;
  if (Object.hasOwn(native, key) && item.system?.features?.[key] === true) {
    const [suffix, fallback, english] = native[key], token = `WEAPON.FEATURES.${suffix}`;
    const localized = game.i18n.localize(token), label = localized && localized !== token ? localized : fallback;
    return {label, ...(rule([label, fallback, english, key]) ?? {html: ""})};
  }
  const features = getFirearmTooltipData(item)?.features;
  const feature = Array.isArray(features) ? features.find(value => value?.key === key) : null;
  return getFirearmFeatureInfo(feature);
}
