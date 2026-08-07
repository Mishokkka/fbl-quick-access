import { MODULE_ID } from "./constants.js";
import { refreshPilgrimFontChoices, registerCoreSettings } from "./settings.js";
import { buildPanel, compactOriginalGearSpacing, hideOriginalGearTopControls } from "./panel.js";
import { setupGearCardView, setupGearViewConsumableToggle } from "./gear-cards.js";
import { setupGearContextMenu } from "./gear-context-menu.js";
import { applySavedGearOrder, setupGearOrdering } from "./gear-order.js";
import { registerTooltipListeners, setupCombatItemTooltips, setupGearItemTooltips, setupTalentItemTooltips } from "./tooltips.js";
import { findActorSheetRoot, findBiographyTab, findCombatTab, findGearTab, findMainTab, findPrimaryGearContainer, findTalentTab } from "./sheet-adapter/forbidden-lands-v1.js";
import { getActorFromApp, isForbiddenLandsCharacter } from "./utils.js";
import { registerWalletListeners } from "./wallet.js";
import { openMoneyTransferDialog, registerMoneyTransferSocket } from "./money-transfer.js";
import { applyDecorativeBorderMode, applyItemSheetNoBorders, compactMainTab, compactSheetHeader, isDecorativeBordersCompact, setupDecorativeBorderToggle } from "./main-tab.js";
import { getWillpowerTalents, saveWillpowerTalents, setupStartWillpowerButton } from "./willpower.js";
import { openRestDialog, setupRestButton } from "./rest.js";
import { buildNewDayPlan, buildNewDayPlanWithProviders, openNewDayDialog } from "./new-day.js";
import { removeChargenButton } from "./header-controls.js";
import { handleExpandedConditionsCreateItem, initExpandedConditions, readyExpandedConditions, renderExpandedConditions } from "./conditions/main.js";
import { getStoredSlots, saveSlots } from "./quick-access.js";
import { handleDeletedActorItem, pruneActorReferences, pruneWorldActorReferences } from "./data-hygiene.js";
import { handleStatProviderActorDeleted, refreshStat, registerStatProvider } from "./integration/stat-providers.js";
import { initializeNewDayProviderBridge, registerNewDayProvider } from "./integration/new-day-providers.js";
import { executeAsActiveGM, getActiveGM, registerIntegrationSocket, registerSocketHandler } from "./integration/socket-api.js";
import { getReputationEntries, openReputationDialog, saveReputationEntries, setupReputationManager } from "./reputation.js";
import { cleanupBiographyTab, closeBiographyDrawer, getBiographyProfile, releaseBiographyState, saveBiographyProfile, setupBiographyTab } from "./biography.js";
import { pruneOwnSocketProofs } from "./socket-auth.js";
import { getStateProgressionMode, initializeStateProgression, readyStateProgression } from "./state-progression.js";


Hooks.once("init", () => {
  registerCoreSettings();
  registerWalletListeners();
  registerTooltipListeners();
  initExpandedConditions();
  initializeNewDayProviderBridge();
  initializeStateProgression();

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      ...(module.api ?? {}),
      apiVersion: 1,
      capabilities: Object.freeze({
        statProviders: true,
        newDayProviders: true,
        activeGmExecution: true,
        characterImport: true,
        biographyProfile: true,
        stateProgression: true
      }),
      refreshGearPresentation,
      registerStatProvider,
      registerNewDayProvider,
      refreshStat,
      getActiveGM,
      executeAsActiveGM,
      registerSocketHandler,
      getQuickAccessSlots: getStoredSlots,
      setQuickAccessSlots: saveSlots,
      openRestDialog,
      openNewDayDialog,
      buildNewDayPlan,
      buildNewDayPlanWithProviders,
      getStateProgressionMode,
      openMoneyTransferDialog,
      getReputationEntries,
      saveReputationEntries,
      openReputationDialog,
      getBiographyProfile,
      saveBiographyProfile,
      getWillpowerTalents,
      saveWillpowerTalents,
      pruneActorReferences,
      pruneWorldActorReferences
    };
    Hooks.callAll("fblQuickAccess.apiReady", module.api);
  }
});

Hooks.once("ready", async () => {
  refreshPilgrimFontChoices();
  registerIntegrationSocket();
  registerMoneyTransferSocket();
  await readyStateProgression();
  await pruneOwnSocketProofs();
  await readyExpandedConditions();
  await pruneWorldActorReferences();
});

Hooks.on("renderSettingsConfig", (_app, htmlOrElement) => {
  refreshPilgrimFontChoices(htmlOrElement);
});

Hooks.on("createItem", handleExpandedConditionsCreateItem);
Hooks.on("deleteItem", handleDeletedActorItem);
Hooks.on("deleteActor", handleDeletedActor);
Hooks.on("fblec-prosthetics.gearExtensionsInjected", handleProstheticsGearInjected);

// Forbidden Lands v13.0.5 still uses ApplicationV1 actor sheets. The concrete
// sheet hooks are enough for V1. The generic ApplicationV2 hook is kept only as
// a future migration path, so the same V1 render cannot run the actor pipeline
// twice.
Hooks.on("renderActorSheet", renderQuickAccess);
Hooks.on("renderActorSheet", renderExpandedConditionsSafely);
Hooks.on("renderActorSheet", renderBiographySafely);
Hooks.on("renderApplicationV2", renderQuickAccess);
Hooks.on("renderApplicationV2", renderBiographySafely);
Hooks.on("closeActorSheet", closeQuickAccessActorSheet);
Hooks.on("closeApplicationV2", closeQuickAccessActorSheet);

// Item sheets use a separate visual cleanup pipeline. Do not register it on
// renderApplicationV1 as well, otherwise V1 item sheets can be processed twice.
Hooks.on("renderItemSheet", renderItemSheetVisuals);
Hooks.on("renderApplicationV2", renderItemSheetVisuals);

async function renderExpandedConditionsSafely(app, htmlOrElement) {
  try {
    await renderExpandedConditions(app, htmlOrElement);
  } catch (error) {
    console.error(`${MODULE_ID} | expanded conditions render failed`, error);
  }
}

function renderQuickAccess(app, htmlOrElement) {
  try {
    const actor = getActorFromApp(app);
    if (!isForbiddenLandsCharacter(actor)) return;

    const root = findActorSheetRoot(htmlOrElement);
    if (!root) return;
    root.classList.add("fblqa-sheet-root", "fblqa-actor-sheet-root");

    const compactBorders = isDecorativeBordersCompact(actor);
    applyDecorativeBorderMode(root, compactBorders);
    compactSheetHeader(root, compactBorders);
    removeChargenButton(root);
    window.setTimeout(() => removeChargenButton(root), 0);
    setupStartWillpowerButton(app, actor, root);
    setupRestButton(app, actor, root);
    setupReputationManager(app, actor, root);

    const gearTab = findGearTab(root);
    if (gearTab) setupGearTab(app, actor, gearTab);

    const combatTab = findCombatTab(root);
    if (combatTab) setupCombatItemTooltips(actor, combatTab);

    const talentTab = findTalentTab(root);
    if (talentTab) setupTalentItemTooltips(actor, talentTab);

    const mainTab = findMainTab(root);
    if (mainTab) {
      compactMainTab(mainTab, compactBorders);
      setupDecorativeBorderToggle(app, actor, mainTab);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | render failed`, error);
  }
}

function renderBiographySafely(app, htmlOrElement) {
  try {
    const actor = getActorFromApp(app);
    if (!isForbiddenLandsCharacter(actor)) return;

    const root = findActorSheetRoot(htmlOrElement);
    if (!root) return;

    // Foundry can emit both the document-sheet and generic ApplicationV2 render
    // hooks for the same DOM pass. Once our shell is mounted, the second hook is
    // a no-op. A later real sheet render replaces the tab DOM, removing this
    // marker and allowing a fresh mount without relying on timing assumptions.
    const bioTab = findBiographyTab(root);
    const alreadyMounted = bioTab instanceof HTMLElement
      && bioTab.dataset.fblqaBiographyMounted === "true"
      && bioTab.querySelector?.(".fblqa-bio-shell");
    if (!alreadyMounted) setupBiographyTab(app, actor, root);
    setupBiographyActivationGuard(app, actor, root);
  } catch (error) {
    console.error(`${MODULE_ID} | BIO render failed`, error);
  }
}

function setupBiographyActivationGuard(app, actor, root) {
  const navigation = root.querySelector?.('.sheet-tabs.tabs, .sheet-tabs, nav.tabs[data-group="primary"], .tabs[data-group="primary"]');
  const bioButton = navigation?.querySelector?.('[data-tab="bio"]');
  if (!(bioButton instanceof HTMLElement) || bioButton.dataset.fblqaBiographyGuard === "true") return;

  bioButton.dataset.fblqaBiographyGuard = "true";
  bioButton.addEventListener("click", () => {
    // Other sheet integrations can replace tab contents after the actor render
    // hook. Re-check only when BIO is actually opened, with no polling.
    queueMicrotask(() => {
      try {
        const currentRoot = findActorSheetRoot(app?.element) ?? root;
        const bioTab = findBiographyTab(currentRoot);
        if (!(bioTab instanceof HTMLElement)) return;
        if (bioTab.dataset.fblqaBiographyMounted === "true" || bioTab.querySelector?.('.fblqa-bio-shell')) return;
        setupBiographyTab(app, actor, currentRoot);
      } catch (error) {
        console.error(`${MODULE_ID} | BIO remount failed`, error);
      }
    });
  });
}

function setupGearTab(app, actor, gearTab) {
  if (!gearTab || gearTab.dataset.fblqaGearProcessing === "true") return;

  gearTab.dataset.fblqaGearProcessing = "true";
  try {
    gearTab.querySelector(".fblqa-panel")?.remove();
    gearTab.classList.add("fblqa-compacted");

    const panel = buildPanel(app, actor);
    gearTab.prepend(panel);

    hideOriginalGearTopControls(gearTab, panel);
    compactOriginalGearSpacing(gearTab, panel);
    applyGearPresentation(app, actor, gearTab, panel);
  } finally {
    delete gearTab.dataset.fblqaGearProcessing;
  }
}

function applyGearPresentation(app, actor, gearTab, panel) {
  const gears = findPrimaryGearContainer(gearTab, panel);
  if (gears) applySavedGearOrder(actor, gears);

  setupGearCardView(app, actor, gearTab, panel);
  setupGearViewConsumableToggle(app, actor, gearTab);
  setupGearOrdering(app, actor, gearTab, panel);
  setupGearContextMenu(app, actor, gearTab, panel);
  setupGearItemTooltips(actor, gearTab, panel);
}

function refreshGearPresentation(app, actorArg, gearTabArg) {
  const actor = actorArg?.documentName === "Actor" ? actorArg : getActorFromApp(app);
  if (!isForbiddenLandsCharacter(actor)) return false;

  const root = findActorSheetRoot(app?.element);
  const gearTab = gearTabArg instanceof HTMLElement ? gearTabArg : root ? findGearTab(root) : null;
  if (!gearTab) return false;

  if (gearTab.dataset.fblqaGearProcessing === "true") return false;
  const panel = gearTab.querySelector(".fblqa-panel");
  if (!panel) {
    setupGearTab(app, actor, gearTab);
    return true;
  }

  gearTab.dataset.fblqaGearProcessing = "true";
  try {
    applyGearPresentation(app, actor, gearTab, panel);
  } finally {
    delete gearTab.dataset.fblqaGearProcessing;
  }
  return true;
}

function handleProstheticsGearInjected(data) {
  const app = data?.app;
  const actor = data?.actor?.documentName === "Actor" ? data.actor : getActorFromApp(app);
  if (!isForbiddenLandsCharacter(actor)) return;

  const gearTab = data?.gearTab instanceof HTMLElement ? data.gearTab : null;
  window.setTimeout(() => refreshGearPresentation(app, actor, gearTab), 0);
}

function renderItemSheetVisuals(app, htmlOrElement) {
  try {
    if (game.system?.id !== "forbidden-lands") return;

    const item = app?.item ?? app?.document ?? app?.object;
    if (item?.documentName !== "Item") return;

    const root = findActorSheetRoot(htmlOrElement);
    if (!root) return;
    root.classList.add("fblqa-sheet-root", "fblqa-item-sheet-root");

    // Item sheets do not have the per-actor CONDITIONS toggle. Their decorative
    // frames are removed entirely in compact mode, not replaced with placeholder lines.
    applyItemSheetNoBorders(root);
  } catch (error) {
    console.error(`${MODULE_ID} | item sheet visual cleanup failed`, error);
  }
}

function closeQuickAccessActorSheet(app, htmlOrElement) {
  const actor = getActorFromApp(app);
  const root = findActorSheetRoot(htmlOrElement ?? app?.element);
  if (root) cleanupBiographyTab(root);
  if (actor) closeBiographyDrawer(actor);
}

function handleDeletedActor(actor) {
  handleStatProviderActorDeleted(actor);
  releaseBiographyState(actor);
}
