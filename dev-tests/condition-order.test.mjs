import test from "node:test";
import assert from "node:assert/strict";
import { applyDocumentUpdate } from "./helpers/document-update.mjs";

globalThis.foundry = {
  utils: {
    deepClone: (value) => structuredClone(value),
    getProperty: (object, path) => String(path).split(".").reduce((current, key) => current?.[key], object)
  }
};

const { ensureConditionItemOrders } = await import("../scripts/conditions/migrations.js");

function makeItem(id, sort = 0) {
  return {
    id,
    name: id,
    type: "criticalInjury",
    sort,
    flags: {},
    getFlag(scope, key) {
      return foundry.utils.getProperty(this.flags[scope], key);
    }
  };
}

function makeActor(items) {
  return {
    documentName: "Actor",
    items,
    flags: {},
    async update(data) {
      applyDocumentUpdate(this, data);
    },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) {
        const item = this.items.find((candidate) => candidate.id === update._id);
        applyDocumentUpdate(item, update);
      }
    }
  };
}

test("STAT order migration assigns unique stable order to equal-sort injuries", async () => {
  const first = makeItem("first");
  const second = makeItem("second");
  const actor = makeActor([first, second]);
  const custom = [
    { id: "custom-a", name: "A", order: 0 },
    { id: "custom-b", name: "B", order: 10 }
  ];

  const result = await ensureConditionItemOrders(actor, custom);
  assert.equal(result.changed, true);
  assert.equal(first.getFlag("fbl-quick-access", "conditions.order"), 10);
  assert.equal(second.getFlag("fbl-quick-access", "conditions.order"), 20);
  assert.deepEqual(result.list.map((entry) => entry.order), [0, 30]);

  const secondPass = await ensureConditionItemOrders(actor, result.list);
  assert.equal(secondPass.changed, false);
});
