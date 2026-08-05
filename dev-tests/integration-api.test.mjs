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
