import { CONDITIONS_TAB_ID, CONDITIONS_TAB_LABEL, MODULE_ID } from "../constants.js";
import { findActorSheetRoot, findPrimaryTabNavigation, findSheetBody as adapterFindSheetBody } from "../../sheet-adapter/forbidden-lands-v1.js";

function getRoot(html) {
  return findActorSheetRoot(html);
}

function findSheetTabNav(html) {
  const nav = findPrimaryTabNavigation(getRoot(html));
  return nav ? $(nav) : html.find(".sheet-tabs.tabs, .sheet-tabs").first();
}

function findSheetBody(html) {
  const body = adapterFindSheetBody(getRoot(html));
  return body ? $(body) : html.find(".sheet-body").first();
}

export function getSheetTabGroup(html, nav) {
  return (
    nav.attr("data-group") ||
    findSheetBody(html).find(".tab[data-group]").first().attr("data-group") ||
    "primary"
  );
}

function makeConditionsTabFromVanilla(nav) {
  const selector = `[data-tab="${CONDITIONS_TAB_ID}"]`;
  const reference = nav.children("[data-tab]").not(selector).first();

  let tab;
  if (reference.length) {
    tab = reference.clone(false, false);
    tab.removeClass("active");
    tab.removeAttr("style");
    tab.attr("data-tab", CONDITIONS_TAB_ID);

    if (reference.attr("data-group")) tab.attr("data-group", reference.attr("data-group"));
    else tab.removeAttr("data-group");

    tab.empty().text(CONDITIONS_TAB_LABEL);
  } else {
    tab = $(`<b class="tab-item" data-tab="${CONDITIONS_TAB_ID}">${CONDITIONS_TAB_LABEL}</b>`);
  }

  return tab;
}

export function forceActivateSheetTab(app, html, tabId) {
  if (!tabId) return;

  const nav = findSheetTabNav(html);
  const body = findSheetBody(html);
  const tabButton = nav.children(`[data-tab="${tabId}"]`).first();
  const tabBody = body.children(`.tab[data-tab="${tabId}"]`).first();

  if (!tabButton.length || !tabBody.length) return;

  nav.children("[data-tab]").removeClass("active");
  tabButton.addClass("active");

  body.children(".tab").removeClass("active");
  tabBody.addClass("active");

  app._customActiveTab = tabId;
}

export function activateConditionsTab(app, html) {
  const nav = findSheetTabNav(html);
  const body = findSheetBody(html);

  nav.children("[data-tab]").removeClass("active");
  nav.children(`[data-tab="${CONDITIONS_TAB_ID}"]`).addClass("active");

  body.children(".tab").removeClass("active");
  body.children(`.tab[data-tab="${CONDITIONS_TAB_ID}"]`).addClass("active");

  app._customActiveTab = CONDITIONS_TAB_ID;
}

export function syncConditionsTabChrome(html) {
  const nav = findSheetTabNav(html);
  const isActive = nav.children(`[data-tab="${CONDITIONS_TAB_ID}"]`).hasClass("active");
  findSheetBody(html).children(`.tab[data-tab="${CONDITIONS_TAB_ID}"]`).toggleClass("active", isActive);
}

function installConditionsTabHandlers(app, html) {
  const nav = findSheetTabNav(html);
  const statTab = nav.children(`[data-tab="${CONDITIONS_TAB_ID}"]`).first();
  if (!statTab.length) return;

  statTab.off("click.fblecConditions").on("click.fblecConditions", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    activateConditionsTab(app, html);
  });

  nav.off("click.fblecConditionsOthers").on(
    "click.fblecConditionsOthers",
    `> [data-tab]:not([data-tab="${CONDITIONS_TAB_ID}"])`,
    (ev) => {
      const tabId = $(ev.currentTarget).attr("data-tab");
      window.setTimeout(() => {
        forceActivateSheetTab(app, html, tabId);
        nav.children(`[data-tab="${CONDITIONS_TAB_ID}"]`).removeClass("active");
        findSheetBody(html).children(`.tab[data-tab="${CONDITIONS_TAB_ID}"]`).removeClass("active");
      }, 0);
    }
  );
}

export function ensureConditionsTabButton(html, app) {
  const nav = findSheetTabNav(html);
  if (!nav.length) return nav;

  const selector = `[data-tab="${CONDITIONS_TAB_ID}"]`;
  const existing = nav.children(selector).first();
  const reference = nav.children("[data-tab]").not(selector).first();

  let needsReplace = !existing.length;
  if (existing.length && reference.length) {
    const existingTag = existing.prop("tagName")?.toLowerCase();
    const referenceTag = reference.prop("tagName")?.toLowerCase();
    const existingClasses = (existing.attr("class") || "").split(/\s+/).filter(c => c && c !== "active").sort().join(" ");
    const referenceClasses = (reference.attr("class") || "").split(/\s+/).filter(c => c && c !== "active").sort().join(" ");
    needsReplace = existingTag !== referenceTag || existingClasses !== referenceClasses;
  }

  let statTab;
  if (needsReplace) {
    statTab = makeConditionsTabFromVanilla(nav);
    if (existing.length) existing.replaceWith(statTab);
    else nav.append(statTab);
  } else {
    statTab = existing;
    statTab.removeClass("active");
    statTab.removeAttr("style");
    statTab.empty().text(CONDITIONS_TAB_LABEL);
  }

  installConditionsTabHandlers(app, html);
  return nav;
}

export function bindNativeSheetTabs(app, html) {
  for (const tabs of app._tabs ?? []) {
    try {
      tabs.bind(html[0]);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to bind actor sheet tabs`, err);
    }
  }
}
