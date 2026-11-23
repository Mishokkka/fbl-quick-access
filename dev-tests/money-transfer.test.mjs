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

test("money transfer preserves denominations and plans both actor updates", () => {
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
  assert.equal(buildMoneyTransferPlan(source, target, { silver: 1, copper: -1 }).error, "invalid-amount");
  assert.equal(buildMoneyTransferPlan(source, target, { silver: 1, copper: Infinity }).error, "invalid-amount");
  assert.equal(buildMoneyTransferPlan(source, target, { gold: 1 }).error, "insufficient-denomination");
  assert.equal(buildMoneyTransferPlan(source, source, { copper: 1 }).error, "same-actor");
});

test("money transfer rejects invalid balances and exact overflow before planning a debit", () => {
  const source = makeActor("source", 0, 0, 10);
  const target = makeActor("target", 90_071_992_547_409, 9, 1);
  assert.equal(buildMoneyTransferPlan(source, target, { copper: 1 }).error, "amount-overflow");
  target.system.currency.copper.value = Infinity;
  assert.equal(buildMoneyTransferPlan(source, target, { copper: 1 }).error, "invalid-balance");
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

for (const failure of ["timeout", "disconnect"]) {
  test(`the sender dialog warns about an unknown outcome on ${failure}`, async t => {
    const transfer = await import(`../scripts/money-transfer.js?sender-${failure}`);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const saved = Object.fromEntries(["Dialog", "HTMLElement", "game", "ui"].map(key => [key, globalThis[key]]));
    t.after(() => Object.assign(globalThis, saved));
    const source = Object.assign(makeActor("source", 1, 0, 0), { type: "character" });
    const target = Object.assign(makeActor("target", 0, 0, 0), { type: "character", ownership: { recipient: 3 } });
    const flags = new Map();
    const requester = { id: "sender", active: true,
      async setFlag(_scope, key, value) { flags.set(key, value); },
      getFlag(_scope, key) { return flags.get(key); },
      async unsetFlag(_scope, key) { flags.delete(key); }
    };
    const recipient = { id: "recipient", active: true, character: target };
    const gm = { id: "gm", active: true, isGM: true };
    const handlers = new Map(), warnings = [];
    let emitted, dialog;
    const sent = new Promise(resolve => { emitted = resolve; });
    globalThis.game = { user: requester, users: [requester, recipient, gm],
      actors: new Map([[source.id, source], [target.id, target]]),
      socket: { connected: true, on: (event, callback) => handlers.set(event, callback), emit: (_channel, message) => emitted(message) }
    };
    globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
    globalThis.Dialog = class { constructor(data) { dialog = data; } render() {} };
    globalThis.HTMLElement = class {
      querySelector(selector) {
        if (selector === "form.fblqa-money-transfer-form") return this;
        if (selector === '[name="targetActor"]') return { value: target.id };
        return { value: selector === '[name="amount-gold"]' ? "1" : "0" };
      }
    };

    const result = transfer.openMoneyTransferDialog(null, source);
    const submitted = dialog.buttons.send.callback(new HTMLElement());
    assert.equal((await sent).type, "wallet-transfer-offer");
    if (failure === "timeout") t.mock.timers.tick(95_001);
    else {
      game.socket.connected = false;
      handlers.get("disconnect")();
    }
    assert.deepEqual(await result, { ok: false, error: "outcome-unknown" });
    await submitted;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /исход перевода неизвестен.*проверьте оба кошелька вручную/i);
  });
}
