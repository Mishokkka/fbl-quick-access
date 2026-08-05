import test from "node:test";
import assert from "node:assert/strict";

const translations = new Map([
  ["FBLQA.Test.Greeting", "Привет, {name}."]
]);

globalThis.game = {
  i18n: {
    localize: (key) => translations.get(key) ?? key
  }
};

const { qaLocalize } = await import("../scripts/i18n.js");

test("qaLocalize reads Foundry translations and interpolates placeholders", () => {
  assert.equal(qaLocalize("Test.Greeting", "fallback", { name: "Миша" }), "Привет, Миша.");
});

test("qaLocalize falls back safely when a key is missing", () => {
  assert.equal(qaLocalize("Missing.Key", "Фолбэк {value}", { value: 7 }), "Фолбэк 7");
});
