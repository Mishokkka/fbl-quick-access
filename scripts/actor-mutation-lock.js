import { MODULE_ID } from "./constants.js";
import { createCodedError, plainValuesEqual, readDocumentFlag } from "./document-writes.js";
import { confirmDangerAction } from "./dialogs.js";
import { qaLocalize } from "./i18n.js";
import { findGameUser, makeSocketRequestId } from "./socket-utils.js";

const LOCK_ID = "fblqaActorLock01";
const RECOVERY_LOCK_ID = "fblqaRecover0001";
const LOCK_FLAG = "mutationLock";
const LOCK_OWNER = "mutationLockOwner";
const localLocks = new Set();

function readLocks(effects) {
  return Array.from(effects ?? [], effect => ({
    id: effect.id,
    token: readDocumentFlag(effect, MODULE_ID, LOCK_FLAG) ?? null,
    ownerId: readDocumentFlag(effect, MODULE_ID, LOCK_OWNER) ?? null
  })).filter(lock => lock.id === LOCK_ID || lock.id === RECOVERY_LOCK_ID || lock.token)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function actorLocks(actor) {
  return readLocks(actor?.getEmbeddedCollection?.("ActiveEffect")?.values());
}

async function persistedActorLocks(actor) {
  const Effect = globalThis.CONFIG?.ActiveEffect?.documentClass;
  if (!Effect?.database?.get) return actorLocks(actor);
  const effects = await Effect.database.get(Effect, { action: "get", parent: actor, query: {} });
  return readLocks(effects);
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

  // Foundry deletes by ID only. Serialize recovery across clients, then verify
  // the abandoned token through the database before passing that ID to delete.
  const recovery = locks.find(lock => lock.id === RECOVERY_LOCK_ID);
  const original = locks.filter(lock => lock.id !== RECOVERY_LOCK_ID);
  const removeAbandoned = async () => {
    const persisted = await persistedActorLocks(actor);
    const expected = recovery ? persisted : persisted.filter(lock => lock.id !== RECOVERY_LOCK_ID);
    if (!plainValuesEqual(expected, locks) || locks.some(stillInUse)) throw lockUnavailable();
    if (original.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", original.map(lock => lock.id), { render: false });
    }
    const remaining = await persistedActorLocks(actor);
    if (remaining.some(lock => lock.id !== RECOVERY_LOCK_ID)) throw lockUnavailable();
    if (recovery) {
      if (!plainValuesEqual(remaining, [recovery])) throw lockUnavailable();
      await actor.deleteEmbeddedDocuments("ActiveEffect", [recovery.id], { render: false });
      if ((await persistedActorLocks(actor)).some(lock => plainValuesEqual(lock, recovery))) throw lockUnavailable();
    }
    return true;
  };
  return recovery ? removeAbandoned()
    : withLockEffect(actor, RECOVERY_LOCK_ID, "Quick Access — Lock recovery", removeAbandoned);
}

function lockUnavailable() {
  const message = qaLocalize("Common.ActorBusy", "Another Quick Access operation is using this character, or its lock could not be saved. Check the character and retry.");
  return Object.assign(createCodedError("actor-mutation-busy", message), { fblqaUserMessage: message });
}

// Foundry v13 rejects duplicate embedded IDs on the server. This effect is
// disabled and has no changes or statuses.
export async function withActorMutationLock(actor, operation) {
  if (!actor?.getEmbeddedCollection) return operation();
  // Older builds used several effect IDs for locks.
  if (actorLocks(actor).length) throw lockUnavailable();
  return withLockEffect(actor, LOCK_ID, "Quick Access — Operation in progress", operation);
}

async function withLockEffect(actor, id, name, operation) {
  const token = makeSocketRequestId();
  const readLock = () => actor.getEmbeddedCollection("ActiveEffect").get(id);
  if (readLock()) throw lockUnavailable();

  let created;
  try {
    [created] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      _id: id, name, disabled: true, transfer: false, statuses: [], changes: [],
      flags: { [MODULE_ID]: { [LOCK_FLAG]: token, [LOCK_OWNER]: globalThis.game?.user?.id ?? null } }
    }], { keepId: true, render: false });
  } catch (error) {
    throw Object.assign(lockUnavailable(), { cause: error });
  }
  if (created?.id !== id || readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) !== token) throw lockUnavailable();

  localLocks.add(token);
  try {
    return await operation();
  } finally {
    try {
      if (readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) === token) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [id], { render: false });
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
