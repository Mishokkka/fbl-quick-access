export function saveGlobals(keys) {
  const snapshot = keys.map(key => [key, Object.hasOwn(globalThis, key), globalThis[key]]);
  return () => {
    for (const [key, existed, value] of snapshot) {
      if (existed) globalThis[key] = value;
      else delete globalThis[key];
    }
  };
}

export function getFoundryPath(document, path) {
  if (document && Object.hasOwn(document, path)) return document[path];
  return String(path).split(".").reduce((value, key) => value?.[key], document);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeFields(target, source) {
  for (const [key, entry] of Object.entries(source)) {
    if (isObject(target[key]) && isObject(entry)) mergeFields(target[key], entry);
    else target[key] = structuredClone(entry);
  }
  return target;
}

export function setFoundryPath(document, path, value, { replace = false } = {}) {
  const parts = path.split(".");
  const leaf = parts.pop();
  const parent = parts.reduce((object, key) => {
    if (!object[key] || typeof object[key] !== "object") object[key] = {};
    return object[key];
  }, document);
  if (leaf.startsWith("-=")) {
    delete parent[leaf.slice(2)];
  } else if (leaf.startsWith("==")) {
    parent[leaf.slice(2)] = structuredClone(value);
  } else if (!replace && isObject(parent[leaf]) && isObject(value)) {
    parent[leaf] = mergeFields(structuredClone(parent[leaf]), value);
  } else {
    parent[leaf] = structuredClone(value);
  }
}

function readFlag(scope, key) {
  return getFoundryPath(this.flags[scope], key);
}

function writeFlag(scope, key, value, options) {
  setFoundryPath(this.flags[scope] ??= {}, key, value, options);
  return this;
}

function deleteFlag(scope, key) {
  const flags = this.flags[scope];
  if (!flags) return this;
  if (Object.hasOwn(flags, key)) delete flags[key];
  else {
    const parts = key.split(".");
    const name = parts.pop();
    const parent = parts.length ? getFoundryPath(flags, parts.join(".")) : flags;
    if (parent) delete parent[name];
  }
  return this;
}

export function makeFoundryActor({ _flags = {}, cancelSetFlag, cancelUnsetFlag, cancelUpdate = false, ...overrides } = {}) {
  const id = overrides.id ?? "actor-1";
  return {
    id, uuid: `Actor.${id}`, name: "Tester", documentName: "Actor", type: "character",
    isOwner: true, pack: null, system: {}, items: [], effects: [], flags: _flags,
    setCancelUpdate(value) { cancelUpdate = value; },
    getFlag: readFlag,
    async setFlag(scope, key, value) {
      if (!cancelSetFlag && !cancelUpdate) return writeFlag.call(this, scope, key, value);
    },
    async unsetFlag(scope, key) {
      if (!cancelUnsetFlag) return deleteFlag.call(this, scope, key);
    },
    async update(changes) {
      if (cancelUpdate) return;
      for (const [path, value] of Object.entries(changes)) setFoundryPath(this, path, value);
      return this;
    },
    ...overrides
  };
}

export function makeFoundryUser({ _flags = {}, ...overrides } = {}) {
  return {
    id: "user-1", name: "User", isGM: false, active: true, character: null, flags: _flags,
    getFlag: readFlag,
    async setFlag(scope, key, value) { return writeFlag.call(this, scope, key, value, { replace: true }); },
    async unsetFlag(scope, key) { return deleteFlag.call(this, scope, key); },
    ...overrides
  };
}
