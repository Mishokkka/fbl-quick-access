import { MODULE_ID, SETTINGS } from "./constants.js";
import { localize } from "./utils.js";

function registerBooleanSetting(key, name, hint, defaultValue) {
  game.settings.register(MODULE_ID, key, {
    name,
    hint,
    scope: "world",
    config: true,
    type: Boolean,
    default: defaultValue
  });
}

export function registerSettings() {
  registerBooleanSetting(
    SETTINGS.FEATURE_HEAT,
    localize("Settings.FeatureHeat.Name", "FBLEC: Heat"),
    localize("Settings.FeatureHeat.Hint", "Enables the special interface and counter for a critical injury named Heat. If disabled, it is shown as a normal injury."),
    true
  );

  registerBooleanSetting(
    SETTINGS.FEATURE_MOR,
    localize("Settings.FeatureMor.Name", "FBLEC: Mor"),
    localize("Settings.FeatureMor.Hint", "Enables the special interface and rolls for a critical injury named Mor. If disabled, it is shown as a normal injury."),
    true
  );

  registerBooleanSetting(
    SETTINGS.FEATURE_ADDICTION,
    localize("Settings.FeatureAddiction.Name", "FBLEC: Addiction"),
    localize("Settings.FeatureAddiction.Hint", "Enables the addiction interface for a critical injury whose name contains Addiction. If disabled, it is shown as a normal injury."),
    true
  );

  registerBooleanSetting(
    SETTINGS.FEATURE_WASH,
    localize("Settings.FeatureWash.Name", "FBLEC: Wash states"),
    localize("Settings.FeatureWash.Hint", "Enables mutually exclusive wash-state progression."),
    true
  );

  registerBooleanSetting(
    SETTINGS.CHAT_MESSAGES,
    localize("Settings.ChatMessages.Name", "FBLEC: Chat messages"),
    localize("Settings.ChatMessages.Hint", "If disabled, STAT buttons change data without creating chat messages."),
    true
  );

  registerBooleanSetting(
    SETTINGS.PLAYERS_CAN_EDIT,
    localize("Settings.PlayersCanEdit.Name", "FBLEC: Players can edit STAT"),
    localize("Settings.PlayersCanEdit.Hint", "If disabled, only the GM can edit conditions and use STAT controls."),
    true
  );

  game.settings.register(MODULE_ID, SETTINGS.WASH_STATE_UUIDS, {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTINGS.MIGRATION_VERSION, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
}

export function isFeatureEnabled(key) {
  return Boolean(game.settings.get(MODULE_ID, key));
}
