import test from "node:test";
import assert from "node:assert/strict";
import { initializeWalletOperations } from "../scripts/wallet.js";
import { executeAsActiveGM } from "../scripts/integration/socket-api.js";

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

test("spending gold makes change from remaining silver after consuming loose copper", async () => {
  for (const [mode, value] of [["delta", -1], ["input", "-1"], ["input", "0-1"]]) {
    const actor = makeWallet({ gold: 0, silver: 10, copper: 1 });
    const result = await change(actor, "gold", value, mode);
    assert.deepEqual(result.values, { gold: 0, silver: 0, copper: 1 });
    assert.equal(actor.writes.length, 1);
  }
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
