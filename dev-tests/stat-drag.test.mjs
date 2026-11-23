import test from "node:test";
import assert from "node:assert/strict";
import { bindStatDrag, cancelStatDrag } from "../scripts/conditions/features/row-drag.js";
import { invalidateExpandedConditionsRender } from "../scripts/conditions/main.js";
import { refreshConditionsRows } from "../scripts/conditions/render/refresh-rows.js";
import { scheduleStatSync } from "../scripts/conditions/stat-sync.js";

function dragFixture(t) {
  const handlers = new Map(), frames = new Map(), classes = new Set(), cancelled = [];
  const app = {};
  const row = { isConnected: true, nextSibling: null };
  const list = { contains: element => element === row && row.isConnected, insertBefore() {} };
  const document = { elementFromPoint: () => null };
  const events = {
    on(event, handler) { handlers.set(event, handler); return this; },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event); return this; }
  };
  const rowView = {
    closest: () => [row],
    addClass: name => classes.add(name), removeClass: name => classes.delete(name)
  };
  let bind, saves = 0;
  const tab = { off: () => tab, on: (_type, _selector, callback) => { bind = callback; }, hasClass: () => false };
  const html = { find: selector => selector === ".conditions-tab" ? tab : [list] };
  const globals = {
    document,
    $: element => element === document ? events : element === null ? { closest: () => [] } : rowView,
    requestAnimationFrame(callback) { const id = frames.size + 1; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { cancelled.push(id); }
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  t.after(() => { cancelStatDrag(app); Object.assign(globalThis, previous); });

  bindStatDrag(app, html, { editable: true, isCurrent: () => true, persistRowOrder: () => { saves += 1; } });
  bind({ currentTarget: {}, button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
  const move = handlers.get("mousemove.fblecSort");
  move({ clientX: 10, clientY: 20 });
  move({ clientX: 12, clientY: 22 });
  assert.equal(frames.size, 1);
  assert.ok(classes.has("fblec-dragging"));
  return { app, row, handlers, frames, classes, cancelled, saves: () => saves };
}

for (const stop of ["sheet invalidation", "row replacement", "detached mouseup"]) {
  test(`STAT cancels frame and document listeners on ${stop}`, async t => {
    const { app, row, handlers, frames, classes, cancelled, saves } = dragFixture(t);
    if (stop === "sheet invalidation") invalidateExpandedConditionsRender(app);
    else if (stop === "row replacement") {
      await refreshConditionsRows({ html: { find: () => ({ html() { row.isConnected = false; } }) },
        buildRows: async () => "rows", beforeReplace: () => cancelStatDrag(app) });
    } else {
      row.isConnected = false;
      handlers.get("mouseup.fblecSort")();
    }
    assert.deepEqual(cancelled, [1]);
    assert.equal(handlers.size, 0);
    assert.equal(classes.has("fblec-dragging"), false);
    frames.get(1)();
    assert.equal(saves(), 0);
  });
}

test("STAT saves a live drag once and releases its document handlers", t => {
  const { handlers, cancelled, saves } = dragFixture(t);
  const release = handlers.get("mouseup.fblecSort");
  release();
  release();
  assert.equal(saves(), 1);
  assert.equal(handlers.size, 0);
  assert.deepEqual(cancelled, [1]);
});

test("STAT waits for the drop before syncing an injury rename", { timeout: 1_000 }, async t => {
  const { app, handlers, saves } = dragFixture(t);
  const actor = { type: "character", uuid: "Actor.drag", apps: { app } };
  Object.assign(app, { actor, element: { querySelector: () => true } });
  let renders = 0;
  const rendered = new Promise(resolve => {
    scheduleStatSync(actor, { render: false }, "writer", () => {
      renders += 1;
      resolve();
    });
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(renders, 0);
  handlers.get("mouseup.fblecSort")();
  await rendered;
  assert.equal(renders, 1);
  assert.equal(saves(), 1);
});
