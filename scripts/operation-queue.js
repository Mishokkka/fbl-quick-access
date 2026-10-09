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

// Wallet edits and accepted transfers share the same authority-side queue.
// A global queue is sufficient for infrequent monetary writes and avoids a
// two-Actor lock ordering deadlock during opposite-direction transfers.
let currencyQueue = Promise.resolve();
export function enqueueCurrencyOperation(operation) {
  const next = currencyQueue.catch(() => undefined).then(operation);
  currencyQueue = next.catch(() => undefined);
  return next;
}
