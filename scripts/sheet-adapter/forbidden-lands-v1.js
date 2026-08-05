/**
 * Adapter for the legacy Forbidden Lands actor sheet markup used by Foundry VTT v13.
 *
 * The rest of the module should prefer these functions over ad-hoc selectors.
 * When the system sheet markup changes, the goal is to patch this file first.
 */

export function findActorSheetRoot(htmlOrElement) {
  if (!htmlOrElement) return null;

  if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
  if (htmlOrElement?.[0] instanceof HTMLElement) return htmlOrElement[0];
  if (htmlOrElement?.element instanceof HTMLElement) return htmlOrElement.element;

  return null;
}


export function findApplicationRoot(element) {
  if (!(element instanceof HTMLElement)) return null;
  return element.closest?.(".app.window-app, .window-app, .application") ?? element;
}

export function findGearTab(root) {
  return root?.querySelector?.(".gear-tab")
    ?? root?.querySelector?.('[data-tab="gear"]')
    ?? root?.querySelector?.('.tab[data-tab="gear"]')
    ?? null;
}

export function findCombatTab(root) {
  return root?.querySelector?.(".combat-tab")
    ?? root?.querySelector?.('[data-tab="combat"]')
    ?? root?.querySelector?.('.tab[data-tab="combat"]')
    ?? null;
}

export function findTalentTab(root) {
  return root?.querySelector?.(".talent-tab")
    ?? root?.querySelector?.(".talents-tab")
    ?? root?.querySelector?.('[data-tab="talent"]')
    ?? root?.querySelector?.('[data-tab="talents"]')
    ?? root?.querySelector?.('.tab[data-tab="talent"]')
    ?? root?.querySelector?.('.tab[data-tab="talents"]')
    ?? null;
}

export function findMainTab(root) {
  return root?.querySelector?.(".main-tab")
    ?? root?.querySelector?.('[data-tab="main"]')
    ?? root?.querySelector?.('.tab[data-tab="main"]')
    ?? null;
}

export function findGearContainers(gearTab, ignoredRoot = null) {
  if (!gearTab) return [];
  return [...gearTab.querySelectorAll(".gears, section.gears")]
    .filter((element) => element instanceof HTMLElement)
    .filter((element) => !ignoredRoot?.contains?.(element));
}

export function findPrimaryGearContainer(gearTab, ignoredRoot = null) {
  return findGearContainers(gearTab, ignoredRoot)[0] ?? null;
}

export function findConsumablesRow(gearTab) {
  return gearTab?.querySelector?.(".consumables") ?? null;
}

export function findOriginalCurrencyContainers(gearTab, ignoredRoot = null) {
  if (!gearTab) return [];
  return [...gearTab.querySelectorAll(".currencies")]
    .filter((element) => element instanceof HTMLElement)
    .filter((element) => !ignoredRoot?.contains?.(element));
}

export function findOriginalGearTopControls(gearTab, ignoredRoot = null) {
  if (!gearTab) return [];
  return [...gearTab.querySelectorAll(".gears > nav.controls, .control-gear, .gears .encumbrance")]
    .filter((element) => element instanceof HTMLElement)
    .filter((element) => !ignoredRoot?.contains?.(element));
}


export function findSheetBody(root) {
  return root?.querySelector?.(".sheet-body") ?? null;
}

export function findPrimaryTabNavigation(root) {
  return root?.querySelector?.(".sheet-tabs.tabs, .sheet-tabs, nav.tabs[data-group='primary'], .tabs[data-group='primary']") ?? null;
}


export function findRestButton(root) {
  if (!root) return null;

  const selectors = [
    "a.header-button.control.rest-up",
    "button.header-button.control.rest-up",
    ".header-button.control.rest-up",
    "a.rest-up",
    "button.rest-up",
    "[data-action='rest']",
    "[data-action='restUp']"
  ];

  for (const selector of selectors) {
    const button = root.querySelector?.(selector);
    if (button instanceof HTMLElement) return button;
  }

  const appRoot = findApplicationRoot(root) ?? root;
  const headerScope = root.matches?.(".window-header, .sheet-header, header")
    ? root
    : appRoot.querySelector?.(".window-header, .sheet-header, header");
  for (const candidate of headerScope?.querySelectorAll?.("a, button, [role='button']") ?? []) {
    if (!(candidate instanceof HTMLElement)) continue;
    const text = `${candidate.textContent ?? ""} ${candidate.title ?? ""} ${candidate.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/\brest\b|отдых|передыш/.test(text)) return candidate;
  }

  return null;
}

export function findConditionControls(root) {
  if (!root) return [];
  return [...root.querySelectorAll(".condition[data-condition], [data-condition]")]
    .filter((element) => element instanceof HTMLElement);
}

export function findConditionControl(root, key) {
  if (!root || !key) return null;
  const normalizedKey = String(key).toLowerCase();
  return findConditionControls(root).find((element) => String(element.dataset?.condition ?? "").toLowerCase() === normalizedKey) ?? null;
}


export function findConditionHeader(mainTab) {
  if (!mainTab) return null;

  const candidates = mainTab.querySelectorAll("h1, h2, h3, h4, .section-title, .title, header, legend");
  for (const candidate of candidates) {
    const text = descendantText(candidate).replace(/\s+/g, " ").trim().toLowerCase();
    if (text === "conditions" || text === "состояния") return candidate;
  }

  // Fallback: find the smallest visible element whose own label is CONDITIONS.
  for (const candidate of mainTab.querySelectorAll("*")) {
    if (!(candidate instanceof HTMLElement)) continue;
    if (candidate.children.length > 6) continue;
    const text = ownText(candidate).replace(/\s+/g, " ").trim().toLowerCase();
    if (text === "conditions" || text === "состояния") return candidate;
  }

  return null;
}

export function findSheetHeaderCandidates(root) {
  if (!root) return [];

  const candidates = new Set();

  for (const element of root.querySelectorAll(".sheet-header, header.sheet-header, form > header")) {
    if (element instanceof HTMLElement) candidates.add(element);
  }

  const firstFormBorder = root.querySelector("form > .border:first-child");
  if (firstFormBorder instanceof HTMLElement) candidates.add(firstFormBorder);

  const tabNav = findPrimaryTabNavigation(root);
  if (tabNav) {
    let element = tabNav.previousElementSibling;
    let guard = 0;
    while (element && guard < 4) {
      guard += 1;
      if (looksLikeSheetHeader(element)) {
        candidates.add(element);
        for (const border of element.querySelectorAll(".border, [class~='border']")) {
          if (border instanceof HTMLElement) candidates.add(border);
        }
      }
      element = element.previousElementSibling;
    }
  }

  return [...candidates];
}

function ownText(element) {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return text;
}

function descendantText(element) {
  return element?.textContent ?? "";
}

function looksLikeSheetHeader(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.classList.contains("sheet-tabs") || element.classList.contains("tabs")) return false;
  if (element.matches(".tab, .sheet-body, .window-header, .window-content")) return false;

  const text = element.textContent ?? "";
  const hasPortrait = Boolean(element.querySelector("img.profile-img, img.actor-img, img[itemprop='image'], img"));
  const hasKnownFields = /\b(Name|Kin|Age|Profession|Reputation|Willpower|Bonus|Artifact Bonus)\b|Сила\s+воли/i.test(text);
  const isDecorated = element.classList.contains("border") || Boolean(element.querySelector(".border, [class~='border']"));

  return (hasPortrait || hasKnownFields) && isDecorated;
}
