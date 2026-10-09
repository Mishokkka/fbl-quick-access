import { renderExpandedConditions } from "./main.js";

const scheduled = new WeakMap();

/** Sync other views after a deliberately render-suppressed Document write. */
export function scheduleStatSync(actor, options = {}, userId = null, renderer = renderExpandedConditions) {
  if (options.render !== false || actor?.type !== "character") return;
  const apps = new Set([...Object.values(actor.apps ?? {}), ...Object.values(globalThis.ui?.windows ?? {})]);
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
  if (active?.matches?.("input, textarea, select, [contenteditable='true']") && root.contains?.(active)) {
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
