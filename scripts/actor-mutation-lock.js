import { MODULE_ID } from "./constants.js";
import { createCodedError, plainValuesEqual, readDocumentFlag } from "./document-writes.js";
import { confirmDangerAction } from "./dialogs.js";
import { qaLocalize } from "./i18n.js";
import { findGameUser, makeSocketRequestId } from "./socket-utils.js";

const LOCK_ID = "fblqaActorLock01";
const LOCK_FLAG = "mutationLock";
const LOCK_OWNER = "mutationLockOwner";
const localLocks = new Set();

function actorLocks(actor) {
  const effects = actor?.getEmbeddedCollection?.("ActiveEffect");
  return Array.from(effects?.values() ?? [], effect => ({
    id: effect.id,
    token: readDocumentFlag(effect, MODULE_ID, LOCK_FLAG) ?? null,
    ownerId: readDocumentFlag(effect, MODULE_ID, LOCK_OWNER) ?? null
  })).filter(lock => lock.id === LOCK_ID || lock.token);
}

export async function recoverActorMutationLock(actor) {
  if (!globalThis.game?.user?.isGM) return false;
  const locks = actorLocks(actor);
  const stillInUse = ({ token, ownerId }) => localLocks.has(token)
    || (ownerId && ownerId !== globalThis.game?.user?.id && findGameUser(ownerId)?.active);
  if (!locks.length) return false;
  if (locks.some(stillInUse)) throw lockUnavailable();

  const confirmed = await confirmDangerAction({
    title: qaLocalize("Common.RecoverActorLock", "Clear an interrupted Quick Access lock"),
    heading: actor.name ?? actor.id,
    message: qaLocalize("Common.RecoverActorLockHint", "Check that the player and GM have finished all Quick Access actions for this character."),
    warning: qaLocalize("Common.RecoverActorLockWarning", "Only clear a lock left by a closed or disconnected client. Review any interrupted edits and transfers before retrying."),
    confirmLabel: qaLocalize("Common.RecoverActorLock", "Clear an interrupted Quick Access lock"),
    icon: "fas fa-unlock"
  });
  if (!confirmed || !globalThis.game?.user?.isGM) return false;
  if (!plainValuesEqual(actorLocks(actor), locks) || locks.some(stillInUse)) throw lockUnavailable();
  const ids = locks.map(lock => lock.id);
  await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { render: false });
  if (actorLocks(actor).some(lock => ids.includes(lock.id))) throw lockUnavailable();
  return true;
}

function lockUnavailable() {
  const message = qaLocalize("Common.ActorBusy", "Another Quick Access operation is using this character, or its lock could not be saved. Check the character and retry.");
  return Object.assign(createCodedError("actor-mutation-busy", message), { fblqaUserMessage: message });
}

// Foundry v13 rejects duplicate embedded IDs on the server. This effect is
// disabled and has no changes or statuses.
export async function withActorMutationLock(actor, operation) {
  if (!actor?.getEmbeddedCollection) return operation();
  const token = makeSocketRequestId();
  const effects = actor.getEmbeddedCollection("ActiveEffect");
  const readLock = () => actor.getEmbeddedCollection("ActiveEffect").get(LOCK_ID);
  if (effects.has(LOCK_ID)) throw lockUnavailable();
  // Older builds used several effect IDs for locks.
  for (const effect of effects.values()) {
    if (readDocumentFlag(effect, MODULE_ID, LOCK_FLAG)) throw lockUnavailable();
  }

  let created;
  try {
    [created] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      _id: LOCK_ID, name: "Quick Access — Operation in progress", disabled: true, transfer: false, statuses: [], changes: [],
      flags: { [MODULE_ID]: { [LOCK_FLAG]: token, [LOCK_OWNER]: globalThis.game?.user?.id ?? null } }
    }], { keepId: true, render: false });
  } catch (error) {
    throw Object.assign(lockUnavailable(), { cause: error });
  }
  if (created?.id !== LOCK_ID || readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) !== token) throw lockUnavailable();

  localLocks.add(token);
  try {
    return await operation();
  } finally {
    try {
      if (readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) === token) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [LOCK_ID], { render: false });
        if (readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) === token) throw lockUnavailable();
      }
    } catch (error) {
      console.error(`${MODULE_ID} | could not release operation lock for ${actor.name ?? actor.id}`, error);
      globalThis.ui?.notifications?.warn?.(qaLocalize("Common.ActorLockReleaseFailed",
        "Quick Access could not remove an operation lock from {actor}. Review its Active Effects before retrying.", { actor: actor.name ?? actor.id }));
    } finally {
      localLocks.delete(token);
    }
  }
}
