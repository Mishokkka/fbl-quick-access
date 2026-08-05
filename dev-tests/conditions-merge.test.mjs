import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conditionsDir = join(root, "scripts", "conditions");

test("integrated Expanded Conditions no longer uses legacy scope for active flags/settings", () => {
  const offenders = [];
  for (const file of collectJsFiles(conditionsDir)) {
    const rel = relative(root, file).replaceAll("\\\\", "/");
    const source = readFileSync(file, "utf8");
    if (rel.endsWith("constants.js") || rel.endsWith("main.js")) continue;
    if (source.includes("forbidden-lands-expanded-conditions")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "legacy module id should only appear in constants and the transition warning");
});

test("integrated Expanded Conditions stores flags under the conditions namespace", async () => {
  const constants = await import("../scripts/conditions/constants.js");
  assert.equal(constants.MODULE_ID, "fbl-quick-access");
  assert.equal(constants.LEGACY_MODULE_ID, "forbidden-lands-expanded-conditions");
  assert.equal(constants.FLAGS.LIST, "conditions.list");
  assert.equal(constants.FLAGS.ORDER, "conditions.order");
  assert.equal(constants.flagUpdatePath(constants.FLAGS.TREATMENT_STATUS), "flags.fbl-quick-access.conditions.treatmentStatus");
  assert.equal(constants.flagDeletePath(constants.FLAGS.TREATMENT_DATA), "flags.fbl-quick-access.conditions.-=treatmentData");
});


test("integrated STAT uses shared destructive confirmation and localized condition keys", () => {
  const main = readFileSync(join(root, "scripts", "conditions", "main.js"), "utf8");
  assert.match(main, /confirmDangerAction/, "STAT should use the shared styled danger dialog");
  assert.match(main, /confirmStatDelete\(item\.name, "injury"\)/, "injury deletion should ask for confirmation");
  assert.match(main, /confirmStatDelete\(conditionName, "condition"\)/, "custom condition deletion should ask for confirmation");
  assert.match(main, /layout-toggle[\s\S]*requireEditable\(\)/, "layout-column actor flag changes should require edit permission");

  const usedKeys = collectConditionLocalizationKeys();
  assert.ok(usedKeys.has("FBLEC.Delete.ConfirmTitle"));
  for (const lang of ["ru", "en"]) {
    const flat = flattenObject(JSON.parse(readFileSync(join(root, "lang", `${lang}.json`), "utf8")));
    for (const key of usedKeys) {
      assert.equal(flat.has(key), true, `lang/${lang}.json should define ${key}`);
    }
  }
});

function collectConditionLocalizationKeys() {
  const keys = new Set();
  for (const file of collectJsFiles(conditionsDir)) {
    const source = readFileSync(file, "utf8");
    const regex = /localize\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = regex.exec(source))) {
      const key = match[1].startsWith("FBLEC.") ? match[1] : `FBLEC.${match[1]}`;
      keys.add(key);
    }
  }
  return keys;
}

function flattenObject(object, prefix = "", output = new Map()) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flattenObject(value, path, output);
    else output.set(path, value);
  }
  return output;
}

function collectJsFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}
