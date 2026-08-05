export function parseCssRules(source) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const normalizedSource = String(source ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  let match;

  while ((match = pattern.exec(normalizedSource))) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const declarations = parseDeclarations(match[2]);
    rules.push({ selectors, declarations, body: match[2] });
  }

  return rules;
}

export function findCssRules(source, selectorPredicate) {
  return parseCssRules(source).filter((rule) => rule.selectors.some(selectorPredicate));
}

export function hasExactDeclaration(rule, property, expectedValue) {
  const actual = rule?.declarations?.get?.(String(property ?? "").trim().toLowerCase());
  if (actual === undefined) return false;
  if (expectedValue instanceof RegExp) return expectedValue.test(actual);
  return actual === String(expectedValue ?? "").trim();
}

function parseDeclarations(body) {
  const declarations = new Map();
  for (const rawDeclaration of String(body ?? "").split(";")) {
    const separator = rawDeclaration.indexOf(":");
    if (separator < 0) continue;

    const property = rawDeclaration.slice(0, separator).trim().toLowerCase();
    const value = rawDeclaration.slice(separator + 1).trim();
    if (property) declarations.set(property, value);
  }
  return declarations;
}
