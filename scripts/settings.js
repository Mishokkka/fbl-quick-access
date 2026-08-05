import { MODULE_ID, SETTINGS } from "./constants.js";
import { qaLocalize } from "./i18n.js";

export function registerCoreSettings() {
  game.settings.register(MODULE_ID, SETTINGS.PLAYERS_CAN_RESET_SHORT_REST, {
    name: qaLocalize("Settings.PlayersCanResetShortRest.Name", "Players can reset the Short Rest limit"),
    hint: qaLocalize("Settings.PlayersCanResetShortRest.Hint", "Allow character owners to manually clear the once-per-Quarter-Day Short Rest recovery limit. GMs can always reset it."),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.POST_NO_CHANGE_REST_CARDS, {
    name: qaLocalize("Settings.PostNoChangeRestCards.Name", "Post no-change Rest cards"),
    hint: qaLocalize("Settings.PostNoChangeRestCards.Hint", "Post a chat card when Rest completes without changing the character sheet."),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

export function canResetShortRestLimit(actor = null) {
  if (game.user?.isGM) return true;
  if (!actor?.isOwner) return false;
  return Boolean(game.settings.get(MODULE_ID, SETTINGS.PLAYERS_CAN_RESET_SHORT_REST));
}

export function shouldPostNoChangeRestCards() {
  return Boolean(game.settings.get(MODULE_ID, SETTINGS.POST_NO_CHANGE_REST_CARDS));
}
