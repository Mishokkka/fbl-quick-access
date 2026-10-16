import { getEquipmentState } from "./equipment-api.js";
import { getFirearmFeatureInfo, getItemFeatureInfo } from "../item-feature-info.js";

const FIREARMS = "fl-firearms";
const nativeFeatures = ["edged", "pointed", "blunt", "parrying", "shield", "hook", "slowReload"];
const featureKeys = { slowReload: "SLOW_RELOAD" };
const fallbackFeatures = { edged: "Режущее", pointed: "Колющее", blunt: "Дробящее", parrying: "Парирующее", shield: "Щит", hook: "Зацеп", slowReload: "Медленная перезарядка" };
const rangeLabels = { arm: "AL", near: "Near", short: "Short", long: "Long", distant: "Distant" };
const number = value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => typeof value === "string" || typeof value === "number" ? String(value).slice(0, 12000) : "";

/** Descriptions cross the public contract as plain text, never executable markup. */
function plain(value, secrets = false) {
  const html = text(value);
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll(`script, style, iframe, object${secrets ? "" : ", section.secret"}`).forEach(node => node.remove());
    document.querySelectorAll("br, p, li, div").forEach(node => node.append("\n"));
    return document.body.textContent.trim();
  }
  return html.replace(/<[^>]*>/g, " ").trim();
}

function featureDescription(info) {
  return plain(info?.html, info?.secrets === true);
}

function localized(key, fallback) {
  const value = game.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}

function firearm(item) {
  const module = game.modules?.get?.(FIREARMS);
  const api = module?.active ? module.api : null;
  if (typeof api?.getFirearmTooltipData !== "function") return null;
  try {
    const data = api.getFirearmTooltipData(item);
    if (!data?.isFirearm) return null;
    const magazine = typeof api.getMagazineProfile === "function" ? api.getMagazineProfile(item) : null;
    const capacity = number(magazine?.capacity ?? data.magCapacity);
    const current = number(magazine?.current ?? data.magCurrent);
    const reloadType = text(data.reloadType);
    const features = Array.isArray(data.features) ? data.features.slice(0, 100).map(feature => ({
      key: text(feature.key), label: text(feature.label ?? feature.key),
      value: feature.hasInput ? text(feature.value) : "", automated: feature.automated === true,
      // Hover availability and the rich tooltip must resolve the same live rule.
      description: featureDescription(getFirearmFeatureInfo(feature)),
      source: FIREARMS,
    })) : [];
    return {
      reloadType, reloadValue: text(data.reloadValue), type: text(data.firearmType),
      magazine: reloadType.toUpperCase() === "MAG" && capacity !== null && current !== null ? {capacity, current} : null,
      armorPiercing: number(data.apValue) !== null ? {value: number(data.apValue), operator: text(data.apOp)} : null,
      load: reloadType.toUpperCase() === "MAG" && typeof api.loadMagazine === "function",
      topOff: reloadType.toUpperCase() === "MAG" && typeof api.topOffMagazine === "function" && features.some(feature => feature.key === "TopOff"),
      features,
    };
  } catch (error) {
    console.warn("fbl-quick-access | Weapon presentation: optional firearm API failed", error);
    return null;
  }
}

/** Additive read-only API. Equipment version/revision and legacy flags stay intact. */
export function getHeldItemPresentation(actor) {
  const equipment = getEquipmentState(actor); // Applies the existing observer/owner check.
  const items = [];
  for (const itemId of new Set(Object.values(equipment.hands).filter(Boolean))) {
    const item = actor.items.get(itemId);
    if (!item) continue;
    const system = item.system ?? {};
    let roll = {};
    try { roll = item.getRollData?.() ?? {}; }
    catch (_error) { roll = {isBroken: true}; }
    const gun = firearm(item);
    const features = nativeFeatures.filter(key => system.features?.[key] === true).map(key => ({
      key, label: localized(`WEAPON.FEATURES.${featureKeys[key] ?? key.toUpperCase()}`, fallbackFeatures[key]),
      value: "", description: featureDescription(getItemFeatureInfo(item, key)), automated: false, source: "system",
    }));
    const other = plain(typeof system.features === "string" ? system.features : system.features?.others);
    if (other) features.push({key: "others", label: localized("WEAPON.FEATURES.OTHERS", "Другие свойства"), value: "", description: other, automated: false, source: "system"});
    const snapshot = {
      itemId, itemUuid: item.uuid ?? null, name: item.name ?? "", img: item.img ?? "icons/svg/item-bag.svg", type: item.type,
      hand: equipment.hands.left === itemId && equipment.hands.right === itemId ? "both" : equipment.hands.left === itemId ? "left" : "right",
      requiredGrip: text(system.grip), bonus: number(system.bonus?.value ?? roll.value),
      damage: item.type === "weapon" ? number(system.damage) : null,
      range: rangeLabels[system.range] ?? text(system.range), artifact: text(roll.artifactDie ?? system.artifactDie),
      broken: Boolean(item.isBroken || roll.isBroken),
      attack: item.type === "weapon" && number(system.damage) > 0 && !item.isBroken && !roll.isBroken,
      reload: Boolean(gun || item.type === "weapon" && system.category === "ranged" && system.features?.slowReload),
      firearm: gun, features: [...features, ...(gun?.features ?? [])],
    };
    // A GM executes commands for players with different locales/journal access.
    // Never include viewer-specific labels/descriptions in a comparison token.
    snapshot.revision = JSON.stringify([
      itemId, item.uuid ?? null, item.name, item.img, item.type, snapshot.hand,
      system.grip, system.category, snapshot.bonus, snapshot.damage, system.range, snapshot.artifact, snapshot.broken,
      nativeFeatures.map(key => [key, system.features?.[key] === true]), text(typeof system.features === "string" ? system.features : system.features?.others),
      gun && [gun.reloadType, gun.reloadValue, gun.type, gun.magazine, gun.armorPiercing, gun.load, gun.topOff,
        gun.features.map(feature => [feature.key, feature.value, feature.automated])],
    ]);
    items.push(snapshot);
  }
  return {apiVersion: 1, actorUuid: equipment.actorUuid, equipmentRevision: equipment.revision, editable: equipment.editable, items};
}
