import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletControl, initializeWalletOperations, isWalletExpanded } from "../scripts/wallet.js";
import { executeAsActiveGM } from "../scripts/integration/socket-api.js";
import { createSocketProof } from "../scripts/socket-auth.js";

const units = { gold: 100, silver: 10, copper: 1 };
const total = values => Object.entries(units).reduce((sum, [key, unit]) => sum + values[key] * unit, 0);
let nextId = 0;

function makeWallet(values) {
  const gm = { id: "gm", isGM: true, active: true };
  const actor = {
    id: `wallet-${++nextId}`, documentName: "Actor", type: "character", isOwner: true,
    system: { currency: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) },
    writes: [],
    async update(patch) {
      this.writes.push(patch);
      for (const [path, value] of Object.entries(patch)) {
        this.system.currency[path.split(".")[2]].value = value;
      }
      return this;
    }
  };
  globalThis.game = { user: gm, users: [gm], actors: new Map([[actor.id, actor]]) };
  globalThis.localStorage = { getItem: () => null };
  initializeWalletOperations();
  return actor;
}

function change(actor, key, value, mode = "delta") {
  return executeAsActiveGM("wallet.apply-change", { actorId: actor.id, key, value, mode });
}

test("spending one gold from ten silver and one copper leaves one copper", async () => {
  for (const [mode, value] of [["delta", -1], ["input", "-1"], ["input", "0-1"]]) {
    const actor = makeWallet({ gold: 0, silver: 10, copper: 1 });
    const result = await change(actor, "gold", value, mode);
    assert.deepEqual(result.values, { gold: 0, silver: 0, copper: 1 });
    assert.equal(actor.writes.length, 1);
  }
});

test("wallet spends exact copper value even when the old balance exceeds the safe number limit", async () => {
  const gold = 90_071_992_547_410;
  const actor = makeWallet({ gold, silver: 0, copper: 1 });
  assert.deepEqual((await change(actor, "gold", -gold)).values, { gold: 0, silver: 0, copper: 1 });

  const capped = makeWallet({ gold: gold - 1, silver: 9, copper: 1 });
  await assert.rejects(change(capped, "copper", 1), /safe integer limit/i);
  assert.equal(capped.writes.length, 0);
});

test("wallet spending preserves value across denomination boundaries", async () => {
  for (const gold of [0, 1]) for (let silver = 0; silver <= 11; silver++) for (const copper of [0, 1, 9, 10, 11]) {
    const before = { gold, silver, copper };
    for (const key of Object.keys(units)) for (const amount of [1, 2, 11]) {
      const actor = makeWallet(before);
      const cost = amount * units[key];
      const description = `${JSON.stringify(before)}, spend ${amount} ${key}`;
      if (cost > total(before)) {
        await assert.rejects(change(actor, key, -amount), { code: "insufficient-funds" }, description);
        assert.equal(actor.writes.length, 0, description);
        continue;
      }
      const { values } = await change(actor, key, -amount);
      assert.equal(total(values), total(before) - cost, description);
      assert.ok(Object.values(values).every(value => Number.isSafeInteger(value) && value >= 0), description);
      assert.equal(actor.writes.length, 1, description);
      if (before[key] >= amount) {
        assert.deepEqual(values, { ...before, [key]: before[key] - amount }, description);
      }
    }
  }
});

test("cancelled wallet persistence rejects and leaves the queue usable for a retry", async () => {
  for (const [before, key, value] of [
    [{ gold: 0, silver: 0, copper: 2 }, "copper", -1],
    [{ gold: 1, silver: 0, copper: 0 }, "copper", -1]
  ]) {
    const actor = makeWallet(before);
    const update = actor.update;
    actor.update = async () => undefined;
    await assert.rejects(change(actor, key, value), /not persisted/i);
    assert.deepEqual(Object.fromEntries(Object.entries(actor.system.currency).map(([key, entry]) => [key, entry.value])), before);
    actor.update = update;
    const { values } = await change(actor, key, value);
    assert.equal(total(values), total(before) + value * units[key]);
  }
});

class WalletElement {
  constructor(tag) {
    const classes = new Set();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    };
  }
  append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  setAttribute() {}
  closest(selector) {
    return selector.split(", ").some(value => this.classList.contains(value.slice(1)))
      ? this : this.parent?.closest(selector);
  }
  querySelectorAll() { return this.children.filter(child => ["BUTTON", "INPUT"].includes(child.tagName)); }
}

function mountWallet(t, actor) {
  const { document, HTMLElement } = globalThis;
  globalThis.document = { createElement: name => new WalletElement(name) };
  globalThis.HTMLElement = WalletElement;
  t.after(() => Object.assign(globalThis, { document, HTMLElement }));
  const popover = buildWalletControl(null, actor).children[1];
  const minus = popover.children[0].children[0];
  const click = () => minus.listeners.click({ currentTarget: minus, preventDefault() {}, stopPropagation() {} });
  return { popover, minus, click };
}

test("the wallet uses the standard layout when localStorage is unavailable", t => {
  const actor = makeWallet({ gold: 1, silver: 0, copper: 0 });
  const storage = globalThis.localStorage;
  const blocked = () => { throw new DOMException("Storage access denied", "SecurityError"); };
  globalThis.localStorage = { getItem: blocked, setItem: blocked };
  t.after(() => { globalThis.localStorage = storage; });

  assert.equal(isWalletExpanded(actor), false);
  const { popover } = mountWallet(t, actor);
  const [expandControl] = popover.children.at(-1).children;
  const checkbox = expandControl.children[0].children[0];
  checkbox.checked = true;
  assert.doesNotThrow(() => checkbox.listeners.change({ currentTarget: checkbox }));
  assert.equal(isWalletExpanded(actor), false);
});

test("the owner can edit offline and a busy wallet row ignores another click", async t => {
  const actor = makeWallet({ gold: 0, silver: 10, copper: 1 });
  const owner = { id: "owner", active: true };
  game.user = owner;
  game.users = [owner];
  const { minus, click } = mountWallet(t, actor);
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const update = actor.update.bind(actor);
  actor.update = async patch => { start(); await blocked; return update(patch); };

  const first = click();
  await started;
  const busy = minus.disabled;
  const duplicate = click();
  release();
  await Promise.all([first, duplicate]);
  assert.equal(busy, true);
  assert.equal(minus.disabled, false);
  assert.equal(actor.writes.length, 1);
  assert.equal(actor.system.currency.copper.value, 1);
  assert.equal(actor.system.currency.silver.value, 0);
});

test("a player wallet click sends wallet.apply-change to the active GM", async t => {
  const actor = makeWallet({ gold: 2, silver: 0, copper: 0 });
  const flagUser = data => {
    const flags = new Map();
    return { ...data, active: true,
      async setFlag(_scope, key, value) { flags.set(key, value); },
      getFlag(_scope, key) { return flags.get(key); },
      async unsetFlag(_scope, key) { flags.delete(key); }
    };
  };
  const player = flagUser({ id: "owner" });
  const gm = flagUser({ id: "gm", isGM: true });
  game.user = player;
  game.users = [player, gm];
  let receive, sent;
  game.socket = {
    on(_channel, callback) { receive = callback; },
    async emit(_channel, request) {
      sent = request;
      const response = { type: "integration-api-response", requestId: request.requestId, recipientId: player.id,
        activeGMId: gm.id, createdAt: Date.now(), ok: true, result: { values: { gold: 1, silver: 0, copper: 0 } } };
      await createSocketProof("integrationResponse", request.requestId, response, gm);
      receive(response);
    }
  };
  await mountWallet(t, actor).click();
  assert.equal(sent?.operation, "wallet.apply-change");
  assert.equal(sent.activeGMId, gm.id);
  assert.deepEqual(sent.payload, { actorId: actor.id, mode: "delta", key: "gold", value: -1 });
  assert.deepEqual(actor.writes, []);
});
