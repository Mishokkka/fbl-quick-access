import { refreshExpandedConditionsRows, renderExpandedConditions } from "./main.js";
import { getStatProviders } from "../integration/stat-providers.js";
import { MODULE_ID } from "./constants.js";
import { waitForStatDrag } from "./features/row-drag.js";

const scheduled = new WeakMap();

/** Sync other views after a deliberately render-suppressed Document write. */
export function scheduleStatSync(actor, options = {}, userId = null, renderer = refreshExpandedConditionsRows, changes = null) {
  if (options?.render !== false || actor?.type !== "character") return;
  if (changes && !isRelevantStatActorUpdate(changes)) {
    if (!getStatProviders().length) return;
    if (renderer === refreshExpandedConditionsRows) renderer = renderExpandedConditions;
  }
  const attached = actor.apps;
  const instances = globalThis.foundry?.applications?.instances;
  const apps = new Set([
    ...(attached?.values?.() ?? Object.values(attached ?? {})),
    ...Object.values(globalThis.ui?.windows ?? {}),
    ...(instances?.values?.() ?? [])
  ]);
  for (const app of apps) {
    if ((app.actor ?? app.document)?.uuid !== actor.uuid || app.rendered === false) continue;
    const root = app.element?.[0] ?? app.element;
    if (!root?.querySelector?.(".conditions-tab")) continue;
    // Local handlers already refresh the initiating view. Preserve its focus.
    if (userId === globalThis.game?.user?.id && root.contains?.(globalThis.document?.activeElement)) continue;
    scheduleView(app, root, renderer);
  }
}

export function isRelevantStatActorUpdate(changes) {
  const scope = `flags.${MODULE_ID}.conditions`;
  return changes.flags?.[MODULE_ID]?.conditions !== undefined
    || Object.keys(changes).some(key => key === scope || key.startsWith(`${scope}.`));
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
  const cleanup = () => globalThis.clearTimeout(timer);
  const timer = globalThis.setTimeout(async () => {
    await waitForStatDrag(app);
    if (scheduled.get(app) !== cleanup) return;
    scheduled.delete(app);
    if (root.isConnected === false || app.rendered === false) return;
    try { await renderer(app, root); }
    catch (error) { console.error("fbl-quick-access | STAT synchronization failed", error); }
  }, 0);
  scheduled.set(app, cleanup);
}

export function cleanupStatSync(app) {
  scheduled.get(app)?.();
  scheduled.delete(app);
}
