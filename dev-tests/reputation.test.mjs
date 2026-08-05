import test from "node:test";
import assert from "node:assert/strict";

const PreviousGame = globalThis.game;
globalThis.game = {
  i18n: { localize: (key) => key },
  modules: new Map()
};

const reputation = await import("../scripts/reputation.js");

test("reputation entries normalize legacy names and positive integer values", () => {
  const entries = reputation.normalizeReputationEntries([
    { id: "a", value: 3.9, reason: "Monster hunter", place: "Noctis" },
    { id: "b", amount: 0, description: "Ignored" },
    { id: "c", quantity: "2", description: "Rescue", location: "Damia" }
  ]);

  assert.deepEqual(entries, [
    { id: "a", amount: 3, description: "Monster hunter", location: "Noctis" },
    { id: "c", amount: 2, description: "Rescue", location: "Damia" }
  ]);
  assert.equal(reputation.getReputationTotal(entries), 5);
});

test("native reputation migrates into one anonymous ledger row", () => {
  const actor = {
    system: { bio: { reputation: { value: 4 } } },
    getFlag: () => undefined
  };

  const entries = reputation.getReputationEntries(actor);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 4);
  assert.equal(entries[0].description, "");
  assert.equal(entries[0].location, "");
});

test("stored empty ledger is authoritative over the native total", () => {
  const actor = {
    system: { bio: { reputation: { value: 7 } } },
    getFlag: () => []
  };

  assert.deepEqual(reputation.getReputationEntries(actor), []);
});

test("half and third checks sample individual reputation points rather than rows", () => {
  const entries = [
    { id: "hunter", amount: 5, description: "Hunter", location: "A" },
    { id: "cat", amount: 1, description: "Cat", location: "B" }
  ];

  const deterministic = () => 0;
  const half = reputation.selectRandomReputation(entries, 2, deterministic);
  const third = reputation.selectRandomReputation(entries, 3, deterministic);

  assert.equal(half.reduce((sum, selection) => sum + selection.amount, 0), 3);
  assert.equal(third.reduce((sum, selection) => sum + selection.amount, 0), 2);
  assert.ok(half.some((selection) => selection.amount < selection.entry.amount), "a row can be sampled only partially");
});

test("remote checks round fractional Reputation down", () => {
  const five = [{ id: "five", amount: 5, description: "", location: "" }];
  assert.equal(reputation.selectRandomReputation(five, 2, () => 0.5).reduce((sum, item) => sum + item.amount, 0), 2);
  assert.equal(reputation.selectRandomReputation(five, 3, () => 0.5).reduce((sum, item) => sum + item.amount, 0), 1);

  const one = [{ id: "one", amount: 1, description: "", location: "" }];
  assert.deepEqual(reputation.selectRandomReputation(one, 2, () => 0.5), []);
  assert.deepEqual(reputation.selectRandomReputation(one, 3, () => 0.5), []);
});

if (PreviousGame === undefined) delete globalThis.game;
else globalThis.game = PreviousGame;
