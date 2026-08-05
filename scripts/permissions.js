export function canModifyActor(actor) {
  return Boolean(actor?.isOwner);
}

import { qaLocalize } from "./i18n.js";

export function warnCannotModifyActor(message = qaLocalize("Permissions.NoActorModify", "Нет прав на изменение этого персонажа.")) {
  ui.notifications?.warn(message);
}
