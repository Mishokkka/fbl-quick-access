const ROOT_KEY = "FBLQA";

export function qaLocalize(key, fallback = "", data = {}) {
  const fullKey = key.startsWith(`${ROOT_KEY}.`) ? key : `${ROOT_KEY}.${key}`;
  let text = fullKey;

  try {
    text = game?.i18n?.localize?.(fullKey) ?? fullKey;
  } catch (_error) {
    text = fullKey;
  }

  if (!text || text === fullKey) text = fallback;
  return interpolate(String(text ?? ""), data);
}

function interpolate(template, data) {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, key) => {
    const value = getPath(data, key);
    return value === undefined || value === null ? "" : String(value);
  });
}

function getPath(object, path) {
  return String(path).split(".").reduce((current, part) => {
    if (current === undefined || current === null) return undefined;
    return current[part];
  }, object);
}
