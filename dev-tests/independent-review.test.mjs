import test from "node:test";
import assert from "node:assert/strict";

function makeCurrencyActor(id, { owner = true, gold = 0, silver = 0, copper = 0 } = {}) {
  return {
    id,
    name: id,
    type: "character",
    documentName: "Actor",
    isOwner: owner,
    system: {
      currency: {
        gold: { value: gold },
        silver: { value: silver },
        copper: { value: copper }
      }
    },
    ownership: {}
  };
}

test("read-only STAT rendering never persists normalized condition data", async () => {
  const { persistNormalizedCustomConditions } = await import("../scripts/conditions/main.js");
  let updates = 0;
  const actor = {
    async update() {
      updates += 1;
      throw new Error("read-only actor must not be updated");
    }
  };

  assert.equal(await persistNormalizedCustomConditions(actor, [{ id: "condition" }], {
    changed: true,
    editable: false
  }), false);
  assert.equal(updates, 0);

  assert.equal(await persistNormalizedCustomConditions(actor, [], {
    changed: false,
    editable: true
  }), false);
  assert.equal(updates, 0);
});

test("world reference cleanup runs only on the deterministic active GM", async () => {
  const previousGame = globalThis.game;
  try {
    let setFlagCalls = 0;
    const actor = {
      id: "actor-1",
      type: "character",
      items: [],
      getFlag(_scope, key) {
        return key === "slots" ? ["missing-item"] : [];
      },
      async setFlag() {
        setFlagCalls += 1;
      }
    };
    const users = [
      { id: "gm-a", isGM: true, active: true },
      { id: "gm-b", isGM: true, active: true }
    ];
    users.get = (id) => users.find((user) => user.id === id);

    globalThis.game = { user: users[1], users, actors: [actor] };
    const { pruneWorldActorReferences } = await import("../scripts/data-hygiene.js");
    assert.deepEqual(await pruneWorldActorReferences(), { actorsChecked: 0, actorsChanged: 0 });
    assert.equal(setFlagCalls, 0);

    globalThis.game.user = users[0];
    assert.deepEqual(await pruneWorldActorReferences(), { actorsChecked: 1, actorsChanged: 1 });
    assert.equal(setFlagCalls, 1);
  } finally {
    globalThis.game = previousGame;
  }
});

test("money transfer reports socket emission failure immediately and clears its timeout", async () => {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  try {
    const sourceActor = makeCurrencyActor("source", { gold: 2 });
    const targetActor = makeCurrencyActor("target", { owner: false });
    const requester = { id: "player-a", isGM: false, active: true, character: sourceActor };
    const recipient = {
      id: "player-b",
      isGM: false,
      active: true,
      character: targetActor
    };
    const gm = { id: "gm-a", isGM: true, active: true };
    targetActor.ownership[recipient.id] = 3;
    targetActor.testUserPermission = (user, permission) => user.id === recipient.id && permission === "OWNER";

    const users = [requester, recipient, gm];
    users.get = (id) => users.find((user) => user.id === id);
    const actors = new Map([[sourceActor.id, sourceActor], [targetActor.id, targetActor]]);

    globalThis.ui = { notifications: {} };
    globalThis.game = {
      user: requester,
      users,
      actors,
      socket: {
        emit() {
          throw new Error("socket transport failed");
        }
      }
    };

    const { requestMoneyTransfer } = await import("../scripts/money-transfer.js");
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      const result = await requestMoneyTransfer(sourceActor.id, targetActor.id, { gold: 1 });
      assert.deepEqual(result, { ok: false, error: "socket-unavailable" });
    } finally {
      console.error = previousConsoleError;
    }
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
});
