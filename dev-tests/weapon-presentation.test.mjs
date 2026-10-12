import test from "node:test";
import assert from "node:assert/strict";
import {getHeldItemPresentation} from "../scripts/integration/weapon-presentation.js";

function fixture() {
  globalThis.CONFIG = {fbl: {}};
  globalThis.CONST = {DOCUMENT_OWNERSHIP_LEVELS: {OBSERVER: 2}};
  globalThis.game = {user: {id: "player"}, modules: new Map(), i18n: {localize: key => key}};
  const gun = {id: "gun", uuid: "Actor.pc.Item.gun", name: "Gun", type: "weapon",
    system: {bonus: {value: 2, max: 3}, damage: 3, range: "long", grip: "2h", features: {edged: true}},
    getRollData: () => ({artifactDie: "d8"})};
  const flags = {equipmentHands: {left: "gun", right: "gun"}, slots: ["gun"]};
  const actor = {documentName: "Actor", type: "character", uuid: "Actor.pc", isOwner: true,
    items: new Map([[gun.id, gun]]), system: {attribute: {agility: {max: 2}}},
    getFlag: (_m, key) => flags[key], testUserPermission: () => false};
  return {actor, gun, flags};
}

test("one detached row for a two-handed Item, current gear bonus and native properties", () => {
  const f = fixture(), data = getHeldItemPresentation(f.actor);
  assert.equal(data.items.length, 1);
  assert.deepEqual([data.items[0].hand, data.items[0].bonus, data.items[0].damage, data.items[0].range, data.items[0].artifact], ["both", 2, 3, "Long", "d8"]);
  assert.equal(data.items[0].features[0].key, "edged");
  data.items[0].features[0].label = "changed";
  assert.equal(f.gun.system.features.edged, true);
  assert.equal(getHeldItemPresentation(f.actor).items[0].name, "Gun");
});
test("changing the category invalidates a native slow-reload weapon revision", () => {
  const f = fixture(); f.gun.system.features.slowReload = true; f.gun.system.category = "ranged";
  const before = getHeldItemPresentation(f.actor).items[0];
  assert.equal(before.reload, true);
  f.gun.system.category = "melee";
  const after = getHeldItemPresentation(f.actor).items[0];
  assert.equal(after.reload, false); assert.notEqual(after.revision, before.revision);
});
test("observers can read, private characters cannot; missing/inactive firearms preserve native data", () => {
  const f = fixture(); f.actor.isOwner = false;
  assert.throws(() => getHeldItemPresentation(f.actor), /permission/i);
  f.actor.testUserPermission = () => true;
  assert.equal(getHeldItemPresentation(f.actor).editable, false);
  game.modules.set("fl-firearms", {active: false, api: {getFirearmTooltipData() {throw new Error("must not run");}}});
  assert.equal(getHeldItemPresentation(f.actor).items[0].firearm, null);
});
test("magazine uses the normalized API getter, keeps property order and manual flags", () => {
  const f = fixture();
  game.modules.set("fl-firearms", {active: true, api: {
    getFirearmTooltipData: () => ({isFirearm: true, reloadType: "MAG", magCurrent: 6, magCapacity: 6, apOp: "*", apValue: 0.5,
      features: [{key: "Rapid", label: "Rapid", hasInput: true, value: 2, automated: false}, {key: "TopOff", label: "TopOff", automated: true}]}),
    getMagazineProfile: () => ({current: 0, capacity: 6}), loadMagazine() {}, topOffMagazine() {},
  }});
  const item = getHeldItemPresentation(f.actor).items[0];
  assert.deepEqual(item.firearm.magazine, {current: 0, capacity: 6});
  assert.deepEqual(item.firearm.features.map(feature => feature.key), ["Rapid", "TopOff"]);
  assert.equal(item.firearm.features[0].automated, false);
  assert.equal(item.firearm.features[0].value, "2");
  assert.equal(item.firearm.topOff, true);
});
test("nonmagazine weapons do not invent loaded ammo; Item edits change weapon revision", () => {
  const f = fixture();
  game.modules.set("fl-firearms", {active: true, api: {getFirearmTooltipData: () => ({isFirearm: true, reloadType: "Slow", reloadValue: "2"})}});
  const before = getHeldItemPresentation(f.actor).items[0];
  assert.equal(before.firearm.magazine, null); assert.equal(before.reload, true);
  f.gun.system.bonus.value = 1;
  assert.notEqual(getHeldItemPresentation(f.actor).items[0].revision, before.revision);
});
test("optional API exceptions and broken roll data fail safely without writes", () => {
  const f = fixture(), warn = console.warn; console.warn = () => {};
  try {
    game.modules.set("fl-firearms", {active: true, api: {getFirearmTooltipData() {throw new Error("broken integration");}}});
    f.gun.getRollData = () => {throw new Error("broken Item");};
    const item = getHeldItemPresentation(f.actor).items[0];
    assert.equal(item.firearm, null); assert.equal(item.attack, false); assert.equal(item.broken, true);
  } finally {console.warn = warn;}
});
test("private tooltip journals do not leak property descriptions", () => {
  const f = fixture();
  game.journal = [{name: "Rich Info Tooltips", testUserPermission: () => false}];
  game.modules.set("fl-firearms", {active: true, api: {getFirearmTooltipData: () => ({isFirearm: true,
    features: [{key: "Reliable", label: "Reliable", descriptionHtml: "GM secret"}]})}});
  assert.equal(getHeldItemPresentation(f.actor).items[0].firearm.features[0].description, "");
});
test("the player's revision matches the GM across locales and journal/page permissions", () => {
  const f = fixture();
  const journal = {name: "Rich Info Tooltips", testUserPermission: () => false,
    pages: [{name: "Reliable", testUserPermission: () => false}]};
  game.journal = [journal];
  game.modules.set("fl-firearms", {active: true, api: {getFirearmTooltipData: () => ({isFirearm: true,
    features: [{key: "Reliable", label: "Reliable", descriptionHtml: "Journal description"}]})}});
  const player = getHeldItemPresentation(f.actor).items[0];
  game.i18n.localize = () => "Translated for GM"; journal.testUserPermission = () => true;
  assert.equal(getHeldItemPresentation(f.actor).items[0].firearm.features[0].description, "");
  journal.pages[0].testUserPermission = () => true;
  const gm = getHeldItemPresentation(f.actor).items[0];
  assert.equal(gm.firearm.features[0].description, "Journal description");
  assert.equal(gm.revision, player.revision);
});
