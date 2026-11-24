import test from "node:test";
import assert from "node:assert/strict";

const hookCalls = [];
globalThis.Hooks = {
  callAll: (...args) => hookCalls.push(args)
};

globalThis.game = {
  user: { id: "gm-b", isGM: true, active: true },
  users: [
    { id: "gm-b", isGM: true, active: true },
    { id: "player", isGM: false, active: true },
    { id: "gm-a", isGM: true, active: true }
  ],
  modules: new Map(),
  actors: new Map()
};

globalThis.foundry = {
  utils: {
    deepClone: (value) => structuredClone(value),
    randomID: () => "request-id"
  }
};

const socketApi = await import("../scripts/integration/socket-api.js");
const statApi = await import("../scripts/integration/stat-providers.js");
const newDayApi = await import("../scripts/integration/new-day-providers.js");

test("active GM selection is deterministic", () => {
  assert.equal(socketApi.getActiveGM(game.users).id, "gm-a");
  assert.equal(socketApi.getActiveGM([{ id: "p", active: true, isGM: false }]), null);
});

test("local active-GM operations execute registered handlers and preserve context", async () => {
  game.user = game.users.find((user) => user.id === "gm-a");
  const unregister = socketApi.registerSocketHandler("test.integration.echo", async (payload, context) => ({
    payload,
    requesterId: context.requesterId,
    isRemote: context.isRemote
  }));

  const result = await socketApi.executeAsActiveGM("test.integration.echo", { value: 7 });
  assert.deepEqual(result, {
    payload: { value: 7 },
    requesterId: "gm-a",
    isRemote: false
  });
  assert.throws(() => socketApi.registerSocketHandler("test.integration.echo", () => {}), /already registered/i);
  assert.equal(unregister(), undefined);
});

function remoteGMFixture(t, setFlag, connected = true) {
  const previousUser = game.user;
  const previousSocket = game.socket;
  const sent = [];
  const cleared = [];
  const disconnectListeners = new Set();
  const socket = {
    connected,
    on(event, listener) { if (event === "disconnect") disconnectListeners.add(listener); },
    off(event, listener) { if (event === "disconnect") disconnectListeners.delete(listener); },
    emit(...args) { sent.push(args); }
  };
  game.socket = socket;
  game.user = {
    id: "player",
    setFlag,
    async unsetFlag(_scope, key) { cleared.push(key); }
  };
  t.after(() => {
    game.user = previousUser;
    game.socket = previousSocket;
  });
  return { socket, sent, cleared, disconnectListeners };
}

test("disconnected clients start neither addressed requests nor User flag proofs", async t => {
  let proofAttempts = 0;
  const { sent } = remoteGMFixture(t, async () => {
    proofAttempts += 1;
    throw new Error("Unexpected User flag write");
  }, false);

  for (const addressed of [false, true]) {
    const operation = `test.integration.disconnected-${addressed}`;
    const unregister = socketApi.registerSocketHandler(operation, () => {}, { addressed });
    t.after(unregister);
    await assert.rejects(socketApi.executeAsActiveGM(operation), { code: "socket-unavailable" });
  }
  assert.equal(proofAttempts, 0);
  assert.deepEqual(sent, []);
});

for (const interruption of ["disconnect", "timeout"]) {
  test(`unaddressed GM requests stop on ${interruption} while the User flag write is pending`, async t => {
    if (interruption === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const proof = Promise.withResolvers();
    let proofAttempts = 0;
    const { socket, sent, cleared, disconnectListeners } = remoteGMFixture(t, () => {
      proofAttempts += 1;
      return proof.promise;
    });
    const operation = `test.integration.proof-${interruption}`;
    const unregister = socketApi.registerSocketHandler(operation, () => {});
    t.after(unregister);

    const request = socketApi.executeAsActiveGM(operation, {}, { timeoutMs: 1_000 });
    const rejected = assert.rejects(request, {
      code: interruption === "timeout" ? "timeout" : "outcome-unknown"
    });
    assert.equal(proofAttempts, 1);
    assert.equal(disconnectListeners.size, 1);

    if (interruption === "timeout") {
      t.mock.timers.tick(1_000);
    } else {
      socket.connected = false;
      for (const listener of disconnectListeners) listener();
    }
    await rejected;
    assert.equal(disconnectListeners.size, 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(cleared, []);

    socket.connected = true;
    proof.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, []);
    assert.deepEqual(cleared, ["socketProofs.integrationRequest.request-id"]);
  });
}

test("STAT providers render in numeric order inside isolated wrappers", async () => {
  const removeLate = statApi.registerStatProvider({
    id: "test-stat-late",
    order: 20,
    render: async () => "<div>late</div>"
  });
  const removeEarly = statApi.registerStatProvider({
    id: "test-stat-early",
    order: 10,
    render: async () => "<div>early</div>",
    activateListeners: () => {}
  });

  const result = await statApi.renderStatProviderSections({ app: {}, actor: {}, editable: true });
  assert.ok(result.html.indexOf("test-stat-early") < result.html.indexOf("test-stat-late"));
  assert.match(result.html, /data-fblqa-stat-provider="test-stat-early"/);
  assert.match(result.html, /<div>early<\/div>/);
  assert.deepEqual(result.providers.map((provider) => provider.id), ["test-stat-early", "test-stat-late"]);

  assert.equal(removeEarly(), true);
  assert.equal(removeLate(), true);
  assert.ok(hookCalls.some(([name]) => name === "fblQuickAccess.statProviderRegistered"));
});

test("new-day providers namespace actions and expose category metadata", () => {
  const unregister = newDayApi.registerNewDayProvider({
    id: "test-disease-provider",
    category: "diseases",
    categoryLabel: "Diseases",
    order: 400,
    async buildActions() { return []; },
    async applyAction() { return { changed: true }; },
    describeAction(action) { return action.description; },
    icon() { return "fas fa-virus"; }
  });

  const provider = newDayApi.getNewDayProvider("test-disease-provider");
  const actions = newDayApi.normalizeProviderActions(provider, [{
    id: "case-1",
    name: "Illness",
    description: "Advance disease"
  }]);

  assert.equal(actions[0].id, "provider:test-disease-provider:case-1");
  assert.equal(actions[0].providerId, "test-disease-provider");
  assert.equal(actions[0].category, "diseases");
  assert.equal(actions[0].itemName, "Illness");
  assert.deepEqual(newDayApi.getNewDayProviderCategory(provider), {
    id: "diseases",
    order: 400,
    label: "Diseases"
  });
  assert.equal(newDayApi.getNewDayProviderIcon(actions[0]), "fa-virus");
  assert.equal(newDayApi.describeNewDayProviderAction(actions[0]), "Advance disease");
  assert.equal(unregister(), true);
});

test("New Day returns missing-actor for a removed synthetic UUID and still accepts an ID-only request", async t => {
  const previousUser = game.user;
  const previousFromUuid = globalThis.fromUuid;
  game.user = game.users.find(user => user.id === "gm-a");
  const baseActor = { id: "base-actor", uuid: "Actor.base-actor", documentName: "Actor" };
  game.actors.set(baseActor.id, baseActor);
  const tokenActorUuid = "Scene.scene.Token.removed.Actor.base-actor";
  const resolvedUuids = [];
  globalThis.fromUuid = async uuid => {
    resolvedUuids.push(uuid);
    return null;
  };
  const builtFor = [];
  newDayApi.initializeNewDayProviderBridge();
  const providerId = "test-removed-token";
  const unregister = newDayApi.registerNewDayProvider({
    id: providerId,
    category: "test",
    buildActions(actor) { builtFor.push(actor); return []; },
    applyAction() {},
    describeAction() {},
    icon() {}
  });
  t.after(() => {
    unregister();
    game.actors.delete(baseActor.id);
    game.user = previousUser;
    globalThis.fromUuid = previousFromUuid;
  });

  const operation = "integration.new-day.build-provider";
  const payload = { providerId, actorId: baseActor.id };
  await assert.rejects(socketApi.executeAsActiveGM(operation, { ...payload, actorUuid: tokenActorUuid }), {
    code: "missing-actor"
  });
  assert.deepEqual(builtFor, []);
  assert.deepEqual(resolvedUuids, [tokenActorUuid]);
  await assert.doesNotReject(socketApi.executeAsActiveGM(operation, payload));
  assert.deepEqual(builtFor, [baseActor]);
});
