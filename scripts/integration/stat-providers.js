import { MODULE_ID } from "../constants.js";
import { escapeHtml, scheduleSheetRefresh } from "../utils.js";
import { getActiveGM } from "./socket-api.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const providers = new Map();

export function registerStatProvider(definition) {
  const provider = normalizeStatProvider(definition);
  if (providers.has(provider.id)) throw new Error(`STAT provider is already registered: ${provider.id}`);

  providers.set(provider.id, provider);
  globalThis.Hooks?.callAll?.("fblQuickAccess.statProviderRegistered", provider.id);

  return () => {
    if (providers.get(provider.id) !== provider) return false;
    providers.delete(provider.id);
    globalThis.Hooks?.callAll?.("fblQuickAccess.statProviderUnregistered", provider.id);
    return true;
  };
}

export function getStatProviders() {
  return Array.from(providers.values()).sort(compareProviders);
}

export async function renderStatProviderSections(context) {
  const rendered = [];
  const activeProviders = [];

  for (const provider of getStatProviders()) {
    try {
      const html = await provider.render(Object.freeze({ ...context, providerId: provider.id }));
      if (html === null || html === undefined || html === "") continue;
      if (typeof html !== "string") {
        throw new TypeError(`STAT provider ${provider.id} render() must return an HTML string`);
      }

      rendered.push(
        `<section class="fblqa-stat-provider" data-fblqa-stat-provider="${escapeHtml(provider.id)}">${html}</section>`
      );
      activeProviders.push(provider);
    } catch (error) {
      console.error(`${MODULE_ID} | STAT provider render failed`, provider.id, error);
      if (globalThis.game?.user?.isGM) {
        rendered.push(
          `<section class="fblqa-stat-provider fblqa-stat-provider-error" data-fblqa-stat-provider="${escapeHtml(provider.id)}">`
          + `<p>${escapeHtml(`STAT provider unavailable: ${provider.id}`)}</p></section>`
        );
      }
    }
  }

  return { html: rendered.join(""), providers: activeProviders };
}

export function activateStatProviderListeners(context, activeProviders = getStatProviders()) {
  const tabRoot = toElement(context?.tabRoot ?? context?.root);
  if (!tabRoot) return;

  for (const provider of activeProviders) {
    const root = findProviderRoot(tabRoot, provider.id);
    if (!root) continue;

    try {
      provider.activateListeners(Object.freeze({
        app: context.app,
        actor: context.actor,
        editable: Boolean(context.editable),
        root,
        refresh: () => refreshStat(context.app ?? context.actor),
        providerId: provider.id
      }));
    } catch (error) {
      console.error(`${MODULE_ID} | STAT provider listener activation failed`, provider.id, error);
    }
  }
}

/** Refresh all currently open sheets for an actor, or a specific sheet app. */
export function refreshStat(appOrActor) {
  if (!appOrActor) return 0;

  if (typeof appOrActor.render === "function" && appOrActor.documentName !== "Actor") {
    scheduleSheetRefresh(appOrActor);
    return 1;
  }

  const actor = appOrActor.documentName === "Actor"
    ? appOrActor
    : appOrActor.actor?.documentName === "Actor"
      ? appOrActor.actor
      : null;
  if (!actor) return 0;

  const apps = collectActorApps(actor);
  for (const app of apps) scheduleSheetRefresh(app);
  return apps.length;
}

export async function handleStatProviderActorDeleted(actor) {
  if (!actor || actor.documentName !== "Actor") return;
  const activeGM = getActiveGM();
  if (activeGM && activeGM.id !== globalThis.game?.user?.id) return;
  if (!activeGM && !globalThis.game?.user?.isGM) return;

  for (const provider of getStatProviders()) {
    if (!provider.onActorDeleted) continue;
    try {
      await provider.onActorDeleted(actor);
    } catch (error) {
      console.error(`${MODULE_ID} | STAT provider actor cleanup failed`, provider.id, error);
    }
  }
}

export function normalizeStatProvider(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("STAT provider definition is required");
  const id = String(definition.id ?? "").trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new TypeError(`Invalid STAT provider id: ${id || "<empty>"}`);
  if (typeof definition.render !== "function") throw new TypeError(`STAT provider ${id} requires render(context)`);
  if (definition.activateListeners !== undefined && typeof definition.activateListeners !== "function") {
    throw new TypeError(`STAT provider ${id} activateListeners must be a function`);
  }
  if (definition.onActorDeleted !== undefined && typeof definition.onActorDeleted !== "function") {
    throw new TypeError(`STAT provider ${id} onActorDeleted must be a function`);
  }

  return Object.freeze({
    id,
    order: finiteOrder(definition.order),
    render: definition.render,
    activateListeners: definition.activateListeners ?? (() => {}),
    onActorDeleted: definition.onActorDeleted ?? null
  });
}

function compareProviders(a, b) {
  return a.order - b.order || a.id.localeCompare(b.id);
}

function finiteOrder(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 500;
}

function toElement(value) {
  const HTMLElementClass = globalThis.HTMLElement;
  if (!HTMLElementClass) return null;
  if (value instanceof HTMLElementClass) return value;
  if (value?.[0] instanceof HTMLElementClass) return value[0];
  return null;
}

function findProviderRoot(tabRoot, providerId) {
  return Array.from(tabRoot.querySelectorAll?.("[data-fblqa-stat-provider]") ?? [])
    .find((element) => element.dataset?.fblqaStatProvider === providerId) ?? null;
}

function collectActorApps(actor) {
  const result = new Set();
  const add = (app) => {
    if (!app || typeof app.render !== "function") return;
    if (app.rendered === false || (Number.isFinite(Number(app.state)) && Number(app.state) < 0)) return;
    result.add(app);
  };

  const actorApps = actor.apps;
  if (actorApps instanceof Map) {
    for (const app of actorApps.values()) add(app);
  } else if (Array.isArray(actorApps)) {
    for (const app of actorApps) add(app);
  } else if (actorApps && typeof actorApps === "object") {
    for (const app of Object.values(actorApps)) add(app);
  }

  const windows = globalThis.ui?.windows;
  if (windows instanceof Map) {
    for (const app of windows.values()) if (app?.actor?.id === actor.id) add(app);
  } else if (windows && typeof windows === "object") {
    for (const app of Object.values(windows)) if (app?.actor?.id === actor.id) add(app);
  }

  if (actor.sheet?.rendered) add(actor.sheet);
  return Array.from(result);
}
