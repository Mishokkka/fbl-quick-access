import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { findCssRules, hasExactDeclaration } from "./helpers/css-rules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleJsonPath = join(root, "module.json");
const moduleJson = JSON.parse(readFileSync(moduleJsonPath, "utf8"));

test("module manifest references existing scripts and styles", () => {
  for (const path of [...moduleJson.esmodules, ...moduleJson.styles]) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }
});

test("module manifest has synchronized README version", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, new RegExp(`Version ${moduleJson.version.replaceAll(".", "\\.")}`));
});

test("module manifest enables the native socket namespace", () => {
  assert.equal(moduleJson.socket, true);
});

test("style manifest keeps ordered feature CSS and no legacy final file", () => {
  assert.deepEqual(moduleJson.styles, [
    "styles/00-tokens.css",
    "styles/01-core.css",
    "styles/02-tooltips.css",
    "styles/03-main-tab.css",
    "styles/04-gear-cards.css",
    "styles/05-wallet.css",
    "styles/06-sheet-borders.css",
    "styles/08-willpower.css",
    "styles/10-rest.css",
    "styles/11-expanded-conditions.css",
    "styles/09-compat-prosthetics.css",
    "styles/12-reputation.css"
  ]);

  assert.equal(moduleJson.styles.some((path) => /final/i.test(normalize(path))), false);
});


test("module manifest references existing language files", () => {
  assert.ok(Array.isArray(moduleJson.languages), "languages should be declared");
  assert.ok(moduleJson.languages.length >= 1, "at least one language should be declared");

  for (const language of moduleJson.languages) {
    assert.equal(existsSync(join(root, language.path)), true, `${language.path} should exist`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, language.path), "utf8")), `${language.path} should be valid JSON`);
  }
});

test("localization files cover every qaLocalize key used by scripts", () => {
  const usedKeys = collectUsedLocalizationKeys();
  assert.ok(usedKeys.size > 0, "script localization keys should be found");

  for (const language of moduleJson.languages) {
    const flat = flattenObject(JSON.parse(readFileSync(join(root, language.path), "utf8")));
    for (const key of usedKeys) {
      assert.equal(flat.has(`FBLQA.${key}`), true, `${language.path} should define FBLQA.${key}`);
    }
  }
});

test("condition templates referenced by constants exist", () => {
  const source = readFileSync(join(root, "scripts/conditions/constants.js"), "utf8");
  const paths = [...source.matchAll(/templates\/conditions\/[^`"']+\.hbs/g)]
    .map((match) => match[0]);
  assert.ok(paths.length > 0, "condition template paths should be found");
  for (const path of paths) assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
});

test("STAT template keeps its CSS scope and read-only state classes", () => {
  const template = readFileSync(join(root, "templates/conditions/stat-tab.hbs"), "utf8");
  assert.match(template, /class="[^"]*\bfblec-stat-tab\b/);
  assert.match(template, /\{\{#unless editable\}\}fblec-readonly\{\{\/unless\}\}/);
});

test("compact Gear removes gaps without losing the pinned consumables track", () => {
  const css = readFileSync(join(root, "styles/01-core.css"), "utf8");
  const compactRootRules = findCssRules(css, (selector) => /^\.gear-tab\.fblqa-compacted$/.test(selector));
  assert.ok(compactRootRules.some((rule) => hasExactDeclaration(rule, "gap", "0 !important")));
  assert.ok(compactRootRules.some((rule) => hasExactDeclaration(rule, "grid-template-rows", "auto minmax(0, 1fr) auto !important")));
  assert.ok(compactRootRules.some((rule) => hasExactDeclaration(rule, "align-content", "stretch !important")));

  const compactGearRules = findCssRules(css, (selector) => /\.fblqa-compacted\s*>\s*(?:section\.)?gears$/.test(selector));
  assert.ok(compactGearRules.some((rule) => hasExactDeclaration(rule, "padding-bottom", "0 !important")));

  const compactConsumableRules = findCssRules(css, (selector) => /\.fblqa-compacted\s*>\s*\.consumables$/.test(selector));
  assert.ok(compactConsumableRules.some((rule) => hasExactDeclaration(rule, "align-self", "end !important")));
});

test("wallet summary is tooltip-only and does not occupy wallet layout", () => {
  const wallet = readFileSync(join(root, "scripts/wallet.js"), "utf8");
  assert.match(wallet, /buildWalletSummaryTooltip\(actor\)/);
  assert.doesNotMatch(wallet, /popover\.append\(buildWalletSummary/);
  assert.doesNotMatch(wallet, /currencies\.append\(buildWalletSummary/);
});

test("Expanded Conditions localization covers scripts and templates", () => {
  const usedKeys = collectExpandedConditionLocalizationKeys();
  assert.ok(usedKeys.size > 0, "Expanded Conditions localization keys should be found");

  for (const language of moduleJson.languages) {
    const flat = flattenObject(JSON.parse(readFileSync(join(root, language.path), "utf8")));
    for (const key of usedKeys) assert.equal(flat.has(key), true, `${language.path} should define ${key}`);
  }
});

test("English localization and condition templates do not contain raw Cyrillic UI text", () => {
  const english = JSON.parse(readFileSync(join(root, "lang/en.json"), "utf8"));
  for (const [key, value] of flattenObject(english)) {
    if (typeof value === "string") assert.doesNotMatch(value, /[А-Яа-яЁё]/, `${key} should be English`);
  }

  for (const file of collectFiles(join(root, "templates/conditions"), ".hbs")) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /[А-Яа-яЁё]/, `${file} should use localization keys`);
  }
});

test("Foundry v13 rolls do not use the legacy async evaluate option", () => {
  for (const file of collectScriptFiles(join(root, "scripts"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.evaluate\(\s*\{[^}]*async\s*:/s, `${file} should await Roll.evaluate() without async option`);
  }
});

test("Expanded Conditions controllers do not reintroduce raw Cyrillic UI strings", () => {
  const allowMechanicalAliases = new Set([
    "condition-definitions.js",
    "special-counters.js",
    "wash.js",
    "utils.js",
    "stat-tab-renderer.js"
  ]);
  for (const file of collectScriptFiles(join(root, "scripts/conditions"))) {
    if (allowMechanicalAliases.has(file.split(/[\/]/).at(-1))) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /[А-Яа-яЁё]/, `${file} should use localization keys`);
  }
});

function collectUsedLocalizationKeys() {
  const keys = new Set();
  for (const file of collectScriptFiles(join(root, "scripts"))) {
    const source = readFileSync(file, "utf8");
    const regex = /qaLocalize\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = regex.exec(source))) keys.add(match[1]);
  }
  return keys;
}

function collectScriptFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".js")) result.push(path);
  }
  return result;
}

function flattenObject(object, prefix = "", output = new Map()) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, path, output);
    } else {
      output.set(path, value);
    }
  }
  return output;
}

function collectExpandedConditionLocalizationKeys() {
  const keys = new Set();
  for (const file of collectScriptFiles(join(root, "scripts/conditions"))) {
    const source = readFileSync(file, "utf8");
    const regex = /\blocalize\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = regex.exec(source))) keys.add(match[1].startsWith("FBLEC.") ? match[1] : `FBLEC.${match[1]}`);
  }
  for (const file of collectFiles(join(root, "templates/conditions"), ".hbs")) {
    const source = readFileSync(file, "utf8");
    const regex = /\{\{localize\s+["']([^"']+)["']/g;
    let match;
    while ((match = regex.exec(source))) keys.add(match[1]);
  }
  for (let value = 0; value <= 4; value += 1) keys.add(`FBLEC.Chat.Heat.Check${value}`);
  return keys;
}

function collectFiles(directory, extension) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(path, extension));
    else if (entry.isFile() && path.endsWith(extension)) result.push(path);
  }
  return result;
}
