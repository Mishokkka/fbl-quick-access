# Forbidden Lands Quick Access
Version 1.7.35
Quality-of-life module for the Forbidden Lands system in Foundry VTT v13.

## Compatibility

- Foundry VTT target: v13.351.
- Forbidden Lands system target: v13.0.5.
- Optional integration: `fl-firearms`, through its public API only.
- Optional integration: `item-piles`, through `game.itempiles.API.giveItem(item)` when available.
- Optional integration: `yze-combat-permission-fix` 1.3.0 for compact equipment controls and explicit action costs. The legacy 1.2.x bridge remains compatible. Neither module requires the other.
- The former `forbidden-lands-expanded-conditions` module should be disabled after installing this integrated version.

## Features

- Compact top row on the character Gear tab.
- Quick Access slots based on `Agility max + Sleight of Hand`, capped at 10.
- Quick Access accepts only actor-owned `weapon`, `armor`, `gear`, and `rawMaterial` items with weight Normal or lighter.
- Left/right/two-handed grip badges synchronized with the optional YZE widget. Preview, assignment/reordering, bounded durable receipts and safe undo through equipment API v1.
- Widget 1.7.0 can take carried weapon/gear Items directly from inventory, including heavy unslotted Items. This uses separate inventory grips; quick-slot weight and capacity rules stay intact.
- Widget property tooltips reuse rich text/@INFO enrichment and the Rich Info Tooltips journal used by FL Firearms, with journal/page visibility checks and a fixed dark tooltip palette.
- Compact encumbrance counter with overload highlight.
- Wallet popover and optional expanded currency line for Gold / Silver / Copper, with direct player-to-player denomination transfer.
- Wallet arithmetic supports direct values, expressions such as `10-2`, and relative operations such as `+5` or `-13`.
- Item tooltip with Main-tab stats, rich-text item fields, and optional `fl-firearms` section.
- Item tooltips on Gear, Combat, Talent, and Spell rows where the system exposes actor-owned item data.
- Optional Gear card view. Gear edit, post-to-chat, duplicate, delete, and Item Piles transfer actions are available through a right-click context menu.
- Manual Gear ordering inside the current Gear section.
- Right-clicking Gear rows or Gear cards opens a compact light context menu: Edit, Post to Chat, Duplicate, Delete, Transfer. The Delete trash icon is red, and Delete uses a styled confirmation dialog.
- The native Rest button is replaced with a house-rule Rest dialog: Long Rest and Short Rest. A world setting chooses whether daily state progression is triggered by Long Rest or by Calendaria new-day events.
- Transfer uses Item Piles when active, opening its item-specific give/transfer dialog.
- Double-clicking supported item rows opens the embedded item sheet.
- Compact optional Main-tab restyling scoped to the character sheet.
- Per-actor decorative-border toggle near CONDITIONS on the Main tab.
- Borderless item sheets.
- Start-of-session Willpower helper using a manually selected Kin Talent and Professional Talent.
- Integrated Expanded Conditions STAT tab from the former `forbidden-lands-expanded-conditions` module.
- Redesigned BIO tab with a compact one-column dossier, native Foundry rich-text editors, a copyable legacy BIO archive, and an attached or detachable editable Pilgrim Card.
- Structured language and rumor rows with add/remove controls; imported language learning costs remain visible.

## Wallet behavior

The wallet intentionally preserves separate denominations. It does **not** automatically normalize every operation into the fewest possible coins, because coin quantity can matter for encumbrance and table logistics.

Examples:

- Typing `15` in Silver keeps `15 СМ`.
- Clicking `+` on Copper adds one copper coin and does not convert copper into silver.
- Clicking `−` on a denomination first reduces that exact denomination literally. If Copper is `11`, clicking `−` on Copper changes it to `10 ММ`, not `1 СМ`.
- Relative negative input behaves the same way when possible. If Copper is `11`, typing `-1` in Copper changes it to `10 ММ`.
- The wallet makes change only when the selected denomination cannot cover the expense. If Copper is `0` and Silver is `3`, clicking `−` on Copper can change the wallet to `2 СМ 9 ММ`.
- If the total wallet cannot cover the operation, the operation is cancelled and the wallet shows an insufficient funds message.

So: direct edits and ordinary +/- changes preserve the visible denomination. Spending makes change only when it has to.

With an active GM, wallet changes and transfers share a single authority queue. Owner-only play without a GM remains available, with per-client serialization. Direct writes by other modules are outside this queue.

Reputation pools are limited to 1,000 points as a technical safeguard. Finite legacy/imported amounts above the limit remain visible at their original values. A warning blocks rolls and saves until the amounts are explicitly corrected; unrelated edits cannot silently remove those rows. Invalid values are rejected on save; existing malformed flags are not rewritten during rendering.

## Stored data

The module does not edit Forbidden Lands system files. It patches rendered sheets, stores module flags, and updates Actor/Item gameplay data when an authorized operation is applied.

Actor flags:

- `flags.fbl-quick-access.slots`
- `flags.fbl-quick-access.gearOrder`
- `flags.fbl-quick-access.compactDecorativeBorders`
- `flags.fbl-quick-access.willpowerTalents`
- `flags.fbl-quick-access.shortRestRecovery`
- `flags.fbl-quick-access.biographyProfile`
- `flags.fbl-quick-access.pilgrimCardProfile`
- `flags.fbl-quick-access.stateProgressionFailures` (up to 100 failed daily-action records; identifiers and dates only)
- `flags.fbl-quick-access.stateProgressionCalendaria` (per-player-character Calendaria baseline/last processed date)
- `flags.fbl-quick-access.conditions.*` for the integrated STAT tab and Expanded Conditions data

Client-side `localStorage`:

- `fblqa.gearCardView.<actor>`
- `fblqa.walletExpanded.<actor>`


## House-rule Rest

The module intercepts the native Forbidden Lands Rest button on the character sheet and opens a custom Rest dialog.

Long Rest is treated as 6 hours of sleep. It restores 1 point of each damaged attribute unless that attribute is blocked by conditions. Hungry blocks Strength, Thirsty blocks Agility, Sleepy blocks Wits, and Cold blocks Strength and Wits. Sleepy is cleared at the end of Long Rest. Cold is cleared at the end only when the heat-source checkbox is enabled. Blocked attributes do not recover during that same rest even if the condition is cleared at the end.

Daily state progression is controlled by the world-level **State progression** setting. In **Long Rest** mode, Long Rest has the familiar **starts a new day** checkbox and opens the separate New Day preview after a successful rest. In **Calendaria — new day** mode that checkbox is removed: Long Rest never advances daily states, and Quick Access listens to Calendaria's `calendaria.dayChange` hook instead.

The New Day plan proposes daily changes for injury healing timers, day-based lethal limits, wash-state progression, timed custom STAT conditions, Addiction morning checks and Addiction cycle progression. It also resets the module's Short Rest recovery lock. Every action is individually selectable during a normal single-day player prompt. Heat, Mor, ARC entries, permanent timers, dice formulas, and non-day lethal limits are not advanced automatically. An unresolved Addiction Endurance blocks the next daily plan, including provider actions, until its outcome is recorded in STAT.

Calendaria mode handles only `character` Actors assigned to non-GM users through `user.character`. Each online player receives only the prompt/result for their own character. The deterministic active GM receives one live summary for the group. Quick Access suppresses its New Day chat card, Addiction roll/chat output, wash notifications and provider private-summary chat while processing calendar-driven days. Registered New Day providers receive `context.suppressChat === true` so integrations can suppress their own presentation as well.

No polling is used. The module sleeps until Calendaria emits a day-change hook. A per-Actor marker records the processed calendar date, making normal reload/reconnect and duplicate hook delivery idempotent. A multi-day jump is confirmed once by the GM and then simulated day-by-day; a backwards calendar move never rolls states back. Addiction can stop that simulation at a manual Endurance: the started day's other changes remain applied once, while later days stay pending. Record the outcome in STAT, then resume remaining days from the GM summary. Switching into Calendaria mode sets the current date as the baseline instead of processing old calendar history.

Short Rest is treated as a 15 minute breather. It can be used for extended actions outside this module. Once per Quarter Day, the actor may restore 1 point in one damaged and unblocked attribute if the player enters an appropriate consumable or justification. The module records the once-per-Quarter-Day use in an actor flag and uses Foundry world time in 6-hour blocks when available. A manual reset checkbox is included for tables that do not advance world time. It is GM-only by default; a world setting can allow actor owners to use it.

The module does not automatically spend food, water, smoking supplies, drugs, potions, or other custom consumables. Those are often represented differently across worlds and companion modules. It updates the attribute and writes the selected justification to the chat result.


## Integrated Expanded Conditions / STAT tab

Quick Access now includes the functionality of the former `forbidden-lands-expanded-conditions` module. The old module should be disabled to avoid duplicate STAT tabs and duplicate handlers.

Existing actor and item data is migrated by the GM on `ready`. Legacy flags under `flags.forbidden-lands-expanded-conditions` are copied into `flags.fbl-quick-access.conditions.*`, then the old flag scope is removed from those documents. Legacy world settings are copied from the old world setting keys into Quick Access settings.

The first integrated release intentionally keeps the Expanded Conditions UI and CSS mostly intact. It is mounted as a separate subsystem under `scripts/conditions`, `templates/conditions`, and `styles/11-expanded-conditions.css` so the old behavior can be verified before deeper visual refactoring.

Addiction uses one persisted morning across STAT and New Day. A controlled craving result (3+) advances automatically; 1–2 or withdrawal waits for a manual Endurance roll. Apply talents, abilities and any rerolls before choosing **Endurance: success** or **Endurance: failure**. Success advances the cycle. Failure asks whether a dose is available: taking it resets decline d12, while failure without a dose still advances the cycle. Withdrawal days and attribute modifiers remain unchanged until this decision. Morning records survive reopening/reloading and prevent another roll of the same morning. With an active GM, player actions use the GM's per-Item queue; otherwise they use the local queue. Long Rest uses explicit numbered New Days, while Calendaria uses the actual processed date.

Heat rises when the player presses **+** after a final manual Endurance failure; the GM sets check frequency. Failure at levels 0/1 raises the level without damage, 2 → 3 deals 1 Strength damage, 3 → 4 deals 1 Strength and 1 Wits damage, and a further failure at 4 keeps 4/4 and deals 1 damage each to Strength, Wits and Agility. Level 4 applies −1 to Endurance and Move automatically. **−** reduces Heat by 1 and removes those penalties below 4; it neither damages nor heals attributes. Type a level (0–4) directly into the counter to correct it without damage. The book button expands/collapses the rules locally without sending anything to chat. Migration 8 adds the owned level-4 modifiers to existing Heat Items without changing their level or attributes.

Heat and Addiction keep their controls in compact headers. Click the name/icon to expand or collapse descriptions, current modifiers and daily details. Addiction **−/+** move the cycle backward/forward without rolling or automatically deleting a recovered Item; clicking the phase/die opens an editor for phase, die, withdrawal days and severity. These manual corrections synchronize modifiers and replace any pending morning result, so that a later click cannot apply the old result again.

## item-piles integration

If `item-piles` is active and exposes `game.itempiles.API.giveItem(item)`, the Gear context menu's **Transfer** action opens Item Piles' item-specific give dialog for the selected actor-owned item.

If that method is unavailable, the module falls back to `requestTrade()` when possible, but that fallback cannot preselect the item because Item Piles' public `requestTrade(user)` API does not accept an item argument.

## fl-firearms integration

The integration uses only:

```js
game.modules.get("fl-firearms").api.getFirearmTooltipData(item)
```

If `fl-firearms` is inactive, missing, or does not expose the method, item tooltips keep working without the firearm section. This module does not parse firearm item-sheet HTML and does not read `flags.fl-firearms` directly.


## Redesigned BIO and Pilgrim Card

The native Forbidden Lands BIO tab is replaced at render time; system templates and files are not modified. The visible dossier uses one compact column and stores structured data in `flags.fbl-quick-access.biographyProfile`.

The compact Pilgrim Card opens beside the actor sheet and contains name, kin, subrace, issuing country, birth date, overall appearance, height, weight, skin, eyes, hair, and a full-width distinguishing-marks field. It deliberately has no portrait. It follows the actor sheet while linked and can be detached into an independently draggable window. The transparent sticky BIO footer contains only the archive and Pilgrim Card controls.

The visible dossier contains Pride, Dark Secret, Background, Family, motivation, party connections, languages, character questions, and rumors. Concept remains accepted and stored for importer/GM data but is not displayed in BIO. The public Note is synchronized to the native Forbidden Lands NOTE field and is not displayed as a separate Quick Access BIO field. Rumor truth is stored as `true`, `false`, or `uncertain` but is deliberately not displayed by Quick Access; rumor source/name is not stored in the Quick Access profile.

All multiline dossier fields use Foundry's native `<prose-mirror>` editor, including its formatting and explicit save workflow. Legacy Face, Body, and Clothing values are not shown as active editing fields. Existing non-empty values are available through an explicit archive toggle, including actors that already had an older Quick Access biography profile flag. Archive text is selectable and each field also has a copy button.

## Public API

The module exposes data-oriented helpers at:

```js
const api = game.modules.get("fbl-quick-access")?.api;
```

Available methods in 1.7.35:

- `refreshGearPresentation(app, actor?, gearTab?)`
- `setupTalentItemTooltips(actor, root)`
- `registerStatProvider(definition)`
- `registerNewDayProvider(definition)`
- `refreshStat(appOrActor)`
- `getActiveGM(users?)`
- `executeAsActiveGM(operation, payload?, options?)`
- `registerSocketHandler(operation, handler)`
- `getQuickAccessSlots(actor)`
- `setQuickAccessSlots(actor, slots)`
- `getEquipmentState(actor)`
- `performEquipmentAction(actor, command, options?)`
- `openRestDialog(app, actor, root?)`
- `openNewDayDialog(app, actor)`
- `buildNewDayPlan(actor)`
- `buildNewDayPlanWithProviders(actor)`
- `getStateProgressionMode()`
- `openMoneyTransferDialog(app, actor)`
- `getReputationEntries(actor)`
- `saveReputationEntries(actor, entries, options?)`
- `openReputationDialog(app, actor)`
- `getBiographyProfile(actor)`
- `saveBiographyProfile(actor, profile, options?)`
- `getPilgrimCardProfile(actor, fallbackBiography?)`
- `savePilgrimCardProfile(actor, profile, options?)`
- `getWillpowerTalents(actor)`
- `saveWillpowerTalents(actor, talents, options?)`
- `pruneActorReferences(actor)`
- `pruneWorldActorReferences()`

Use `api.capabilities` to detect provider, active-GM, character-import, biography-profile, and Pilgrim-Card-profile support. Data helpers operate on Actor documents and plain data; the `open*` and presentation helpers also accept Foundry application or sheet context. The full provider and importer contracts are documented in `INTEGRATION_API.md`.

## Known limitations

- The module currently targets `character` actor sheets. NPC and monster sheets are intentionally not modified.
- The module works by patching rendered sheet DOM. It is deliberately non-invasive, but large template changes in the Forbidden Lands system may require selector updates.
- Gear card view and manual Gear ordering require a stable item id in the rendered row. Name fallback is used only when a row name resolves to exactly one embedded item. Duplicate item names are ignored for safety.
- The Willpower label hook supports `Willpower` and `Сила воли`. If a custom sheet renames the field differently, the label selector may need another alias.

## 1.1.0

- Added a styled right-click Gear context menu for actor-owned Gear rows and Gear cards.
- Added context actions: Edit, Delete, Transfer.
- Removed visible edit/delete controls from Gear cards and hid native Gear edit/delete controls in table mode; the actions now live in the context menu.
- Added optional Item Piles transfer integration through `game.itempiles.API.giveItem(item)` with guarded fallbacks for missing/older APIs.
- Added context-menu styling and localization keys.
- Kept double-click-to-open and drag/drop Gear ordering behavior intact.

## 1.0.0

- Refactored the CSS layer and promoted the module to the stable 1.0.0 line.
- Added `styles/00-tokens.css` for shared module color/border variables.
- Folded the old Gear-card adjustment layer back into `styles/04-gear-cards.css` and removed `styles/07-gear-card-adjustments.css`.
- Rewrote tooltip, Gear-card, wallet, decorative-border, and Prosthetics compatibility CSS into current-state rules instead of stacked historical overrides.
- Changed compact decorative-border mode to remove frame lines entirely instead of drawing replacement borders.
- Reduced `!important` markers from 548 to 196 while keeping them on high-risk system override zones such as `.border`, hidden source rows, native Gear headers, and item-sheet frame cleanup.
- Added CSS quality tests to prevent the override budget and legacy adjustment/final files from creeping back in.
- Marked actor and item sheet roots with `fblqa-sheet-root` plus actor/item-specific root classes for future scoped styling.

## 0.42.0

- Added a Foundry i18n scaffold with `lang/ru.json` and `lang/en.json`.
- Added `scripts/i18n.js` with safe fallback interpolation, so missing translation keys keep the existing Russian text instead of breaking UI.
- Moved the main user-facing UI labels, tooltips, warnings, wallet messages, Gear-card labels, firearm tooltip labels, and Willpower popover text to localization keys.
- Extended manifest tests to verify language files exist and referenced localization keys are present.
- Added direct tests for the localization fallback/interpolation helper.

## 0.41.0

- Split the old Gear-card `final` stylesheet into explicit feature and compatibility files.
- Added `styles/07-gear-card-adjustments.css` for late Gear-card layout refinements.
- Added `styles/09-compat-prosthetics.css` for FBL EC Prosthetics compatibility rules.
- Removed the legacy `styles/07-gear-cards-final.css` name from the module manifest.
- Added manifest tests that verify referenced scripts/styles exist, README and module versions match, and the style order stays intentional.
- Scoped decorative-border class cleanup to the current Foundry application root instead of walking toward `document.body`.

## 0.40.0

- Added a dedicated legacy Forbidden Lands sheet adapter at `scripts/sheet-adapter/forbidden-lands-v1.js`.
- Moved tab, Gear container, consumables, original Gear controls, CONDITIONS header, and sheet-header lookup into the adapter layer.
- Updated main render flow, Gear cards, Gear ordering, Gear tooltips, panel spacing, and Main-tab cleanup to use the adapter helpers instead of scattered raw selectors.
- Tightened the decorative-border toggle permission handling: non-owners now see the current state but cannot write the actor flag.
- Added a minimal Node test scaffold for pure module logic: currency parsing, wallet totals, item weights, carry-state normalization, dropped encumbrance exclusion, Quick Access capacity, Willpower calculation, and drag payload normalization.

## 0.39.0

- Added shared DOM item-row lookup helpers for Gear cards, Gear ordering, and item tooltips.
- Added shared drag/drop payload parsing with `TextEditor.getDragEventData(event)` and JSON fallbacks.
- Added shared actor permission guards and disabled non-owner mutation controls where practical.
- Debounced manual sheet refreshes to reduce duplicate render races after actor updates.
- Unified item carry-state detection for Gear ordering and encumbrance. Dropped items are no longer counted by the module encumbrance helper.
- Removed unused historical placeholders/dead exports (`styles/quick-access.css`, old Gear toggle helper, unused currency splitter).

## 0.38.2

- Restored native Forbidden Lands item dragging between Gear sections. Manual Gear ordering now keeps the drag payload compatible with the system (`type: "Item"`) and uses an internal marker only for same-section sorting.
- Added section/carry-state checks so dropping an item from Equipped to Backpack, Backpack to Equipped, or either to Dropped is left to the Forbidden Lands sheet instead of being consumed by the presentation-order handler.

## 0.38.1

- Wallet spending now preserves the selected denomination when it can. Example: `11 ММ` minus `1` becomes `10 ММ`, not `1 СМ`.
- The wallet now makes change only when the selected denomination cannot cover the expense.

## 0.38.0

- Removed duplicate V1 render-hook registration for actor and item sheets.
- Removed unnecessary async boundaries from the actor render pipeline.
- Quick Access now rejects unsupported item types instead of accepting anything with a weight field.
- Manual Gear ordering now uses a private drag payload type instead of masquerading as a normal Foundry `Item` drag.
- Gear row name fallback is now unique-only; duplicate names are ignored instead of risking actions on the wrong item.
- Tooltip rendering now re-checks the hovered anchor after async rich-text enrichment.
- Tooltip fallback text is escaped instead of injecting raw HTML if `TextEditor.enrichHTML` fails.
- Willpower selector now rejects the same talent being saved as both Kin and Professional talent.
- Willpower label search also recognizes `Сила воли`.
- CSS was split into ordered files by feature area instead of one 2000+ line stylesheet.
- README clarified that wallet denominations are intentionally preserved.

## Previous notable changes

### 0.37.0

- Clicking the `Willpower` label opens a small anchored selector for Kin Talent and Professional Talent.
- The scale button uses the saved selected talents for the start-of-session Willpower formula.
- If either talent is not selected, its rank is treated as `1`.

### 0.36.0

- Added a small Willpower button in the character sheet header.
- The button applies the table's start-of-session Willpower house rule:
  `round((currentWP + ((Empathy.max + Professional Talent rank + Kin Talent rank) / 2)) / 2)`.

### 0.35.0

- Gear card background is slightly lighter.
- Gear card bottom stats are laid out as equal-width table cells.

### 0.31.0

- Added a per-actor decorative-border toggle near CONDITIONS on the Main tab.
- Added a per-actor compact decorative-border mode near CONDITIONS on the Main tab.

### 0.28.0

- Wallet spending uses the whole wallet when making change is required.
- Insufficient funds no longer change the sheet data.

### 0.21.0

- Gear items can be reordered by drag-and-drop inside their current Gear section.
- The order is stored on the actor as `flags.fbl-quick-access.gearOrder`.

### 0.20.0

- Spell tooltips show Rank, Type, Range, Duration, Ingredients, and rich description.
- Gear tab has a client-side card/table view toggle.
- Gear card view keeps Equipped / Backpack / Dropped sections and preserves edit/delete actions.


## Changelog

### 1.7.35

- Restore compact, collapsible Heat/Addiction cards and manual cycle corrections. Keep Heat +/- functional, allow direct level correction, and expand rules locally without posting to chat.
- Normalize translation namespaces so Foundry's language loader preserves all STAT labels, including Russian buttons and ordinary injury fields.
- Add regressions for manual cycle edits, pending-check replacement, ownership and localization namespace collisions; check real button handlers with Foundry/system CSS.

### 1.7.34

- Resolve FL Firearms hover availability and rich property text through the same live, permission-checked journal lookup. Empty/stale provider descriptions and label case/spacing differences no longer prevent an available rule tooltip from being attached.
- Preserve secret-section visibility for a rule page's owner; keep those sections hidden from other readers. Rule changes never alter mechanical revisions or action costs.
- Add regressions for live rules, cached descriptions, page visibility, keyboard focus and owner-only sections.

### 1.7.33

- Add carried weapon/gear inventory grips for the companion widget, including heavy unslotted Items, through the existing owner/queue/revision/receipt/undo checks. Preserve the quick-slot eligibility rules.
- Reuse rich item-tooltip mechanics for property buttons and Other Features; resolve native and FL Firearms rules from the permission-checked Rich Info Tooltips journal.
- Add a fixed dark tooltip palette for widget anchors, while leaving character-sheet tooltips unchanged.
- Keep public API majors and existing callers compatible; cover inventory, property sources, privacy and enrichment with regressions.

### 1.7.32

- Unify Addiction mornings across STAT and New Day, persist pending manual Endurance, keep withdrawal modifiers until resolution, ask about dose availability on failure, and prevent repeat rolls/steps through the active GM when available.
- Pause calendar time skips at unresolved Addiction checks and show the pending action in player results and the GM summary, with a direct STAT shortcut.
- Separate final Heat failure from manual counter correction; apply Endurance/Move penalties only at level 4, retain the confirmed threshold/overcap damage, and expose consequences beside named action buttons.
- Add migration 8 for existing Heat modifiers and regressions for manual outcomes, day replay, calendar resume, ownership, cooling and interrupted damage recovery.

### 1.7.31

- Include native weapon category in held-item revisions so slow-reload drafts become stale after ranged/melee changes; add a regression. Companion widget 1.6.0 supports F/S/ten-second reloads and explicit manual abilities.

### 1.7.30

- Add read-only held-item presentation for YZE widget 1.5.0: native weapon stats/features, normalized optional FL Firearms data, locale-independent mechanical revisions and permission-checked plain-text descriptions.
- Preserve equipment API version 1, flags and existing callers. Weapon operations/payment live in the companion widget; magazines/ammunition remain FL Firearms-owned.
- Document the released ribbon, native attacks and configurable manual reload progress; add seven presentation regressions.

### 1.7.29

- Complete the equipment contract for YZE widget 1.3.0: previews, eligible inventory, assign/swap slots, grip changes for items removed from slots, atomic operation receipts and guarded undo.
- Add rich item tooltips for widget buttons and visible L/R/two-handed marks on the character's Quick Access bar. Refresh that bar after render-suppressed equipment writes without rebuilding the whole sheet or disturbing wallet controls.
- Preserve API major version 1 and legacy callers. Document the agreed design, recovery limits and separate future attack/consumable features.
- Add nine equipment regressions; the full suite passes 237 tests. The companion widget browser test uses these real equipment modules.

### 1.7.28

- Reject equipment commands when Foundry cancels Actor persistence instead of reporting a saved change. Preserve no-op results and allow the per-Actor queue to continue after cancellation.
- Guard optional widget state and editable permissions in integration examples; choose an eligible Quick Access slot instead of assuming the first slot is occupied.
- Add six regressions covering cancellation of all four commands, queue recovery and execution of the documented examples. API versions, slot storage and combat behavior remain unchanged.

### 1.7.27

- Add a versioned equipment snapshot/command API for the YZE action widget's future equipment controls. Keep the existing slots API and storage unchanged.
- Represent left/right/two-handed grips in an optional Actor flag. Validate ownership, current slots and item eligibility before writing; serialize commands per Actor and accept snapshot revision guards.
- Notify integrations after Actor/Item changes, including updates made with sheet rendering suppressed. No equipment UI, combat action spending, or native Item carry-state changes are introduced in this release.
- Add 12 equipment contract regression tests. See `INTEGRATION_API.md` for commands, events and concurrency limits.

### 1.7.26

- BIO retries only unsaved fields after a partial flush; preserve finite over-limit legacy reputation rows and warn before saving or rolling.

- Recheck live calendar markers and New Day preconditions before applying queued changes. Keep provider build failures pending and retain failed-action metadata.
- Keep a new Short Rest recovery lock when reset and recovery are selected together. Report chat failures separately from committed gameplay changes.
- Merge BIO autosave field patches with the live profile, explicitly flush pending edits on close, respect native BIO fields and filter/enrich rich text for the viewer.
- Make Addiction state/modifier updates a single write; retain Heat damage receipts for safe retry; reuse an existing Wash replacement after failed cleanup.
- Route wallet edits and denomination transfers through one active-GM queue; recheck transfer permissions at execution. Bound numeric operations and reputation pools.
- Persist special Item kinds, preserve renamed conditions, avoid treating disabled special conditions as ordinary injuries, and parse only resolved day durations.
- Refresh other open STAT views after suppressed renders and discard outdated asynchronous render results.
- Add behavioral reliability regressions, portable test paths, provider cleanup/privacy contracts, and the updated independent audit.

### 1.7.25

- Exposed the existing Talent/Spell item-tooltip binder through the public API as `setupTalentItemTooltips(actor, root)` with the `itemTooltips` capability flag. This lets custom character-sheet modules replace the native Talent tab and then reattach the same Quick Access tooltips without importing internal files.


### 1.3.0

- Integrated the former `forbidden-lands-expanded-conditions` module as the Quick Access STAT subsystem.
- Added migration from legacy Expanded Conditions actor/item flags and world settings.
- Added a warning when the old Expanded Conditions module is still active.
- Moved Expanded Conditions templates under `templates/conditions/` and CSS under `styles/11-expanded-conditions.css`.


### 1.2.3

- Rest dialog restyled to match the light Forbidden Lands character sheet.
- Removed the separate Current Conditions block from the dialog body.
- Moved condition chips into the dialog header and removed the visible Rest title.
- Reduced checkbox/radio control size inside the Rest dialog.

### 1.1.2

- Gear context menu deletion uses a styled confirmation dialog with localized destructive/cancel buttons.

### 1.1.1

- Gear Card view toggle refreshes the Gear presentation immediately.
- Gear context menu deletion asks for confirmation.


## 1.2.2 Rest button hard interception

- Replaced the native Forbidden Lands `.rest-up` control with a module-owned button that no longer carries the system rest selector.
- Added capture-phase event blocking for the custom Rest button so the native full-heal Rest handler cannot run alongside the house-rule Rest dialog.

## 1.2.1 Rest condition and Calendaria hardening

- Rest condition detection now prefers the exact Forbidden Lands system path `system.condition.<key>.value`, matching the sheet controls with `data-condition="sleepy"`, `thirsty`, `hungry`, and `cold`.
- The Rest subsystem also has a DOM fallback for the visible `.condition[data-condition]` controls if a future sheet variant does not expose condition data where expected.
- Short Rest Quarter Day tracking now prefers `CALENDARIA.api.getCurrentDateTime()` when Calendaria is active, then falls back to `game.time.worldTime`, then manual reset.
- The Rest dialog shows which time source is currently used for the Quarter Day lockout.

## Weapon ribbon integration (1.7.30)

YZE widget **1.5.0+** optionally reads `getHeldItemPresentation(actor)` to show grips, stats, ammo and properties in separate compact groups. It provides native attacks and manually configurable load/top-off progress with a price chosen per operation. Quick Access owns slots/grips; FL Firearms owns magazines/ammunition. Equipment API version 1 remains compatible. See [WEAPON_RIBBON_DESIGN.md](WEAPON_RIBBON_DESIGN.md).
