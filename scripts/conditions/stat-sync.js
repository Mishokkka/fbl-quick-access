import { MODULE_ID } from "./constants.js";
import { renderExpandedConditions } from "./main.js";

const scheduled = new WeakMap();

export function isRelevantStatActorUpdate(changes) {
  if (!changes || typeof changes !== "object") return true;
  if (changes.flags?.[MODULE_ID]?.conditions !== undefined) return true;
  for (const key of Object.keys(changes)) {
    if (key === `flags.${MODULE_ID}.conditions` || key.startsWith(`flags.${MODULE_ID}.conditions.`)) return true;
  }
  return false;
}

function collectApps(actor) {
  const apps = new Set();
  const addCollection = (collection) => {
    if (!collection) return;
    if (collection instanceof Map) {
      for (const app of collection.values()) if (app) apps.add(app);
    } else if (Array.isArray(collection)) {
      for (const app of collection) if (app) apps.add(app);
    } else if (typeof collection === "object") {
      for (const app of Object.values(collection)) if (app) apps.add(app);
    }
  };
  addCollection(actor?.apps);
  addCollection(globalThis.ui?.windows);
  addCollection(globalThis.foundry?.applications?.instances);
  return apps;
}

/** Sync other views after a deliberately render-suppressed Document write. */
export function scheduleStatSync(actor, options = {}, userId = null, renderer = renderExpandedConditions, changes = null) {
  if (options.render !== false || actor?.type !== "character") return;
  if (changes !== null && !isRelevantStatActorUpdate(changes)) return;
  const apps = collectApps(actor);
  for (const app of apps) {
    if ((app.actor ?? app.document)?.uuid !== actor.uuid || app.rendered === false) continue;
    const root = app.element?.[0] ?? app.element;
    if (!root?.querySelector?.(".conditions-tab")) continue;
    // Local handlers already refresh the initiating view. Preserve its focus.
    if (userId === globalThis.game?.user?.id && root.contains?.(globalThis.document?.activeElement)) continue;
    scheduleView(app, root, renderer);
  }
}

function scheduleView(app, root, renderer) {
  if (scheduled.has(app)) return;
  const active = globalThis.document?.activeElement;
  if (active?.isConnected !== false && active?.matches?.("input, textarea, select, [contenteditable='true']") && root.contains?.(active)) {
    const cleanup = () => { active.removeEventListener("blur", resume); scheduled.delete(app); };
    const resume = () => { cleanup(); scheduleView(app, root, renderer); };
    scheduled.set(app, cleanup);
    active.addEventListener("blur", resume, { once: true });
    return;
  }
  const timer = globalThis.setTimeout(async () => {
    scheduled.delete(app);
    if (root.isConnected === false || app.rendered === false) return;
    try { await renderer(app, root); }
    catch (error) { console.error("fbl-quick-access | STAT synchronization failed", error); }
  }, 0);
  scheduled.set(app, () => globalThis.clearTimeout(timer));
}

export function cleanupStatSync(app) {
  scheduled.get(app)?.();
  scheduled.delete(app);
}
