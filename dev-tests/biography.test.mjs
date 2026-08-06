import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBiographyProfile, normalizeBiographyProfile } from "../scripts/biography.js";

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

test("BIO layout matches the requested localized compact one-column design", () => {
  const source = readFileSync(join(root, "scripts", "biography.js"), "utf8");
  const settings = readFileSync(join(root, "scripts", "settings.js"), "utf8");
  const css = readFileSync(join(root, "styles", "13-biography.css"), "utf8");
  const ru = JSON.parse(readFileSync(join(root, "lang", "ru.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "lang", "en.json"), "utf8"));

  assert.match(source, /data-bio-rich-control/);
  assert.match(source, /document\.createElement\("prose-mirror"\)/);
  assert.match(source, /<p><br><\/p>/);
  assert.match(source, /bindSectionToggles/);
  assert.match(source, /data-bio-action="toggle-section"/);
  assert.match(source, /Bio\.Questions\.Title/);
  assert.match(source, /is-subheading/);
  assert.match(source, /captureNativePrideRoll/);
  assert.match(source, /fblqa-native-pride-roll-source/);
  assert.match(source, /proxy\.innerHTML = '<i class="fa-solid fa-dice-d20"><\/i>'/);
  assert.match(source, /actionBeforeTitle:\s*true/);
  assert.match(source, /data-bio-action="archive"/);
  assert.match(source, /data-bio-path="rumors\.\$\{index\}\.text"/);
  assert.match(source, /data-bio-archive hidden/);
  assert.match(source, /game\?\.clipboard\?\.copyPlainText/);
  assert.match(source, /data-bio-selectable/);
  assert.match(source, /data-pilgrim-drag/);
  assert.match(source, /toggle-pilgrim-attachment/);
  assert.match(source, /getPilgrimCardFontFamily/);
  assert.match(source, /applyPilgrimCardFont/);
  assert.match(source, /fblqa-pilgrim-serial/);
  assert.match(source, /fieldTextarea\("physical\.appearance"/);
  assert.match(source, /fieldTextarea\("physical\.distinguishingMarks"/);
  assert.match(source, /fblqa-pilgrim-hair/);
  assert.match(source, /data-bio-autosize/);
  assert.match(source, /setupFloatingBiographyActions/);
  assert.match(source, /ACTIVE_RICH_EDITORS/);
  assert.match(source, /activateRichEditor/);
  assert.match(source, /fblqa-rich-preview/);
  assert.match(source, /editor\.addEventListener\("open"/);
  assert.match(source, /estimateRichEditorHeight/);
  assert.doesNotMatch(source, /EDITOR_OBSERVERS/);
  assert.doesNotMatch(source, /EDITOR_RESIZE_FRAMES/);
  assert.doesNotMatch(source, /scheduleEditorResize/);
  assert.match(source, /commitActiveRichEditor/);
  assert.match(source, /setupLanguageLayout/);
  assert.match(source, /applyLanguageLayout/);
  assert.match(source, /captureBiographyViewport/);
  assert.match(source, /restoreBiographyViewport/);
  assert.match(source, /BIO_SCROLL_POSITIONS/);
  assert.match(source, /profile\.legacy\.face \|\|= actorBioHtml/);
  assert.doesNotMatch(source, /data-bio-action="reputation"/);
  assert.doesNotMatch(source, /fblqa-bio-header/);
  assert.doesNotMatch(source, /fieldEditor\(actor, "concept"/);
  assert.doesNotMatch(source, /fieldEditor\(actor, "publicNote"/);
  assert.doesNotMatch(source, /fblqa-rumor-truth/);
  assert.doesNotMatch(source, /fblqa-native-field/);
  assert.doesNotMatch(source, /data-bio-path="languages\.\$\{index\}\.native"/);
  assert.doesNotMatch(source, /Bio\.Pilgrim\.AirIslands/);
  assert.doesNotMatch(source, /<img[^>]+alt="Портрет"/);
  assert.match(source, /physical\.distinguishingMarks[\s\S]*fblqa-pilgrim-marks/);

  assert.match(settings, /SETTINGS\.PILGRIM_CARD_FONT/);
  assert.match(settings, /CONFIG\?\.fontDefinitions/);
  assert.match(settings, /getAvailableFontChoices/);
  assert.match(settings, /game\?\.settings\?\.get\?\.\("core", "fonts"\)/);
  assert.match(settings, /document\?\.fonts/);
  assert.match(settings, /refreshPilgrimFontChoices/);
  assert.match(settings, /resolveFoundryFontFamily/);
  assert.match(settings, /style\.setProperty\("font-family", stack, "important"\)/);
  assert.match(settings, /choices:\s*getFoundryFontChoices\(\)/);

  assert.match(css, /\.fblqa-bio-stack,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.fblqa-bio-block,[\s\S]*?border:\s*0;/);
  assert.match(css, /\.fblqa-bio-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?background:\s*transparent;/);
  assert.doesNotMatch(css, /\.fblqa-bio-actions\s*\{[\s\S]*?position:\s*sticky;/);
  assert.match(css, /\.fblqa-language-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.fblqa-language-row\.is-wide\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(css, /\.fblqa-language-level select\s*\{[\s\S]*?padding-right:\s*24px;/);
  assert.match(css, /\.fblqa-pilgrim-card textarea\s*\{[\s\S]*?min-height:\s*22px;[\s\S]*?resize:\s*none;/);
  assert.match(css, /\.fblqa-pride-roll\s*\{[\s\S]*?width:\s*31px;[\s\S]*?font-size:\s*17px;/);
  assert.match(css, /\.fblqa-rich-preview\s*\{[\s\S]*?min-height:\s*25px/);
  assert.match(css, /\.fblqa-rich-editor-shell prose-mirror\s*\{[\s\S]*?height:\s*var\(--fblqa-editor-height/);
  assert.match(css, /\.fblqa-legacy-content,[\s\S]*?user-select:\s*text !important;/);
  assert.match(css, /\.fblqa-pilgrim-card input,[\s\S]*?font-family:\s*var\(--fblqa-pilgrim-font/);
  assert.match(css, /fblqa-rich-editor-shell prose-mirror \.ProseMirror,[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(css, /fblqa-rich-preview\[hidden\][\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /fblqa-rich-editor-shell prose-mirror \.editor-container[\s\S]*?height:\s*100%/);
  assert.match(css, /fblqa-rich-editor-shell prose-mirror menu,[\s\S]*?min-height:\s*34px;[\s\S]*?max-height:\s*68px/);
  assert.doesNotMatch(css, /prose-mirror > div:first-of-type/);
  assert.match(css, /fblqa-rich-editor-shell prose-mirror > \.editor-content[\s\S]*?display:\s*none/);
  assert.match(css, /\.fblqa-pilgrim-details > \.fblqa-pilgrim-hair\s*\{[\s\S]*?grid-column:\s*span 4;/);
  assert.match(css, /overflow-anchor:\s*none/);
  assert.match(css, /\.fblqa-pilgrim-windowbar/);
  assert.match(css, /\.fblqa-pilgrim-drawer\.is-dragging/);
  assert.doesNotMatch(css, /\.fblqa-bio-columns/);

  assert.equal(ru.FBLQA.Bio.Fields.Pride, "Гордость");
  assert.equal(ru.FBLQA.Bio.Questions.Title, "Ответы на вопросы");
  assert.equal(ru.FBLQA.Bio.Pilgrim.Stamp, "ПОДТВЕРЖДЕНО");
  assert.equal(ru.FBLQA.Settings.PilgrimCardFont.Name, "Шрифт Карты пилигрима");
  assert.equal(en.FBLQA.Bio.Fields.Pride, "Pride");
  assert.equal(en.FBLQA.Bio.Questions.Title, "Answers to Questions");
  assert.equal(en.FBLQA.Bio.Pilgrim.Stamp, "APPROVED");
  assert.equal(en.FBLQA.Settings.PilgrimCardFont.Name, "Pilgrim Card font");
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
