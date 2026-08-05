import { MODULE_ID as QUICK_ACCESS_MODULE_ID } from "../constants.js";

export const MODULE_ID = QUICK_ACCESS_MODULE_ID;
export const LEGACY_MODULE_ID = "forbidden-lands-expanded-conditions";
export const CONDITIONS_TAB_ID = "conditions";
export const CONDITIONS_TAB_LABEL = "STAT";
export const MIGRATION_VERSION = 6;

export const DEFAULT_ADDICTION_STATE = Object.freeze({
  phase: "down",
  die: 12,
  daysLeft: 0,
  severity: 5
});

export const SETTINGS = Object.freeze({
  FEATURE_HEAT: "featureHeat",
  FEATURE_MOR: "featureMor",
  FEATURE_ADDICTION: "featureAddiction",
  FEATURE_WASH: "featureWash",
  CHAT_MESSAGES: "chatMessages",
  PLAYERS_CAN_EDIT: "playersCanEdit",
  WASH_STATE_UUIDS: "washStateUuids",
  MIGRATION_VERSION: "expandedConditionsMigrationVersion"
});

export const LEGACY_SETTINGS = Object.freeze({
  FEATURE_HEAT: "featureHeat",
  FEATURE_MOR: "featureMor",
  FEATURE_ADDICTION: "featureAddiction",
  FEATURE_WASH: "featureWash",
  CHAT_MESSAGES: "chatMessages",
  PLAYERS_CAN_EDIT: "playersCanEdit",
  WASH_STATE_UUIDS: "washStateUuids",
  MIGRATION_VERSION: "migrationVersion"
});

export const FLAGS = Object.freeze({
  LIST: "conditions.list",
  LAYOUT_COLUMNS: "conditions.layoutColumns",
  ORDER: "conditions.order",
  NOTES: "conditions.notes",
  TREATMENT_STATUS: "conditions.treatmentStatus",
  TREATMENT_DATA: "conditions.treatmentData",
  ADDICTION_STATE: "conditions.addictionState",
  ADDICTION_MODIFIER_KEYS: "conditions.addictionModifierKeys",
  HEAT_VALUE: "conditions.heatValue",
  MOR_STATE: "conditions.morState"
});

export const LEGACY_FLAGS = Object.freeze({
  LIST: "list",
  LAYOUT_COLUMNS: "layoutColumns",
  ORDER: "order",
  NOTES: "notes",
  TREATMENT_STATUS: "treatmentStatus",
  TREATMENT_DATA: "treatmentData",
  ADDICTION_STATE: "addictionState",
  ADDICTION_MODIFIER_KEYS: "addictionModifierKeys",
  HEAT_VALUE: "heatValue",
  MOR_STATE: "morState"
});

export function flagUpdatePath(flagKey) {
  return `flags.${MODULE_ID}.${flagKey}`;
}

export function flagDeletePath(flagKey) {
  const parts = String(flagKey).split(".");
  const leaf = parts.pop();
  const parent = parts.length ? `${parts.join(".")}.` : "";
  return `flags.${MODULE_ID}.${parent}-=${leaf}`;
}

export const TEMPLATE_PATHS = Object.freeze({
  statTab: `modules/${MODULE_ID}/templates/conditions/stat-tab.hbs`,
  customCondition: `modules/${MODULE_ID}/templates/conditions/rows/custom-condition.hbs`,
  customArc: `modules/${MODULE_ID}/templates/conditions/rows/custom-arc.hbs`,
  injuryArc: `modules/${MODULE_ID}/templates/conditions/rows/injury-arc.hbs`,
  heat: `modules/${MODULE_ID}/templates/conditions/rows/heat.hbs`,
  mor: `modules/${MODULE_ID}/templates/conditions/rows/mor.hbs`,
  addiction: `modules/${MODULE_ID}/templates/conditions/rows/addiction.hbs`,
  injury: `modules/${MODULE_ID}/templates/conditions/rows/injury.hbs`
});
