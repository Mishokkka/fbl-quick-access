import test from "node:test";
import assert from "node:assert/strict";

const actorData = await import("../scripts/actor-data.js");
const { createObjectOperationQueue } = await import("../scripts/operation-queue.js");
const hygiene = await import("../scripts/data-hygiene.js");

test("shared actor data access supports singular and plural Forbidden Lands paths", () => {
  const singular = { system: { attribute: { strength: { value: 2, max: 4 } }, currency: { gold: { value: 3 } } } };
  const plural = { system: { attributes: { strength: { current: 1, valueMax: 5 } }, currencies: { gold: { current: 7 } } } };

  assert.deepEqual(actorData.getActorAttributeState(singular, "strength"), {
    key: "strength",
    valuePath: "system.attribute.strength.value",
    maxPath: "system.attribute.strength.max",
    value: 2,
    max: 4,
    hasValue: true,
    hasMax: true,
    canRecover: true
  });
  assert.equal(actorData.getActorAttributeState(plural, "strength").valuePath, "system.attributes.strength.current");
  assert.equal(actorData.getActorAttributeMaximum(plural, "strength"), 5);
  assert.equal(actorData.getActorCurrencyPath(plural, "gold"), "system.currencies.gold.current");
  assert.equal(actorData.getActorCurrencyValue(plural, "gold"), 7);
});

test("per-object operation queue serializes updates and survives failures", async () => {
  const enqueue = createObjectOperationQueue();
  const target = {};
  const events = [];

  const first = enqueue(target, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("first:end");
  });
  const second = enqueue(target, async () => {
    events.push("second:start");
    throw new Error("expected");
  });
  const third = enqueue(target, async () => {
    events.push("third:start");
    events.push("third:end");
  });

  await first;
  await assert.rejects(second, /expected/);
  await third;
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "third:start", "third:end"]);
});

test("data hygiene removes stale and duplicate item references", () => {
  const existing = new Set(["a", "b"]);
  assert.deepEqual(hygiene.pruneQuickAccessReferences(["a", "missing", null, "b"], existing), ["a", null, null, "b"]);
  assert.deepEqual(hygiene.pruneGearOrderReferences(["a", "missing", "b", "a", null], existing), ["a", "b"]);
});

test("data hygiene keeps legacy normalization on the no-item-scan fast path", async () => {
  const updates = [];
  const actor = {
    items: {
      [Symbol.iterator]() {
        throw new Error("actor.items must not be enumerated when flags contain no Item ids");
      }
    },
    getFlag(_scope, key) {
      if (key === "slots") return [0, null, ""];
      if (key === "gearOrder") return [null, 42];
      return undefined;
    },
    async update(data, options) {
      updates.push({ data, options });
    }
  };

  const result = await hygiene.pruneActorReferences(actor);
  assert.deepEqual(result, { changed: true, slotsChanged: true, orderChanged: true });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].options, { render: false });
  assert.deepEqual(updates[0].data, {
    "flags.fbl-quick-access.slots": [null, null, null],
    "flags.fbl-quick-access.gearOrder": []
  });
});
