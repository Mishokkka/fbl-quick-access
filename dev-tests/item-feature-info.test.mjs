import test from 'node:test';
import assert from 'node:assert/strict';
import { getItemFeatureInfo } from '../scripts/item-feature-info.js';
import { buildItemFeatureTooltipHtml } from '../scripts/item-utils.js';

function fixture() {
  const page = {name: 'Edged', text: {content: '<p>Rule from journal</p>'}, isOwner: false, testUserPermission: () => true};
  const journal = {name: 'Rich Info Tooltips', pages: [page], testUserPermission: () => true};
  globalThis.CONST = {DOCUMENT_OWNERSHIP_LEVELS: {OBSERVER: 2}};
  globalThis.game = {user: {}, journal: [journal], modules: new Map(), i18n: {localize: key => key}};
  const item = {type: 'weapon', isOwner: true, system: {features: {edged: true, others: '@INFO[Изящное]'}}};
  return {page, journal, item};
}
test('native property rules resolve across journal languages and missing descriptions stay empty', () => {
  const f = fixture();
  assert.equal(getItemFeatureInfo(f.item, 'edged').html, '<p>Rule from journal</p>');
  f.page.name = 'Режущее'; assert.equal(getItemFeatureInfo(f.item, 'edged').html, f.page.text.content);
  f.page.name = 'Different'; assert.equal(getItemFeatureInfo(f.item, 'edged').html, '');
  assert.equal(getItemFeatureInfo(f.item, 'pointed'), null);
});
test('private journal or page never provides property text, including firearm API descriptions', () => {
  const f = fixture();
  game.modules.set('fl-firearms', {active: true, api: {getFirearmTooltipData: () => ({isFirearm: true, features: [{key: 'Reliable', label: 'Reliable', descriptionHtml: 'secret'}]})}});
  f.page.name = 'Reliable'; delete f.page.text;
  assert.equal(getItemFeatureInfo(f.item, 'Reliable').html, 'secret');
  f.page.testUserPermission = () => false; assert.equal(getItemFeatureInfo(f.item, 'Reliable').html, '');
  f.page.testUserPermission = () => true; f.journal.testUserPermission = () => false;
  assert.equal(getItemFeatureInfo(f.item, 'Reliable').html, '');
});
test('property tooltip uses rich enrichment relative to its source with source-specific secret permission', async () => {
  const f = fixture(), calls = [];
  globalThis.TextEditor = {enrichHTML: async (text, options) => {calls.push({text, options}); return '<a>enriched</a>';}};
  globalThis.foundry = {utils: {cleanHTML: html => html}};
  try {
    assert.match(await buildItemFeatureTooltipHtml(f.item, 'edged'), /enriched/);
    assert.equal(calls[0].options.relativeTo, f.page); assert.equal(calls[0].options.secrets, false);
    await buildItemFeatureTooltipHtml(f.item, 'others');
    assert.equal(calls[1].text, '@INFO[Изящное]'); assert.equal(calls[1].options.relativeTo, f.item);
    assert.equal(await buildItemFeatureTooltipHtml(f.item, 'unknown'), '');
  } finally {delete globalThis.TextEditor; delete globalThis.foundry;}
});

test('malformed optional firearm feature data stays unavailable', () => {
  const f = fixture();
  game.modules.set('fl-firearms', {active:true, api:{getFirearmTooltipData:()=>({isFirearm:true, features:'invalid'})}});
  assert.equal(getItemFeatureInfo(f.item, 'Reliable'), null);
});
