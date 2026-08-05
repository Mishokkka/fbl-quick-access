# Forbidden Lands Quick Access Gear

Version 1.6.1


## 1.6.1 - reputation presentation corrections

- Removed the redundant bottom close button from the Reputation dialog and restored automatic height after rows are added or removed.
- Added a read-only Reputation reference block to the bottom of the Note tab for every viewer of the character sheet.
- Removed the yellow header highlight.
- Simplified Reputation chat output to one recognized/not-recognized line per description without exposing individual die values.
- Half and Third checks now round the number of sampled Reputation points down.


## 1.6.0 - reputation ledger and selective checks

- Replaced the native header Reputation roll with a dedicated ledger dialog.
- Added per-entry amount, reason, location, and selection controls with a permanent empty input row.
- Reputation totals now synchronize back to `system.bio.reputation.value`; existing numeric Reputation migrates into one anonymous ledger entry on first use.
- Added full and partial Reputation checks using one d6 per selected Reputation point, with successes on 6 and a detailed chat breakdown by source.
- Added Half and Third remote checks that randomly sample individual Reputation points rather than whole rows.
- Added Russian and English localization, responsive styling, public module API methods, and focused regression tests.


## 1.5.8 - public extension-provider API

- Added a stable `module.api` bridge for external modules.
- Added ordered STAT providers with isolated markup, listener activation, refresh support, and active-GM actor-deletion cleanup.
- Added provider-driven New Day categories and actions. Provider action discovery and application run on the deterministic active GM.
- Added generic `registerSocketHandler`, `executeAsActiveGM`, and `getActiveGM` methods for permission-aware extension workflows.
- Added public/private provider summaries: public results appear in the New Day card, while private details are whispered only to GMs.
- Kept the original synchronous `buildNewDayPlan(actor)` for compatibility and added `buildNewDayPlanWithProviders(actor)` for complete plans.
- Added `INTEGRATION_API.md` with contracts and examples for dependent modules.



## 1.5.7 - recipient-confirmed wallet transfers

- Enabled the module socket namespace in `module.json`; without the manifest `socket` flag, Foundry does not relay `module.fbl-quick-access` packets between clients.
- Replaced silent GM approval with an explicit confirmation dialog on the receiving player client.
- The recipient can accept or decline the offer before any wallet data changes.
- Accepted offers are validated and executed by the primary active GM, preserving permission checks and denomination-specific balances.
- Added final private chat whispers to the sender and recipient with both characters, the exact coin amounts, and the completed, declined, expired, or failed status.
- Increased the response window from 15 seconds to 90 seconds and report recipient timeout separately from transport timeout.
- Added packet deduplication so locally handled socket packets are not processed twice if the server echoes them back to the sender.
- Only active player-owned characters are offered as transfer recipients.
- Added transfer-protocol regression coverage; the suite now contains 64 passing tests.

## 1.5.6 - stable STAT editing, Gear actions, and wallet transfers

- STAT item and custom-condition edits now suppress full actor-sheet rerenders and refresh only the changed row when visual recalculation is required.
- Added migration version 6, which assigns explicit unique row order to injuries and conditions so an edited state no longer jumps to the top when Foundry rebuilds embedded-item collections.
- Preserved expanded descriptions and STAT scroll position during targeted row replacement.
- Removed inherited margins from the Long Rest / Short Rest switch.
- Moved Select All and Clear All into the Start of a New Day intro block.
- Moved the native Gear Post to Chat action into the light right-click menu.
- Collapsed the now-empty Gear row-controls column so Type, Attribute, and Weight can use the freed width.
- Empty wallet feedback no longer reserves vertical space.
- Added a money-transfer button to both compact and expanded wallet modes.
- Added a denomination-preserving player-to-player money-transfer dialog with ownership checks, active-GM socket authorization when required, serialized operations, and best-effort rollback if the recipient update fails.
- Exposed `openMoneyTransferDialog(app, actor)` through the public module API.
- Added behavior and regression coverage for stable STAT order, suppressed renders, Rest spacing, New Day toolbar placement, Gear chat relocation, empty wallet messages, and money-transfer arithmetic. The suite now contains 60 passing tests.

## 1.5.5 - daily completion and Rest window sizing

- Non-permanent injuries are now deleted when their day-based healing timer reaches zero.
- Non-permanent custom STAT conditions are removed from the actor when their timer reaches zero.
- Wash states still transition through their dedicated progression instead of being deleted.
- Addiction processing is now one conditional daily action: phases with a craving die roll immediately, results 1–2 stop progression, and results 3+ advance the cycle automatically.
- Automatic Addiction progression uses dedicated chat text and no longer tells the user to advance the cycle manually.
- Flat withdrawal phases still post their Endurance instruction and then advance the daily withdrawal counter.
- The Rest dialog now returns to automatic height whenever Long Rest and Short Rest panes are switched, preventing the Short Rest pane from inheriting a smaller fixed height and creating an unnecessary vertical scrollbar.
- Added regression and behavior tests for zero-day deletion, conditional Addiction progression, automatic chat wording, and dynamic Rest sizing. The suite now contains 53 passing tests.

## 1.5.4 - new-day assistant and sheet controls

- Changed the Gear right-click menu to a light white-and-black theme while keeping the Delete trash icon red.
- Removed the `Chargen` control from Forbidden Lands character-sheet headers.
- Added a Long Rest checkbox for rests that begin a new day.
- Added a separate rest-style New Day assistant that previews daily changes before applying them.
- The assistant can advance injury healing, day-based lethal limits, wash-state timers/transitions, timed custom STAT conditions, Addiction morning checks and Addiction cycle progression.
- The assistant resets the module's Short Rest recovery lock for the new day.
- Every proposed daily action can be enabled or disabled independently before applying it.
- Reused one Addiction state-machine service for both STAT actions and the New Day assistant.
- Hardened wash-state transitions so the replacement source is resolved before the old state is removed.
- Added regression tests for the light context menu, Chargen removal, Long Rest handoff, daily planning, selective application, and timer formatting. The suite contains 49 passing tests at this release.

## 1.5.3 - pinned consumables layout hotfix

- Restored the system Gear tab's flexible middle track so the item list scrolls instead of pushing consumables below the window.
- Kept the consumables bar pinned to the bottom at both compact and expanded sheet heights.
- Removed only the actual row gaps and the obsolete Gear-section bottom padding.
- Removed the remaining bottom padding below the borderless consumables bar.
- Added a regression test for the flexible middle track, scroll container, and pinned consumables contract.

## 1.5.2 - compact Gear grid hotfix

- Removed the system Gear-tab row gap that remained visible after replacing the original top controls.
- Replaced the system flexible middle grid track with content-sized rows while Quick Access compact mode is active.
- Prevented the Gear list from reserving unused height above the consumables row.
- Added a regression test for the compact Gear root layout contract.


## 1.5.1 - STAT and wallet layout hotfix

- Restored the STAT root scope classes accidentally removed during the localization pass. This fixes unstyled rows, full-size embedded images, and broken STAT layout.
- Added a runtime guard that reapplies the STAT scope and read-only classes even when a cached or overridden template is incomplete.
- Removed the wallet summary from both the popover flow and the expanded currency line.
- Moved total value, coin count, and coin weight into a compact tooltip shown after hovering the wallet icon for one second.
- Added regression tests for the STAT CSS scope and tooltip-only wallet summary.


## 1.5.0 - Foundation, localization, and Gear QoL

- Unified Forbidden Lands attribute and currency path access for both singular and plural system data containers.
- Serialized wallet mutations per actor to prevent rapid cross-denomination updates from racing each other.
- Added wallet total value, coin count, and coin-weight calculation, now displayed in the delayed wallet-icon tooltip.
- Added world settings for player Short Rest reset permission and no-change Rest chat cards.
- Made manual Short Rest limit reset GM-only by default.
- Fully localized the integrated STAT templates, Heat, Mor, Addiction, injury treatment, wash-state notifications, and chat output for Russian and English clients.
- Removed legacy `Roll.evaluate({ async: true })` calls for Foundry v13.
- Reused the shared actor attribute resolver for automatic Heat and Mor damage.
- Added English aliases for special conditions named `Heat`, `Mor`, `Addiction`, and `[ARC]` while preserving Russian aliases.
- Added Gear context-menu item duplication.
- Added automatic cleanup of stale Quick Access and Gear-order item references.
- Expanded the public module API with Quick Access, Rest, and data-cleanup methods.
- Expanded the automated suite from 30 to 40 tests, including template existence, STAT localization, Foundry v13 Roll calls, shared data paths, serialized operations, and stale-reference cleanup.

## 1.4.1 - Rest condition ActiveEffect cleanup

- Long Rest now clears Forbidden Lands condition ActiveEffects when removing Sleepy and Cold, not only system condition flags.

## 1.4.0 - STAT integration finalization

- Rest Long Rest now clears `Sleepy` and clears `Cold` when a heat source is checked, using the explicit Forbidden Lands condition path fallback.
- STAT scroll position is preserved across edits, deletes, drag sorting, and sheet rerenders.
- Shared destructive-confirmation dialog now uses a light character-sheet style instead of the older dark panel.
- Finalized the embedded Expanded Conditions pass after live STAT verification.

## 1.3.1 - STAT stabilization pass

- Added confirmation before deleting STAT injuries and custom conditions.
- Reused the shared styled danger dialog for Gear and STAT destructive actions.
- Routed STAT tab chrome through the shared sheet adapter where possible.
- Localized STAT settings and new delete-confirmation text.
- Locked STAT layout-column changes behind the same edit permission as other STAT mutations.


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
