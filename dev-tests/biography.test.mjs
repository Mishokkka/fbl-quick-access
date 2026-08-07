import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBiographyProfile, normalizeBiographyProfile, resolveBiographyEditorValue } from "../scripts/biography.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizes imported biography rows without exposing rumor truth", () => {
  const profile = normalizeBiographyProfile({
    identity: { name: "Люсьен", subrace: "Конквист", citizenship: "Сангрен" },
    appearance: "Высокий полуэльф",
    languages: [{ languageId: "damian", name: "Дамийский", level: "full", learningCost: 2, native: false }],
    rumors: [{ characterName: "Ничак", rumor: "Боится механизмов", truth: "true" }]
  });

  assert.equal(profile.version, 1);
  assert.equal(profile.identity.kinVariant, "Конквист");
  assert.equal(profile.identity.issuingCountry, "Сангрен");
  assert.equal(profile.physical.appearance, "Высокий полуэльф");
  assert.deepEqual(profile.languages[0], {
    id: profile.languages[0].id,
    languageId: "damian",
    name: "Дамийский",
    level: "full",
    cost: 2,
    native: false
  });
  assert.deepEqual(profile.rumors[0], {
    id: profile.rumors[0].id,
    name: "Ничак",
    text: "Боится механизмов"
  });
});

test("keeps legacy BIO archive and tolerates old string rumors", () => {
  const profile = normalizeBiographyProfile({
    rumors: ["Старый слух"],
    legacy: { face: "<p>Face text</p>", body: "Body text", clothing: "Clothing text" }
  });

  assert.equal(profile.rumors[0].name, "");
  assert.equal(profile.rumors[0].text, "Старый слух");
  assert.equal(profile.legacy.face, "<p>Face text</p>");
  assert.equal(profile.legacy.body, "Body text");
});

test("backfills legacy BIO fields even when a stored profile already exists", () => {
  const actor = {
    name: "Люсьен",
    getFlag: () => ({ pride: "<p>Гордость</p>", legacy: {} }),
    system: {
      bio: {
        kin: { value: "Human" },
        profession: { value: "Rogue" },
        face: { value: "<p><strong>Лицо</strong></p>" },
        body: { value: "<p>Тело</p>" },
        clothing: { value: "<p>Одежда</p>" }
      }
    }
  };

  const profile = getBiographyProfile(actor);
  assert.equal(profile.legacy.face, "<p><strong>Лицо</strong></p>");
  assert.equal(profile.legacy.body, "<p>Тело</p>");
  assert.equal(profile.legacy.clothing, "<p>Одежда</p>");
});

test("targets BIO only and never falls back to NOTE", async () => {
  const { findBiographyTab, findNoteTab } = await import("../scripts/sheet-adapter/forbidden-lands-v1.js");
  const bio = { id: "bio" };
  const note = { id: "note" };
  const root = {
    querySelector(selector) {
      if (selector === '.sheet-body > .tab[data-tab="bio"]') return bio;
      if (selector === '.sheet-body > .tab[data-tab="note"]') return note;
      return null;
    }
  };

  assert.equal(findBiographyTab(root), bio);
  assert.equal(findNoteTab(root), note);

  const biographySelectors = [];
  const noteOnlyRoot = {
    querySelector(selector) {
      biographySelectors.push(selector);
      return selector.includes('data-tab="note"') ? note : null;
    }
  };
  assert.equal(findBiographyTab(noteOnlyRoot), null);
  assert.equal(biographySelectors.some((selector) => selector.includes('data-tab="note"') || selector.includes("note-tab")), false);
});

test("BIO localization and removed controls match the current data model", () => {
  const source = readFileSync(join(root, "scripts", "biography.js"), "utf8");
  const ru = JSON.parse(readFileSync(join(root, "lang", "ru.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "lang", "en.json"), "utf8"));

  assert.doesNotMatch(source, /data-bio-path="languages\.\$\{index\}\.native"/);
  assert.doesNotMatch(source, /fblqa-rumor-truth/);
  assert.doesNotMatch(source, /Bio\.Pilgrim\.AirIslands/);
  assert.equal("Native" in ru.FBLQA.Bio.Languages, false);
  assert.equal("Native" in en.FBLQA.Bio.Languages, false);
  assert.equal("AirIslands" in ru.FBLQA.Bio.Pilgrim, false);
  assert.equal("AirIslands" in en.FBLQA.Bio.Pilgrim, false);
  assert.equal(ru.FBLQA.Bio.Rumors.Source, "Имя или источник");
  assert.equal(en.FBLQA.Bio.Rumors.Source, "Name or source");
  assert.equal(ru.FBLQA.Bio.Fields.Pride, "Гордость");
  assert.equal(en.FBLQA.Bio.Fields.Pride, "Pride");
});

test("BIO editor preserves stored rich text until the user actually changes it", () => {
  const original = "<p><strong>Старый текст</strong></p>";

  assert.equal(resolveBiographyEditorValue({
    originalValue: original,
    propertyValue: "",
    attributeValue: original,
    editableHtml: "<p><br></p>",
    dirty: false
  }), original);

  assert.equal(resolveBiographyEditorValue({
    originalValue: original,
    propertyValue: "",
    attributeValue: "",
    editableHtml: "<p><br></p>",
    dirty: false
  }), original);
});

test("BIO editor accepts new text and intentional deletion after a user edit", () => {
  const original = "<p>Старый текст</p>";
  assert.equal(resolveBiographyEditorValue({
    originalValue: original,
    propertyValue: original,
    attributeValue: original,
    editableHtml: "<p>Новый текст</p>",
    dirty: true
  }), "<p>Новый текст</p>");

  assert.equal(resolveBiographyEditorValue({
    originalValue: original,
    propertyValue: original,
    attributeValue: original,
    editableHtml: "",
    dirty: true
  }), "");
});

test("font choices include Foundry, world-configured, and already loaded families", async () => {
  const previous = {
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    game: globalThis.game,
    document: globalThis.document
  };

  try {
    globalThis.foundry = {
      applications: {
        settings: {
          menus: {
            FontConfig: {
              getAvailableFontChoices: () => ({ "World Serif": "World Serif" }),
              getAvailableFonts: () => ["Loaded Sans"]
            }
          }
        }
      }
    };
    globalThis.CONFIG = {
      fontDefinitions: { "Module Hand": { editor: true, fonts: [] } },
      defaultFontFamily: "Default Face"
    };
    globalThis.game = {
      settings: {
        get(namespace, key) {
          if (namespace === "core" && key === "fonts") return { "Custom Script": { editor: true, fonts: [] } };
          if (namespace === "fbl-quick-access" && key === "pilgrimCardFont") return "Chosen Face";
          return null;
        }
      }
    };
    globalThis.document = { fonts: [{ family: '"Browser Face"' }] };

    const { getFoundryFontChoices } = await import("../scripts/settings.js");
    const choices = getFoundryFontChoices();
    for (const family of ["World Serif", "Loaded Sans", "Module Hand", "Default Face", "Custom Script", "Chosen Face", "Browser Face"]) {
      assert.equal(choices[family], family);
    }
  } finally {
    globalThis.foundry = previous.foundry;
    globalThis.CONFIG = previous.CONFIG;
    globalThis.game = previous.game;
    globalThis.document = previous.document;
  }
});


test("Pilgrim font labels resolve to the actual Foundry family key", async () => {
  const previous = { foundry: globalThis.foundry, CONFIG: globalThis.CONFIG, game: globalThis.game };
  try {
    globalThis.foundry = {
      applications: { settings: { menus: { FontConfig: {
        getAvailableFontChoices: () => ({ "actual-family": "Readable Label" }),
        getAvailableFonts: () => []
      } } } }
    };
    globalThis.CONFIG = {};
    globalThis.game = { settings: { get: () => "Readable Label" } };
    const { getPilgrimCardFontFamily, getFoundryFontChoices } = await import(`../scripts/settings.js?label-resolution=${Date.now()}`);
    assert.equal(getPilgrimCardFontFamily(), "actual-family");
    assert.equal(getFoundryFontChoices()["actual-family"], "Readable Label");
    assert.equal(getFoundryFontChoices()["Readable Label"], undefined);
  } finally {
    globalThis.foundry = previous.foundry;
    globalThis.CONFIG = previous.CONFIG;
    globalThis.game = previous.game;
  }
});
