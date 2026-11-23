export function createMemoryStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(String(key)) ?? null,
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: key => items.delete(String(key))
  };
}
