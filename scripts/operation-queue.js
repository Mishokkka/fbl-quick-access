import { withActorMutationLock } from "./actor-mutation-lock.js";

/**
 * Create a per-object serial queue. Failed operations do not block later work.
 */
export function createObjectOperationQueue() {
  const queues = new WeakMap();

  return function enqueue(target, operation) {
    if (!target || typeof operation !== "function") return Promise.resolve(undefined);

    const previous = queues.get(target) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (queues.get(target) === next) queues.delete(target);
      });

    queues.set(target, next);
    return next;
  };
}

const enqueueActorMutation = createObjectOperationQueue();

export function enqueueActorMutationOperation(actor, operation) {
  return enqueueActorMutation(actor, () => withActorMutationLock(actor, operation));
}

export function withWalletLocks(actors, operation) {
  const byId = new Map(actors.filter(Boolean).map(actor => [actor.uuid ?? actor.id, actor]));
  const ordered = [...byId.keys()].sort();
  const acquire = index => {
    if (index === ordered.length) return operation();
    return enqueueActorMutationOperation(byId.get(ordered[index]), () => acquire(index + 1));
  };
  return acquire(0);
}

// Wallet edits and accepted transfers share the same authority-side queue.
// A global queue is sufficient for infrequent monetary writes and avoids a
// two-Actor lock ordering deadlock during opposite-direction transfers.
let currencyQueue = Promise.resolve();
export function enqueueCurrencyOperation(operation) {
  const next = currencyQueue.catch(() => undefined).then(operation);
  currencyQueue = next.catch(() => undefined);
  return next;
}
