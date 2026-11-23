import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";
import { migrateLegacyReconciliations, readReconciliationRecords, writeReconciliationRecords } from "../scripts/transfer-reconciliation-store.js";

function setupStorage(testContext, { setting = {}, flag = null } = {}) {
  const descriptors = ["game", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  testContext.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const world = { id: "test-world" };
  const legacy = { setting, flag, veto: null, writes: [] };
  const gm = {
    id: "test-gm", isGM: true, active: true,
    getFlag: () => legacy.flag,
    async update(data) {
      legacy.writes.push("flag");
      if (legacy.veto !== "flag") legacy.flag = data["flags.fbl-quick-access.moneyTransferReconciliations"];
    }
  };
  globalThis.game = { world, user: gm, users: [gm], settings: {
    get: () => legacy.setting,
    async set(_module, _key, value) {
      legacy.writes.push("setting");
      if (legacy.veto !== "setting") legacy.setting = value;
    }
  } };
  globalThis.localStorage = createMemoryStorage();
  return legacy;
}

function wallet(gold) {
  return { gold, silver: 0, copper: 0 };
}

function makeRecord(requestId = "test-transfer", createdAt = 1) {
  return {
    requestId, createdAt, status: "pending", sourceActorId: "sender", targetActorId: "recipient",
    source: { before: wallet(5), expected: wallet(3), observed: wallet(3) },
    target: { before: wallet(1), expected: wallet(3), observed: wallet(1) }
  };
}

test("legacy reconciliation is not removed until the browser has a verified copy", async testContext => {
  const record = makeRecord();
  const records = { [record.requestId]: record };
  const legacy = setupStorage(testContext, { setting: records, flag: records });
  const persist = localStorage.setItem;
  localStorage.setItem = () => {};
  await assert.rejects(migrateLegacyReconciliations(), { code: "reconciliation-not-persisted" });
  assert.deepEqual(legacy.writes, []);
  assert.deepEqual(legacy.setting, records);
  assert.deepEqual(legacy.flag, records);

  localStorage.setItem = persist;
  legacy.veto = "setting";
  await assert.rejects(migrateLegacyReconciliations(), { code: "reconciliation-cleanup-incomplete" });
  assert.deepEqual(readReconciliationRecords(), records);
  assert.deepEqual(legacy.setting, records);
  assert.equal(legacy.flag, null);

  const resolved = { ...record, status: "resolved", resolvedAt: 2 };
  writeReconciliationRecords({ [record.requestId]: resolved });
  legacy.veto = null;
  await migrateLegacyReconciliations();
  assert.deepEqual(legacy.setting, {});
  assert.deepEqual(readReconciliationRecords(), { [record.requestId]: resolved });
});

test("conflicting legacy versions survive cleanup but require manual reconciliation", async testContext => {
  const record = makeRecord();
  const alternate = { ...record, target: { ...record.target, observed: wallet(2) } };
  const legacy = setupStorage(testContext, {
    setting: { [record.requestId]: record }, flag: { [record.requestId]: alternate }
  });
  legacy.veto = "flag";
  await assert.rejects(migrateLegacyReconciliations(), { code: "reconciliation-cleanup-incomplete" });
  assert.deepEqual(legacy.setting, {});
  legacy.veto = null;
  await migrateLegacyReconciliations();
  const stored = readReconciliationRecords()[record.requestId];
  assert.equal(legacy.flag, null);
  assert.equal(stored.status, "pending");
  assert.equal(stored.requiresReview, true);
  assert.deepEqual(stored.legacyAlternatives, [alternate]);
});

test("only closed reconciliation history is capped and the store is keyed by world and GM", testContext => {
  setupStorage(testContext);
  const records = Object.fromEntries(Array.from({ length: 65 }, (_, index) => {
    const record = makeRecord(`test-transfer-${index}`, index);
    if (index > 4) record.status = "resolved";
    return [record.requestId, record];
  }));
  writeReconciliationRecords(records);
  const stored = Object.values(readReconciliationRecords());
  assert.equal(stored.filter(record => record.status === "resolved").length, 50);
  assert.deepEqual(stored.filter(record => record.status !== "resolved").map(record => record.createdAt), [0, 1, 2, 3, 4]);
  game.user = { ...game.user, id: "other-gm" };
  assert.deepEqual(readReconciliationRecords(), {});
  game.user = game.users[0];
  game.world = { id: "other-world" };
  assert.deepEqual(readReconciliationRecords(), {});
});
