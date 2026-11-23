import test from "node:test";
import assert from "node:assert/strict";
import { enqueueActorMutation, enqueueCurrencyOperation } from "../scripts/operation-queue.js";
import { executeActorOperation } from "../scripts/integration/socket-api.js";

test("the Actor queue serializes the same world Actor and isolates synthetic Actors and currency", { timeout: 1_000 }, async () => {
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = enqueueActorMutation({ uuid: "Actor.shared" }, async () => {
    calls.push("first");
    await held;
    throw new Error("write failed");
  });
  const failed = assert.rejects(first, /write failed/);
  const second = enqueueActorMutation("shared", () => calls.push("second"));
  await enqueueActorMutation({ id: "shared", uuid: "Scene.scene.Token.token.Actor.shared" }, () => calls.push("token"));
  await enqueueCurrencyOperation(() => calls.push("currency"));
  assert.deepEqual(calls, ["first", "token", "currency"]);
  release();
  await Promise.all([failed, second]);
  assert.deepEqual(calls, ["first", "token", "currency", "second"]);
});

test("an Actor edit waiting locally is routed to a GM who becomes active", async t => {
  const previous = globalThis.game;
  t.after(() => { globalThis.game = previous; });
  const player = { id: "owner", active: true, async setFlag() {}, getFlag() {}, async unsetFlag() {} };
  const actor = { id: "character", uuid: "Actor.character", isOwner: true };
  const sent = [];
  globalThis.game = { user: player, users: [player], socket: {
    on() {}, emit(_channel, message) { sent.push(message); throw new Error("Test transport has no server"); }
  } };
  let release;
  const holding = new Promise(resolve => { release = resolve; });
  const first = enqueueActorMutation(actor, () => holding);
  const edit = executeActorOperation(actor, "conditions.stat", { kind: "layout", columns: 2 }, () => {
    assert.fail("The edit must use the active GM");
  });
  game.users.push({ id: "gm", isGM: true, active: true });
  release();
  await first;
  await assert.rejects(edit, { code: "socket-emit-failed" });
  assert.equal(sent[0].activeGMId, "gm");
  assert.equal(sent[0].operation, "conditions.stat");
  assert.deepEqual(sent[0].payload, { kind: "layout", columns: 2, actorUuid: "Actor.character", actorId: "character" });
});
