import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MODULE_ID } from "../scripts/constants.js";
import { createSocketProof, verifySocketProof } from "../scripts/socket-auth.js";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";

let moduleInstance = 0;

function loadTransfers() {
  return import(`../scripts/money-transfer.js?receipts=${++moduleInstance}`);
}

function makeUser(id, character = null) {
  const flags = new Map();
  return {
    id, character, active: true, isGM: !character,
    getFlag: (scope, key) => flags.get(`${scope}.${key}`),
    async setFlag(scope, key, value) { flags.set(`${scope}.${key}`, structuredClone(value)); },
    async unsetFlag(scope, key) { flags.delete(`${scope}.${key}`); }
  };
}

function applyPatch(document, updates) {
  for (const [path, value] of Object.entries(updates)) {
    if (path === "_id") continue;
    const parts = path.split(".");
    const key = parts.pop();
    const target = parts.reduce((object, part) => object[part] ??= {}, document);
    if (key.startsWith("-=")) delete target[key.slice(2)];
    else target[key] = value;
  }
}

async function setup(context, { asSender = false } = {}) {
  const keys = ["game", "ui", "Hooks", "ChatMessage", "localStorage"];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  context.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const setTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    return delay >= 90_000 ? timer.unref() : timer;
  });
  context.mock.method(console, "error", () => {});

  const state = { updates: [], veto: () => false, packets: [], emitFails: false };
  class Actor {
    constructor(id, gold) {
      this.id = this.name = id;
      this.type = "character";
      this.isOwner = true;
      this.flags = {};
      this.system = { currency: { gold: { value: gold }, silver: { value: 0 }, copper: { value: 0 } } };
    }
    testUserPermission(user) { return user.isGM || user.character?.id === this.id; }
    static async updateDocuments(updates) {
      state.updates.push(structuredClone(updates));
      const applied = [];
      for (const update of updates) {
        if (state.veto(update)) continue;
        const actor = game.actors.get(update._id);
        applyPatch(actor, update);
        applied.push(actor);
      }
      return applied;
    }
  }
  const source = new Actor("source", 5);
  const target = new Actor("target", 1);
  const sender = makeUser("sender", source);
  const recipient = makeUser("recipient", target);
  const gm = makeUser("gm");
  const actors = new Map([[source.id, source], [target.id, target]]);
  const users = [sender, recipient, gm];
  const storage = createMemoryStorage();
  const waiting = new Map();
  let socketListener;
  globalThis.game = {
    user: asSender ? sender : gm, world: { id: "mock-world" }, users, actors,
    i18n: { localize: key => key, format: key => key },
    socket: {
      on(_channel, handler) { socketListener = handler; },
      emit(_channel, packet) {
        if (state.emitFails) throw new Error("socket offline");
        state.packets.push(structuredClone(packet));
        waiting.get(packet.type)?.(packet);
        waiting.delete(packet.type);
      }
    }
  };
  globalThis.ui = { notifications: {} };
  globalThis.Hooks = { callAll() {} };
  globalThis.ChatMessage = undefined;
  globalThis.localStorage = storage;

  const transfers = await loadTransfers();
  transfers.registerMoneyTransferSocket();
  const waitForPacket = type => new Promise(resolve => waiting.set(type, resolve));

  async function acceptOffer(requestId, gold, receiver = recipient) {
    const identity = { requestId, requesterId: sender.id, recipientUserId: receiver.id, primaryGmId: gm.id };
    const offer = {
      type: "wallet-transfer-offer", ...identity, sourceActorId: source.id, targetActorId: receiver.character.id,
      amounts: { gold, silver: 0, copper: 0 }, createdAt: Date.now()
    };
    const decision = { type: "wallet-transfer-decision", ...identity, accepted: true, reason: null, createdAt: Date.now() };
    await createSocketProof("walletTransferOffer", requestId, offer, sender);
    await createSocketProof("walletTransferDecision", requestId, decision, receiver);
    const packet = waitForPacket("wallet-transfer-result");
    socketListener(offer);
    socketListener(decision);
    return (await packet).result;
  }

  async function deliverResult(offer, result) {
    const { requestId, requesterId, recipientUserId, primaryGmId, sourceActorId, targetActorId } = offer;
    const packet = {
      type: "wallet-transfer-result", requestId, requesterId, recipientUserId, primaryGmId,
      sourceActorId, targetActorId, createdAt: Date.now(), result
    };
    await createSocketProof("walletTransferResult", requestId, packet, gm);
    socketListener(packet);
  }

  return { Actor, transfers, source, target, sender, users, actors, state, storage, acceptOffer, waitForPacket, deliverResult };
}

const goldPath = "system.currency.gold.value";
const readGold = actor => actor.system.currency.gold.value;
const changeGold = (actor, value) => applyPatch(actor, { [goldPath]: value });

test("a throwing sent notification does not cancel the emitted offer", { timeout: 2_000 }, async context => {
  const { transfers, source, target, sender, waitForPacket, deliverResult } = await setup(context, { asSender: true });
  const offered = waitForPacket("wallet-transfer-offer");
  const onSent = context.mock.fn(() => { throw new Error("notification failed"); });
  const response = transfers.requestMoneyTransfer(source.id, target.id, { gold: 2 }, { onSent });
  const { packetId, ...offer } = await offered;
  await setImmediate();
  const proof = verifySocketProof(sender, "walletTransferOffer", offer.requestId, offer);
  const result = { ok: true, amounts: offer.amounts };
  await deliverResult(offer, result);
  assert.deepEqual(await response, result);
  assert.equal(proof.ok, true);
  assert.equal(onSent.mock.callCount(), 1);
});

test("an unrelated wallet edit to the expected balance cannot close reconciliation", { timeout: 2_000 }, async context => {
  const { transfers, source, target, state, acceptOffer } = await setup(context);
  const id = "coincidentally-expected";
  state.veto = update => update._id === target.id;
  assert.equal((await acceptOffer(id, 2)).error, "update-incomplete");
  changeGold(target, 3);
  const resolved = await transfers.resolveMoneyTransferReconciliation(id, { applyRemaining: true });
  assert.equal(resolved.error, "intervening-update");
  assert.equal(transfers.getPendingMoneyTransferReconciliations().length, 1);
  assert.equal(state.updates.length, 1);
  assert.equal(readGold(source), 3);
  assert.equal(readGold(target), 3);
});
