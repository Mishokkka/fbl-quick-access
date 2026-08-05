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
