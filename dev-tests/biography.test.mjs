import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBiographyProfile, getPilgrimCardProfile, normalizeBiographyProfile, normalizePilgrimCardProfile, resolveBiographyEditorValue, savePilgrimCardProfile } from "../scripts/biography.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizes imported biography rows while keeping rumor truth out of the visible row model", () => {
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
    text: "Боится механизмов",
    truth: "true"
  });
  assert.equal("name" in profile.rumors[0], false);
});

test("keeps legacy BIO archive and tolerates old string rumors", () => {
  const profile = normalizeBiographyProfile({
    rumors: ["Старый слух"],
    legacy: { face: "<p>Face text</p>", body: "Body text", clothing: "Clothing text" }
  });

  assert.equal("name" in profile.rumors[0], false);
  assert.equal(profile.rumors[0].text, "Старый слух");
  assert.equal(profile.rumors[0].truth, "uncertain");
  assert.equal(profile.legacy.face, "<p>Face text</p>");
  assert.equal(profile.legacy.body, "Body text");
});

test("normalizes invalid rumor truth to uncertain without exposing a source field", () => {
  const profile = normalizeBiographyProfile({
    rumors: [{ id: "r1", name: "Скрытый источник", text: "Слух", truth: "maybe" }]
  });

  assert.deepEqual(profile.rumors[0], { id: "r1", text: "Слух", truth: "uncertain" });
  assert.equal("name" in profile.rumors[0], false);
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

test("BIO migration tolerates an inactive legacy importer flag scope", () => {
  const actor = {
    name: "Legacy Actor",
    flags: {
      "air-islands-character-importer": {
        profile: { biography: { concept: "Imported concept" } }
      }
    },
    getFlag(moduleId) {
      if (moduleId === "fbl-quick-access") return null;
      throw new Error(`Flag scope "${moduleId}" is not valid or not currently active`);
    },
    system: { bio: {} }
  };

  const profile = getBiographyProfile(actor);
  assert.equal(profile.concept, "Imported concept");
});

test("BIO renders without legacy importer data when the importer scope is inactive", () => {
  const actor = {
    name: "Plain Actor",
    getFlag(moduleId) {
      if (moduleId === "fbl-quick-access") return null;
      throw new Error(`Flag scope "${moduleId}" is not valid or not currently active`);
    },
    system: { bio: { kin: { value: "Human" } } }
  };

  assert.doesNotThrow(() => getBiographyProfile(actor));
  assert.equal(getBiographyProfile(actor).identity.kin, "Human");
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
  assert.equal("Source" in ru.FBLQA.Bio.Rumors, false);
  assert.equal("Source" in en.FBLQA.Bio.Rumors, false);
  assert.equal("SourcePlaceholder" in ru.FBLQA.Bio.Rumors, false);
  assert.equal("SourcePlaceholder" in en.FBLQA.Bio.Rumors, false);
  assert.doesNotMatch(source, /rumors\.\$\{index\}\.name/);
  assert.doesNotMatch(source, /fblqa-rumor-source/);
  assert.equal(ru.FBLQA.Bio.Fields.Pride, "Гордость");
  assert.equal(en.FBLQA.Bio.Fields.Pride, "Pride");
});

test("language level column is content-sized and rumor rows contain text only", () => {
  const source = readFileSync(join(root, "scripts", "biography.js"), "utf8");
  const css = readFileSync(join(root, "styles", "13-biography.css"), "utf8");

  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) var\(--fblqa-language-level-width, max-content\) 40px 18px/);
  assert.match(source, /updateLanguageLevelWidth\(row\)/);
  assert.match(source, /measureControlText\(select, optionText\)/);
  assert.match(source, /Math\.max\(28, number\(style\?\.paddingRight\)\)/);
  assert.match(css, /\.fblqa-language-level select\s*\{[\s\S]*?padding-right:\s*28px/);
  assert.match(css, /\.fblqa-rumor-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /\.fblqa-rumor-row\.is-editable\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 18px/);
  assert.doesNotMatch(source, /data-bio-path="rumors\.\$\{index\}\.name"/);
});

test("BIO editor preserves stored rich text until the user actually changes it", () => {
  const source = readFileSync(join(root, "scripts", "biography.js"), "utf8");
  const original = "<p><strong>Старый текст</strong></p>";

  assert.doesNotMatch(source, /let editorReady|if \(!editorReady\) return/);
  assert.doesNotMatch(source, /target\.closest\?\.\("\.ProseMirror, \[contenteditable='true'\], prose-mirror"\)/);
  assert.match(source, /shell\.addEventListener\("input", markDirty, true\)/);
  assert.match(source, /shell\.addEventListener\("change", markDirty, true\)/);

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

  assert.equal(resolveBiographyEditorValue({
    originalValue: original,
    propertyValue: "<p>Из свойства</p>",
    attributeValue: original,
    editableHtml: null,
    dirty: true
  }), "<p>Из свойства</p>");
});

test("public integration API exposes the independent Pilgrim Card profile helpers", () => {
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");
  const apiDoc = readFileSync(join(root, "INTEGRATION_API.md"), "utf8");

  assert.match(main, /pilgrimCardProfile:\s*true/);
  assert.match(main, /getPilgrimCardProfile,/);
  assert.match(main, /savePilgrimCardProfile,/);
  assert.match(apiDoc, /qa\.savePilgrimCardProfile\(actor/);
  assert.match(apiDoc, /truth.*persisted/s);
});

test("Pilgrim Card exposes birth-date editing in its header and uses a full-size stamp", () => {
  const source = readFileSync(join(root, "scripts", "biography.js"), "utf8");
  const css = readFileSync(join(root, "styles", "13-biography.css"), "utf8");

  assert.match(source, /data-bio-action="edit-birth-date"/);
  assert.match(source, /data-pilgrim-birth-editor/);
  assert.match(source, /setupPilgrimBirthDateEditor\(drawer, actor, cardState, editable\)/);
  assert.match(css, /\.fblqa-pilgrim-card::after\s*\{[\s\S]*?width:\s*98px;[\s\S]*?height:\s*98px;[\s\S]*?border:\s*4px double/);
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


test("Pilgrim Card is stored independently from Actor name and Forbidden Lands BIO fields", async () => {
  const storedCard = normalizePilgrimCardProfile({
    identity: { name: "Имя в карте", kin: "Human", issuingCountry: "Нованд", birthDate: "7 Хладохода 844" },
    physical: { hair: "Black", appearance: "Card-only appearance" }
  });
  const actor = {
    id: "pilgrim-independent",
    name: "Имя на листе",
    system: { bio: { kin: { value: "Elf" }, profession: { value: "Hunter" } } },
    getFlag(moduleId, key) {
      if (moduleId === "fbl-quick-access" && key === "pilgrimCardProfile") return storedCard;
      return null;
    },
    updates: [],
    async update(data, options) { this.updates.push({ data, options }); }
  };

  const card = getPilgrimCardProfile(actor);
  assert.equal(card.identity.name, "Имя в карте");
  assert.equal(card.identity.kin, "Human");
  assert.equal(card.physical.appearance, "Card-only appearance");

  card.identity.name = "Новое имя только в карте";
  await savePilgrimCardProfile(actor, card, { render: false });

  assert.equal(actor.updates.length, 1);
  assert.deepEqual(Object.keys(actor.updates[0].data), ["flags.fbl-quick-access.pilgrimCardProfile"]);
  assert.equal(actor.updates[0].data["flags.fbl-quick-access.pilgrimCardProfile"].identity.name, "Новое имя только в карте");
  assert.equal("name" in actor.updates[0].data, false);
  assert.equal(Object.keys(actor.updates[0].data).some((key) => key.startsWith("system.bio.")), false);
  assert.deepEqual(actor.updates[0].options, { render: false });
});

test("Pilgrim Card migration snapshots the old card values once, then stored card wins over later sheet edits", () => {
  let storedCard = null;
  const actor = {
    id: "pilgrim-migration",
    name: "Sheet Name A",
    system: { bio: { kin: { value: "Human" }, profession: { value: "Rogue" } } },
    getFlag(moduleId, key) {
      if (moduleId === "fbl-quick-access" && key === "pilgrimCardProfile") return storedCard;
      if (moduleId === "fbl-quick-access" && key === "biographyProfile") return null;
      return null;
    }
  };
  const biographySnapshot = normalizeBiographyProfile({
    identity: { name: "Sheet Name A", kin: "Human", kinVariant: "Variant A", issuingCountry: "Country A" },
    physical: { eyes: "Grey" }
  });

  const initial = getPilgrimCardProfile(actor, biographySnapshot);
  assert.equal(initial.identity.name, "Sheet Name A");
  assert.equal(initial.identity.kinVariant, "Variant A");

  storedCard = structuredClone(initial);
  actor.name = "Sheet Name B";
  actor.system.bio.kin.value = "Elf";
  const afterSheetEdit = getPilgrimCardProfile(actor, normalizeBiographyProfile({
    identity: { name: "Sheet Name B", kin: "Elf", kinVariant: "Variant B" }
  }));

  assert.equal(afterSheetEdit.identity.name, "Sheet Name A");
  assert.equal(afterSheetEdit.identity.kin, "Human");
  assert.equal(afterSheetEdit.identity.kinVariant, "Variant A");
});

test("BIO mounts through its own actor-sheet hook and self-heals on BIO tab activation", () => {
  const main = readFileSync(join(root, "scripts", "main.js"), "utf8");

  assert.match(main, /Hooks\.on\("renderActorSheet", renderBiographySafely\)/);
  assert.match(main, /Hooks\.on\("renderApplicationV2", renderBiographySafely\)/);
  assert.match(main, /function renderBiographySafely\([\s\S]*?setupBiographyTab\(app, actor, root\)/);
  assert.match(main, /function setupBiographyActivationGuard\([\s\S]*?data-tab="bio"[\s\S]*?fblqaBiographyMounted[\s\S]*?queueMicrotask\(ensureMounted\)/);

  const quickAccessBody = main.match(/function renderQuickAccess\([\s\S]*?\n}\n\nfunction renderBiographySafely/)?.[0] ?? "";
  assert.doesNotMatch(quickAccessBody, /setupBiographyTab\(/);
});
