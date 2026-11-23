import { MODULE_ID } from "./constants.js";
import { createCodedError, readDocumentFlag } from "./document-writes.js";
import { qaLocalize } from "./i18n.js";
import { makeSocketRequestId } from "./socket-utils.js";

const LOCK_ID = "fblqaActorLock01";
const LOCK_FLAG = "mutationLock";

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
      flags: { [MODULE_ID]: { [LOCK_FLAG]: token } }
    }], { keepId: true, render: false });
  } catch (error) {
    throw Object.assign(lockUnavailable(), { cause: error });
  }
  if (created?.id !== LOCK_ID || readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) !== token) throw lockUnavailable();

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
    }
  }
}
