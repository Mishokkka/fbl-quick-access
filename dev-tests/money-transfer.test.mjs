import test from "node:test";
import assert from "node:assert/strict";

const { buildMoneyTransferPlan, normalizeTransferAmounts } = await import("../scripts/money-transfer.js");

function makeActor(id, gold, silver, copper) {
  return {
    id,
    isOwner: true,
    system: {
      currency: {
        gold: { value: gold },
        silver: { value: silver },
        copper: { value: copper }
      }
    }
  };
}

test("money transfer preserves denominations and builds atomic actor updates", () => {
  const source = makeActor("source", 3, 8, 20);
  const target = makeActor("target", 1, 2, 4);
  const plan = buildMoneyTransferPlan(source, target, { gold: 1, silver: 3, copper: 7 });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.amounts, { gold: 1, silver: 3, copper: 7 });
  assert.deepEqual(plan.sourceAfter, { gold: 2, silver: 5, copper: 13 });
  assert.deepEqual(plan.targetAfter, { gold: 2, silver: 5, copper: 11 });
  assert.equal(plan.sourceUpdate["system.currency.gold.value"], 2);
  assert.equal(plan.targetUpdate["system.currency.copper.value"], 11);
});

test("money transfer rejects empty, negative, and unavailable amounts", () => {
  const source = makeActor("source", 0, 1, 2);
  const target = makeActor("target", 0, 0, 0);

  assert.deepEqual(normalizeTransferAmounts({ gold: -5, silver: 1.9, copper: "2" }), {
    gold: 0,
    silver: 1,
    copper: 2
  });
  assert.equal(buildMoneyTransferPlan(source, target, {}).error, "empty-amount");
  assert.equal(buildMoneyTransferPlan(source, target, { gold: 1 }).error, "insufficient-denomination");
  assert.equal(buildMoneyTransferPlan(source, source, { copper: 1 }).error, "same-actor");
});

test("money transfer chooses the active assigned owner as recipient", async () => {
  const target = makeActor("target", 0, 0, 0);
  target.testUserPermission = (user) => ["owner-a", "owner-b"].includes(user.id);

  const users = [
    { id: "owner-a", active: true, isGM: false, character: null },
    { id: "owner-b", active: true, isGM: false, character: target },
    { id: "offline", active: false, isGM: false, character: target }
  ];

  const { selectMoneyTransferRecipient } = await import("../scripts/money-transfer.js");
  assert.equal(selectMoneyTransferRecipient(users, target, "sender")?.id, "owner-b");
});

test("money transfer does not offer inactive or GM recipients", async () => {
  const target = makeActor("target", 0, 0, 0);
  target.testUserPermission = () => true;
  const users = [
    { id: "gm", active: true, isGM: true, character: target },
    { id: "offline", active: false, isGM: false, character: target }
  ];

  const { selectMoneyTransferRecipient } = await import("../scripts/money-transfer.js");
  assert.equal(selectMoneyTransferRecipient(users, target, "sender"), null);
});

test("money transfer whisper model distinguishes completed, declined, and expired results", async () => {
  const { buildTransferWhisperModel } = await import("../scripts/money-transfer.js");
  const offer = {
    requesterId: "sender",
    recipientUserId: "recipient",
    sourceActorId: "source",
    targetActorId: "target",
    amounts: { gold: 1, silver: 2, copper: 3 }
  };

  assert.equal(buildTransferWhisperModel(offer, { ok: true }).status, "completed");
  assert.equal(buildTransferWhisperModel(offer, { ok: false, error: "declined" }).status, "declined");
  assert.equal(buildTransferWhisperModel(offer, { ok: false, error: "recipient-timeout" }).status, "expired");
});
