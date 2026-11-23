import { MODULE_ID } from "./constants.js";
import { createCodedError, readDocumentFlag } from "./document-writes.js";
import { qaLocalize } from "./i18n.js";
import { makeSocketRequestId } from "./socket-utils.js";

const LOCKS = Object.freeze({
  conditions: ["fblqaConditions1", "Quick Access — Condition list operation"],
  mor: ["fblqaMorChange01", "Quick Access — Mor operation"],
  currency: ["fblqaCurrency001", "Quick Access — Wallet operation"]
});
const LOCK_FLAG = "mutationLock";

function lockUnavailable() {
  const message = qaLocalize("Common.ActorBusy", "Another Quick Access operation is using this character, or its lock could not be saved. Check the character and retry.");
  return Object.assign(createCodedError("actor-mutation-busy", message), { fblqaUserMessage: message });
}

// Foundry v13 serializes writes on the server and rejects an existing ID in an
// embedded collection. A disabled, statusless effect gives both local and remote
// clients that same exclusion without treating a successful flag update as CAS.
export async function withActorMutationLock(actor, kind, operation) {
  if (!actor?.getEmbeddedCollection) return operation();
  const [id, name] = LOCKS[kind];
  const token = makeSocketRequestId();
  const readLock = () => actor.getEmbeddedCollection("ActiveEffect").get(id);
  if (readLock()) throw lockUnavailable();

  let created;
  try {
    [created] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      _id: id, name, disabled: true, transfer: false, statuses: [], changes: [],
      flags: { [MODULE_ID]: { [LOCK_FLAG]: token } }
    }], { keepId: true, render: false });
  } catch (error) {
    throw Object.assign(lockUnavailable(), { cause: error });
  }
  if (created?.id !== id || readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) !== token) throw lockUnavailable();

  try {
    return await operation();
  } finally {
    try {
      if (readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) === token) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [id], { render: false });
        if (readDocumentFlag(readLock(), MODULE_ID, LOCK_FLAG) === token) throw lockUnavailable();
      }
    } catch (error) {
      console.error(`${MODULE_ID} | could not release ${kind} lock for ${actor.name ?? actor.id}`, error);
      globalThis.ui?.notifications?.warn?.(qaLocalize("Common.ActorLockReleaseFailed",
        "Quick Access could not remove an operation lock from {actor}. Review its Active Effects before retrying.", { actor: actor.name ?? actor.id }));
    }
  }
}

export function withWalletLocks(actors, operation) {
  const unique = new Map(actors.filter(Boolean).map(actor => [actor.uuid ?? actor.id, actor]));
  const ordered = [...unique.keys()].sort().map(id => unique.get(id));
  return ordered.reduceRight((next, actor) => () => withActorMutationLock(actor, "currency", next), operation)();
}
