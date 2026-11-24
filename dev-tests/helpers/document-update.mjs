function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function expandObject(value) {
  if (Array.isArray(value)) return value.map(expandObject);
  if (!isPlainObject(value)) return value;

  const expanded = {};
  for (const [path, entry] of Object.entries(value)) {
    const parts = path.split(".");
    const key = parts.pop();
    let parent = expanded;
    for (const part of parts) {
      if (!isPlainObject(parent[part])) parent[part] = {};
      parent = parent[part];
    }
    parent[key] = expandObject(entry);
  }
  return expanded;
}

// Foundry's v13 client backend copies the expansion back into the caller's patch.
export function expandUpdateInPlace(update) {
  const expanded = expandObject(update);
  for (const key of Object.keys(update)) delete update[key];
  Object.assign(update, expanded);
}

function mergeUpdate(target, update) {
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith("-=") && value === null) {
      delete target[key.slice(2)];
    } else if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      mergeUpdate(target[key], value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

export function applyDocumentUpdate(document, update) {
  expandUpdateInPlace(update);
  mergeUpdate(document._source ?? document, update);
}
