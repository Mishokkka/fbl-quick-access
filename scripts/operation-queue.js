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

const actorMutations = new Map();

/** Internal steps of an Actor operation must run directly inside this queue. */
export function enqueueActorMutation(actor, operation) {
  const reference = actor?.uuid ?? actor?.id ?? actor;
  const key = typeof reference === "string" ? reference.replace(/^Actor\.([^.]+)$/, "$1") : reference;
  const previous = actorMutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation).finally(() => {
    if (actorMutations.get(key) === next) actorMutations.delete(key);
  });
  actorMutations.set(key, next);
  return next;
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
