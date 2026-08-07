# Forbidden Lands Quick Access

## Version 1.7.23

- Applies verified PR #11 review fixes: protects GM-only new-day provider summaries from player-controlled suppression, preserves in-flight BIO/Pilgrim save ordering across remounts, reports failed wash cleanup as a failed transition, guards duplicate BIO mounting in the same render pass, bounds automatic multi-day simulation by default, and closes stale GM progression summaries.
- Keeps Calendaria public `getCurrentDateTime()` handling 1-indexed as required by Calendaria 1.0.17; only raw `calendaria.dayChange` components are converted from zero-based fields.

## Version 1.7.21

- Fixes STAT duration controls inheriting/stretching against Foundry/system form widths. Injury and custom-condition timers are now content-sized and pinned to the right-side control cluster while the condition name owns the flexible space.
- Hardens the `- / duration / +` controls with explicit intrinsic widths and preserves the separate wrapping behavior of the two-column STAT layout.

## Version 1.7.20

- Fixes BIO failing to mount when legacy `air-islands-character-importer` data exists but that module is disabled or no longer installed. Foundry v13 throws for `Actor#getFlag` calls against inactive flag scopes; Quick Access now reads persisted legacy importer flags directly and only calls `getFlag` when that module is actually active.
- Missing or stale importer data is now treated as an optional migration source and can never abort BIO rendering.

## Version 1.7.19

- Fixes BIO mounting isolation: the redesigned BIO now renders through its own actor-sheet hook and rechecks itself when the BIO tab is opened, so failures in unrelated sheet enhancements cannot leave the native Forbidden Lands BIO behind.
- Fixes a Calendaria startup race: an enabled Calendaria module is no longer reported as unavailable while its `CalendarManager` is still initializing; Quick Access waits for `calendaria.ready` and reuses the API supplied by that hook.
- Adds a world-level **State progression** setting with mutually exclusive **Long Rest** and **Calendaria — new day** modes.
- Calendaria integration is event-driven through `calendaria.dayChange`; Quick Access does not poll world time or scan actors in the background.
- Calendaria mode processes only `character` Actors assigned through `user.character` to non-GM users. NPCs, monsters and GM-only characters are ignored.
- A normal new calendar day opens the New Day selection only for the affected player, while the deterministic active GM receives one live group summary. Calendar-driven results do not create Quick Access chat cards or Addiction roll messages.
- Offline players remain visible as pending in the GM summary. Closing the player window postpones progression instead of silently consuming the day; the GM can resolve it later.
- The GM summary can mark a pending character **Absent** for the current accumulated calendar batch. Those days are recorded as intentionally skipped without changing the character states, with an Undo action while the calendar remains on the same date.
- Multi-day Calendaria jumps require one GM confirmation and are simulated sequentially. Calendar rewind never reverses states or replays already processed days.
- Switching to Calendaria baselines every assigned player character at the current date, preventing retroactive catch-up. If Calendaria is unavailable while selected, state progression pauses rather than falling back to Long Rest.
- Stores one per-character calendar marker for idempotency and reconnect recovery; no recurring timers or periodic world writes are introduced.

## Version 1.7.16

- Fixes New Day submission in Foundry v13 when DialogV2 exposes its native form before the restored `fblqa-new-day-form` CSS class is visible. The workflow now falls back to the dialog's single native form instead of aborting Rest progression.
- Separates Pilgrim Card data into its own `pilgrimCardProfile` Actor flag. Existing card values are snapshotted once on first open after upgrade; later changes to the card never rename the Actor or update Forbidden Lands BIO fields, and later sheet edits never overwrite the saved card.

- Fixes BIO language-level selects snapping back on the first choice by isolating module-owned controls from the parent Forbidden Lands sheet form and persisting discrete choices immediately.
- Pilgrim Card Hair now fills the complete final row in the compact two-column card layout.
- Removes the duplicate black dot from the Long Rest / Short Rest selector while retaining the existing selected-state styling.
- New Day now reads checked actions from the native DialogV2 button form, restoring injury, wash, custom-condition and addiction progression after a Long Rest that starts a new day.
- STAT rendering is read-only again: migrations no longer write embedded Item data during sheet render, preventing update/delete races when wash state changes. Explicit wash transitions also suppress the exclusivity hook for their own create-cleanup sequence.

- Fixes the Reputation ledger failing to open after its footer Close button was removed. Buttonless Reputation windows now use an inert DialogV2 compatibility sentinel while the footer itself stays hidden.
- Adds a calendar button to the Pilgrim Card title bar for editing the character birth date directly from the card.
- Enlarges the APPROVED stamp into a prominent double-ring document seal.
- Rebuilds the Long Rest / Short Rest selector with module-scoped circular radio controls and DOM-state-driven pane switching. Rest submission reads the native DialogV2 button form directly, so changing rest type and applying either rest no longer depends on wrapper-class restoration.
- Makes the Rest window close control explicitly black in both DialogV2 and legacy fallback shells.
- Makes the language Level control reserve room for Foundry's dropdown arrow, reduces the Cost/delete tracks, and gives the remaining width back to Name.
- Applies all still-valid CodeRabbit findings from pull request #9: backslash URL normalization, immediate BIO dirty tracking, the dirty-value fallback test, bounded socket-retry polling with cleanup, read-only rumor-grid collapse, and direct DialogV2 Reputation regression coverage.

## Version 1.7.13

- Removes the footer Close button from the Reputation ledger and restores a light Foundry/Forbidden Lands-style window header.
- Removes rumor source/name data from the BIO UI and normalized profile model; rumor rows now contain only the rumor text and remove control.
- Makes each language Level select reserve only the width needed by its visible label/value; the Name field receives all remaining row width.
- Preserves existing BIO rich text when Foundry mounts or saves the ProseMirror editor, while still allowing intentional replacement and deletion.
- Restores deterministic Long Rest completion: updates finish first, the Rest dialog closes, and the New Day progression dialog opens afterward when selected.
- Restores DialogV2 form metadata and styling for Rest, New Day, money transfer, and Reputation windows.
- Makes BIO controls and rich-editor content inherit the active Forbidden Lands sheet font.
- Replaces an already-visible item tooltip immediately when the pointer moves directly to another supported item.
- Restores the native Reputation header control as an accessible trigger for the Reputation ledger.
- Applies all valid CodeRabbit findings from pull request #8, including socket-proof timing/retries/cleanup, request-id normalization, protocol-relative URL rejection, DialogV2 footer coverage, focus treatment, and targeted regression tests.

## 1.7.11

- Authenticates player-to-GM integration calls and wallet-transfer offers, decisions, and results with one-time proofs stored on the sending User document. Socket packets no longer trust claimed user ids by themselves.
- Applies both sides of an accepted wallet transfer through one `Actor.updateDocuments` batch, avoiding the former sequential partial-update and rollback path.
- Sanitizes BIO rich text before persistence and display, and sanitizes enriched tooltip HTML before inserting it into the DOM.
- Cleans up BIO observers, viewport listeners, animation frames, and deleted-actor state during rerender and teardown.
- Replaces private application `_state` and `_element` access with public Foundry v13 application properties.
- Routes production dialogs through the Foundry v13 `DialogV2` API, with a compatibility fallback only for non-v13 test environments.
- Prevents transfer submit/close and accept/close races from producing duplicate or contradictory transfer decisions.
- Makes filled Quick Access slots single-click and keyboard operable, adds accessible labels and tooltip descriptions, enlarges the remove target, and adapts the slot grid to narrow sheet widths.
- Keeps the BIO editor fixes from 1.7.10: one wrapped editing layer, intrinsic toolbar height, and compact native ProseMirror controls.

## 1.6.2

- Added public import helpers for structured Reputation entries.
- Added public import helpers for the selected Kin and Professional talents used by the start-Willpower rule.
- Published `capabilities.characterImport` for feature detection.

Small quality-of-life module for the Forbidden Lands system in Foundry VTT v13.

## Compatibility

- Foundry VTT target: v13.351.
- Forbidden Lands system target: v13.0.5.
- Optional integration: `fl-firearms`, through its public API only.
- Optional integration: `item-piles`, through `game.itempiles.API.giveItem(item)` when available.
- The former `forbidden-lands-expanded-conditions` module should be disabled after installing this integrated version.

## Features

- Compact top row on the character Gear tab.
- Quick Access slots based on `Agility max + Sleight of Hand`, capped at 10.
- Quick Access accepts only actor-owned `weapon`, `armor`, `gear`, and `rawMaterial` items with weight Normal or lighter.
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

## Stored data

The module does not edit Forbidden Lands system files. It patches rendered sheets and stores only module-specific UI data.

Actor flags:

- `flags.fbl-quick-access.slots`
- `flags.fbl-quick-access.gearOrder`
- `flags.fbl-quick-access.compactDecorativeBorders`
- `flags.fbl-quick-access.willpowerTalents`
- `flags.fbl-quick-access.shortRestRecovery`
- `flags.fbl-quick-access.biographyProfile`
- `flags.fbl-quick-access.pilgrimCardProfile`
- `flags.fbl-quick-access.stateProgressionCalendaria` (per-player-character Calendaria baseline/last processed date)
- `flags.fbl-quick-access.conditions.*` for the integrated STAT tab and Expanded Conditions data

Client-side `localStorage`:

- `fblqa.gearCardView.<actor>`
- `fblqa.walletExpanded.<actor>`


## House-rule Rest

The module intercepts the native Forbidden Lands Rest button on the character sheet and opens a custom Rest dialog.

Long Rest is treated as 6 hours of sleep. It restores 1 point of each damaged attribute unless that attribute is blocked by conditions. Hungry blocks Strength, Thirsty blocks Agility, Sleepy blocks Wits, and Cold blocks Strength and Wits. Sleepy is cleared at the end of Long Rest. Cold is cleared at the end only when the heat-source checkbox is enabled. Blocked attributes do not recover during that same rest even if the condition is cleared at the end.

Daily state progression is controlled by the world-level **State progression** setting. In **Long Rest** mode, Long Rest has the familiar **starts a new day** checkbox and opens the separate New Day preview after a successful rest. In **Calendaria — new day** mode that checkbox is removed: Long Rest never advances daily states, and Quick Access listens to Calendaria's `calendaria.dayChange` hook instead.

The New Day plan proposes daily changes for injury healing timers, day-based lethal limits, wash-state progression, timed custom STAT conditions, Addiction morning checks and Addiction cycle progression. It also resets the module's Short Rest recovery lock. Every action is individually selectable during a normal single-day player prompt. Heat, Mor, ARC entries, permanent timers, dice formulas, and non-day lethal limits are not advanced automatically.

Calendaria mode handles only `character` Actors assigned to non-GM users through `user.character`. Each online player receives only the prompt/result for their own character. The deterministic active GM receives one live summary for the group. Quick Access suppresses its New Day chat card, Addiction roll/chat output, wash notifications and provider private-summary chat while processing calendar-driven days. Registered New Day providers receive `context.suppressChat === true` so integrations can suppress their own presentation as well.

No polling is used. The module sleeps until Calendaria emits a day-change hook. A per-Actor marker records the processed calendar date, making normal reload/reconnect and duplicate hook delivery idempotent. A multi-day jump is confirmed once by the GM and then simulated day-by-day; a backwards calendar move never rolls states back. Switching into Calendaria mode sets the current date as the baseline instead of processing old calendar history.

Short Rest is treated as a 15 minute breather. It can be used for extended actions outside this module. Once per Quarter Day, the actor may restore 1 point in one damaged and unblocked attribute if the player enters an appropriate consumable or justification. The module records the once-per-Quarter-Day use in an actor flag and uses Foundry world time in 6-hour blocks when available. A manual reset checkbox is included for tables that do not advance world time. It is GM-only by default; a world setting can allow actor owners to use it.

The module does not automatically spend food, water, smoking supplies, drugs, potions, or other custom consumables. Those are often represented differently across worlds and companion modules. It updates the attribute and writes the selected justification to the chat result.


## Integrated Expanded Conditions / STAT tab

Quick Access now includes the functionality of the former `forbidden-lands-expanded-conditions` module. The old module should be disabled to avoid duplicate STAT tabs and duplicate handlers.

Existing actor and item data is migrated by the GM on `ready`. Legacy flags under `flags.forbidden-lands-expanded-conditions` are copied into `flags.fbl-quick-access.conditions.*`, then the old flag scope is removed from those documents. Legacy world settings are copied from the old world setting keys into Quick Access settings.

The first integrated release intentionally keeps the Expanded Conditions UI and CSS mostly intact. It is mounted as a separate subsystem under `scripts/conditions`, `templates/conditions`, and `styles/11-expanded-conditions.css` so the old behavior can be verified before deeper visual refactoring.

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

The visible dossier contains Pride, Dark Secret, Background, Family, motivation, party connections, languages, character questions, and rumors. Concept and the public Note remain accepted by the import API for backward compatibility but are not displayed in BIO; the native NOTE tab remains the place for public information. Rumor truth is not stored or displayed by Quick Access.

All multiline dossier fields use Foundry's native `<prose-mirror>` editor, including its formatting and explicit save workflow. Legacy Face, Body, and Clothing values are not shown as active editing fields. Existing non-empty values are available through an explicit archive toggle, including actors that already had an older Quick Access biography profile flag. Archive text is selectable and each field also has a copy button.

## Public API

The module exposes data-oriented helpers at:

```js
const api = game.modules.get("fbl-quick-access")?.api;
```

Available methods in 1.7.23:

- `refreshGearPresentation(app, actor?, gearTab?)`
- `registerStatProvider(definition)`
- `registerNewDayProvider(definition)`
- `refreshStat(appOrActor)`
- `getActiveGM(users?)`
- `executeAsActiveGM(operation, payload?, options?)`
- `registerSocketHandler(operation, handler)`
- `getQuickAccessSlots(actor)`
- `setQuickAccessSlots(actor, slots)`
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
- `getWillpowerTalents(actor)`
- `saveWillpowerTalents(actor, talents, options?)`
- `pruneActorReferences(actor)`
- `pruneWorldActorReferences()`

Use `api.capabilities` to detect provider, active-GM, and character-import support. Data helpers operate on Actor documents and plain data; the `open*` and presentation helpers also accept Foundry application or sheet context. The full provider and importer contracts are documented in `INTEGRATION_API.md`.

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
