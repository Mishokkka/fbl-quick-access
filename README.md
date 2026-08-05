# Forbidden Lands Quick Access Gear


## 1.6.2

- Added public import helpers for structured Reputation entries.
- Added public import helpers for the selected Kin and Professional talents used by the start-Willpower rule.
- Published `capabilities.characterImport` for feature detection.

Small quality-of-life module for the Forbidden Lands system in Foundry VTT v13.

## Compatibility

- Foundry VTT: v13, verified on v13.351.
- Forbidden Lands system: v13.0.5.
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
- The native Rest button is replaced with a house-rule Rest dialog: Long Rest and Short Rest. Long Rest can optionally continue into a separate New Day assistant.
- Transfer uses Item Piles when active, opening its item-specific give/transfer dialog.
- Double-clicking supported item rows opens the embedded item sheet.
- Compact optional Main-tab restyling scoped to the character sheet.
- Per-actor decorative-border toggle near CONDITIONS on the Main tab.
- Borderless item sheets.
- Start-of-session Willpower helper using a manually selected Kin Talent and Professional Talent.
- Integrated Expanded Conditions STAT tab from the former `forbidden-lands-expanded-conditions` module.

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
- `flags.fbl-quick-access.conditions.*` for the integrated STAT tab and Expanded Conditions data

Client-side `localStorage`:

- `fblqa.gearCardView.<actor>`
- `fblqa.walletExpanded.<actor>`


## House-rule Rest

The module intercepts the native Forbidden Lands Rest button on the character sheet and opens a custom Rest dialog.

Long Rest is treated as 6 hours of sleep. It restores 1 point of each damaged attribute unless that attribute is blocked by conditions. Hungry blocks Strength, Thirsty blocks Agility, Sleepy blocks Wits, and Cold blocks Strength and Wits. Sleepy is cleared at the end of Long Rest. Cold is cleared at the end only when the heat-source checkbox is enabled. Blocked attributes do not recover during that same rest even if the condition is cleared at the end.

Long Rest has an optional **starts a new day** checkbox. After a successful rest, it opens a separate preview window. That window proposes daily changes for injury healing timers, day-based lethal limits, wash-state progression, timed custom STAT conditions, Addiction morning checks and Addiction cycle progression. It also resets the module's Short Rest recovery lock. Every action is individually selectable. Heat, Mor, ARC entries, permanent timers, dice formulas, and non-day lethal limits are not advanced automatically.

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


## Public API

The module exposes data-oriented helpers at:

```js
const api = game.modules.get("fbl-quick-access")?.api;
```

Available methods in 1.5.7:

- `refreshGearPresentation(app, actor?, gearTab?)`
- `getQuickAccessSlots(actor)`
- `setQuickAccessSlots(actor, slots)`
- `openRestDialog(app, actor, root?)`
- `openNewDayDialog(app, actor)`
- `buildNewDayPlan(actor)`
- `openMoneyTransferDialog(app, actor)`
- `pruneActorReferences(actor)`
- `pruneWorldActorReferences()`

Only `refreshGearPresentation` accepts sheet DOM context. The other methods operate on documents and data so macros and companion modules do not need to parse the sheet.

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
