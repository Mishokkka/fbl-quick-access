import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBiographyProfile } from "../scripts/biography.js";

test("normalizes imported biography rows", () => {
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
  assert.equal(profile.rumors[0].name, "Ничак");
  assert.equal(profile.rumors[0].text, "Боится механизмов");
});

test("keeps legacy BIO archive and tolerates old string rumors", () => {
  const profile = normalizeBiographyProfile({
    rumors: ["Старый слух"],
    legacy: { face: "Face text", body: "Body text", clothing: "Clothing text" }
  });

  assert.equal(profile.rumors[0].name, "");
  assert.equal(profile.rumors[0].text, "Старый слух");
  assert.equal(profile.legacy.body, "Body text");
});
