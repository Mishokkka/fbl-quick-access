import { qaLocalize } from "./i18n.js";

export function canModifyActor(actor) {
  return Boolean(actor?.isOwner);
}

export function warnCannotModifyActor(message = qaLocalize("Permissions.NoActorModify", "Нет прав на изменение этого персонажа.")) {
  globalThis.ui?.notifications?.warn?.(message);
}
