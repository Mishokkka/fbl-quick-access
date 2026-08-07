import test from "node:test";
import assert from "node:assert/strict";

function makeFlagUser(id, { isGM = false, active = true, character = null } = {}) {
  const flags = new Map();
  return {
    id,
    isGM,
    active,
    character,
    async setFlag(scope, key, value) {
      flags.set(`${scope}.${key}`, structuredClone(value));
      return value;
    },
    getFlag(scope, key) {
      return flags.get(`${scope}.${key}`);
    },
    async unsetFlag(scope, key) {
      flags.delete(`${scope}.${key}`);
      return true;
    }
  };
}

function makeUsers(...users) {
  users.get = (id) => users.find((user) => user.id === id);
  return users;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("privileged integration socket rejects forged requester ids and forged results", async () => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;

  let sequence = 0;
  let listener = null;
  const emitted = [];
  const player = makeFlagUser("player-secure");
  const gm = makeFlagUser("gm-secure", { isGM: true });
  const users = makeUsers(player, gm);

  globalThis.Hooks = { callAll() {} };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      objectsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      randomID: () => `secure-request-${++sequence}`
    }
  };
  globalThis.game = {
    user: gm,
    users,
    socket: {
      on(_channel, callback) { listener = callback; },
      emit(_channel, message) { emitted.push(structuredClone(message)); }
    }
  };

  try {
    const api = await import(`../scripts/integration/socket-api.js?security=${Date.now()}`);
    const auth = await import("../scripts/socket-auth.js");
    let executions = 0;
    api.registerSocketHandler("security.echo", async (payload, context) => {
      executions += 1;
      return { payload, requesterId: context.requesterId };
    });
    api.registerIntegrationSocket();

    const forgedRequest = {
      type: "integration-api-request",
      requestId: "forged-request-1",
      operation: "security.echo",
      payload: { amount: 99 },
      requesterId: player.id,
      activeGMId: gm.id,
      createdAt: Date.now()
    };
    listener(forgedRequest);
    await tick();
    assert.equal(executions, 0, "a packet without a User-document proof must not execute on the GM");

    const validRequest = { ...forgedRequest, requestId: "valid-request-1", payload: { amount: 1 } };
    await auth.createSocketProof("integrationRequest", validRequest.requestId, validRequest, player);
    listener(validRequest);
    await tick();
    await tick();
    assert.equal(executions, 1);
    assert.ok(emitted.some((message) => message.type === "integration-api-response" && message.requestId === validRequest.requestId));

    // A requester must likewise ignore an unproved result even when all ids are plausible.
    listener = null;
    emitted.length = 0;
    globalThis.game.user = player;
    const apiClient = await import(`../scripts/integration/socket-api.js?security-client=${Date.now()}`);
    apiClient.registerIntegrationSocket();
    const pending = apiClient.executeAsActiveGM("security.remote", { value: 7 }, { timeoutMs: 1_000 });
    await tick();
    const outbound = emitted.find((message) => message.type === "integration-api-request");
    assert.ok(outbound);

    let settled = false;
    pending.finally(() => { settled = true; });
    const forgedResponse = {
      type: "integration-api-response",
      requestId: outbound.requestId,
      recipientId: player.id,
      activeGMId: gm.id,
      createdAt: Date.now(),
      ok: true,
      result: { forged: true }
    };
    listener(forgedResponse);
    await tick();
    assert.equal(settled, false, "a forged response must not resolve the pending operation");

    const validResponse = { ...forgedResponse, createdAt: Date.now(), result: { forged: false } };
    await auth.createSocketProof("integrationResponse", validResponse.requestId, validResponse, gm);
    listener(validResponse);
    assert.deepEqual(await pending, { forged: false });
  } finally {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
  }
});

test("money-transfer GM path rejects unauthenticated offers and decisions", async () => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  const previousChatMessage = globalThis.ChatMessage;

  let sequence = 0;
  let listener = null;
  const emitted = [];

  class FakeActor {
    static calls = [];
    static async updateDocuments(updates) {
      this.calls.push(structuredClone(updates));
      return updates;
    }

    constructor(id, currency) {
      this.id = id;
      this.uuid = `Actor.${id}`;
      this.name = id;
      this.type = "character";
      this.documentName = "Actor";
      this.system = { currency: structuredClone(currency) };
      this.ownership = { default: 0 };
    }

    testUserPermission(user, permission) {
      return permission === "OWNER" && Number(this.ownership[user.id] ?? this.ownership.default ?? 0) >= 3;
    }
  }

  const source = new FakeActor("source-secure", {
    gold: { value: 2 }, silver: { value: 0 }, copper: { value: 0 }
  });
  const target = new FakeActor("target-secure", {
    gold: { value: 0 }, silver: { value: 0 }, copper: { value: 0 }
  });
  const requester = makeFlagUser("sender-secure", { character: source });
  const recipient = makeFlagUser("recipient-secure", { character: target });
  const gm = makeFlagUser("gm-transfer-secure", { isGM: true });
  source.ownership[requester.id] = 3;
  target.ownership[recipient.id] = 3;
  const users = makeUsers(requester, recipient, gm);
  const actors = new Map([[source.id, source], [target.id, target]]);

  globalThis.Hooks = { callAll() {} };
  globalThis.ChatMessage = undefined;
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      objectsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      randomID: () => `packet-${++sequence}`
    }
  };
  globalThis.game = {
    user: gm,
    users,
    actors,
    socket: {
      on(_channel, callback) { listener = callback; },
      emit(_channel, message) { emitted.push(structuredClone(message)); }
    }
  };

  try {
    const transfer = await import(`../scripts/money-transfer.js?security=${Date.now()}`);
    const auth = await import("../scripts/socket-auth.js");
    transfer.registerMoneyTransferSocket();

    const offerBase = {
      type: "wallet-transfer-offer",
      requesterId: requester.id,
      recipientUserId: recipient.id,
      primaryGmId: gm.id,
      sourceActorId: source.id,
      targetActorId: target.id,
      amounts: { gold: 1, silver: 0, copper: 0 },
      createdAt: Date.now()
    };

    const forgedOffer = { ...offerBase, requestId: "forged-transfer-1", packetId: "packet-forged-offer" };
    listener(forgedOffer);
    listener({
      type: "wallet-transfer-decision",
      requestId: forgedOffer.requestId,
      requesterId: requester.id,
      recipientUserId: recipient.id,
      primaryGmId: gm.id,
      accepted: true,
      reason: null,
      createdAt: Date.now(),
      packetId: "packet-forged-decision"
    });
    await tick();
    assert.equal(FakeActor.calls.length, 0);

    const validOffer = { ...offerBase, requestId: "valid-transfer-1" };
    await auth.createSocketProof("walletTransferOffer", validOffer.requestId, validOffer, requester);
    listener({ ...validOffer, packetId: "packet-valid-offer" });
    await tick();

    const validDecision = {
      type: "wallet-transfer-decision",
      requestId: validOffer.requestId,
      requesterId: requester.id,
      recipientUserId: recipient.id,
      primaryGmId: gm.id,
      accepted: true,
      reason: null,
      createdAt: Date.now()
    };
    await auth.createSocketProof("walletTransferDecision", validDecision.requestId, validDecision, recipient);

    const originalGmSetFlag = gm.setFlag.bind(gm);
    let resultProofAttempts = 0;
    gm.setFlag = async (scope, key, value) => {
      if (key.includes("walletTransferResult")) {
        resultProofAttempts += 1;
        if (resultProofAttempts === 1) throw new Error("transient result-proof failure");
      }
      return originalGmSetFlag(scope, key, value);
    };

    listener({ ...validDecision, packetId: "packet-valid-decision" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await tick();

    assert.equal(FakeActor.calls.length, 1);
    assert.equal(FakeActor.calls[0].length, 2, "both wallets must be updated in one embedded batch");
    assert.equal(resultProofAttempts, 2, "result proof creation should receive one bounded retry");
    assert.ok(emitted.some((message) => message.type === "wallet-transfer-result" && message.requestId === validOffer.requestId));
  } finally {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
    globalThis.ChatMessage = previousChatMessage;
  }
});

test("biography rich text is sanitized before rendering and persistence", async () => {
  const previousFoundry = globalThis.foundry;
  const previousDocument = globalThis.document;
  try {
    delete globalThis.foundry;
    delete globalThis.document;
    const biography = await import(`../scripts/biography.js?security=${Date.now()}`);
    const malicious = `<p onclick="steal()">Text<a href="java\nscript:steal()">bad</a><img src=x onerror=steal()></p><svg/onload=steal()><script>steal()</script>`;
    const clean = biography.sanitizeBiographyRichHtml(malicious);
    assert.doesNotMatch(clean, /script|onclick|onerror|javascript|<svg|\/\/evil\.example/iu);

    let update = null;
    const actor = {
      name: "Actor",
      async update(value) { update = value; },
      getFlag() { return null; },
      system: { bio: {} }
    };
    await biography.saveBiographyProfile(actor, { pride: malicious, darkSecret: malicious, publicNote: malicious });
    assert.ok(update);
    for (const key of ["system.bio.pride.value", "system.bio.darkSecret.value", "system.bio.note.value"]) {
      assert.doesNotMatch(update[key], /script|onclick|onerror|javascript|<svg/iu);
    }

    globalThis.foundry = { utils: { cleanHTML: () => "<p>foundry-clean</p>" } };
    assert.equal(biography.sanitizeBiographyRichHtml("<script>bad</script>"), "<p>foundry-clean</p>");
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.document = previousDocument;
  }
});


test("item tooltip sanitizes TextEditor enrichment before inserting rich HTML", async () => {
  const previousFoundry = globalThis.foundry;
  const previousTextEditor = globalThis.TextEditor;
  const previousGame = globalThis.game;
  const previousConfig = globalThis.CONFIG;
  const previousDocument = globalThis.document;

  try {
    globalThis.CONFIG = { fbl: { encumbrance: {} } };
    globalThis.document = {
      createElement() {
        return {
          set innerHTML(value) {
            this.textContent = String(value).replace(/<[^>]*>/gu, "");
          },
          textContent: "",
          innerText: ""
        };
      }
    };
    globalThis.game = {
      i18n: { localize: (key) => key },
      settings: { settings: new Map(), get: () => true }
    };
    globalThis.TextEditor = {
      async enrichHTML() {
        return `<p>safe</p><img src=x onerror="steal()"><script>steal()</script>`;
      }
    };
    let cleanCalls = 0;
    globalThis.foundry = {
      utils: {
        cleanHTML(_html) {
          cleanCalls += 1;
          return "<p>safe</p>";
        }
      }
    };

    const { buildItemTooltipHtml } = await import(`../scripts/item-utils.js?tooltip-security=${Date.now()}`);
    const item = {
      id: "talent-secure",
      name: "Talent",
      type: "talent",
      isOwner: true,
      system: { description: "Unsafe description" },
      flags: {}
    };
    const html = await buildItemTooltipHtml(item);
    assert.equal(cleanCalls, 1);
    assert.doesNotMatch(html, /<script|onerror=/iu);
    assert.match(html, /<p>safe<\/p>/u);

    delete globalThis.foundry;
    const escaped = await buildItemTooltipHtml(item);
    assert.doesNotMatch(escaped, /<script|onerror=/iu);
    assert.match(escaped, /Unsafe description/u);
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.TextEditor = previousTextEditor;
    globalThis.game = previousGame;
    globalThis.CONFIG = previousConfig;
    globalThis.document = previousDocument;
  }
});

test("recipient transfer accept and Dialog close emit only one decision", async () => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  const previousDialog = globalThis.Dialog;
  const previousUi = globalThis.ui;

  let listener = null;
  let dialogData = null;
  const emitted = [];
  let sequence = 0;

  const target = {
    id: "recipient-race-actor",
    name: "Recipient",
    type: "character",
    ownership: { "recipient-race": 3 },
    testUserPermission(user, permission) {
      return permission === "OWNER" && Number(this.ownership[user.id] ?? 0) >= 3;
    }
  };
  const source = { id: "sender-race-actor", name: "Sender", type: "character", system: { currency: {} } };
  const requester = makeFlagUser("sender-race", { character: source });
  const recipient = makeFlagUser("recipient-race", { character: target });
  const gm = makeFlagUser("gm-race", { isGM: true });
  const users = makeUsers(requester, recipient, gm);
  const actors = new Map([[source.id, source], [target.id, target]]);

  class FakeDialog {
    constructor(data) { dialogData = data; }
    render() { return this; }
  }

  globalThis.Hooks = { callAll() {} };
  globalThis.Dialog = FakeDialog;
  globalThis.ui = { notifications: { error() {} } };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      objectsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      randomID: () => `race-packet-${++sequence}`
    }
  };
  globalThis.game = {
    user: recipient,
    users,
    actors,
    i18n: { localize: (key) => key, format: (_key, data) => JSON.stringify(data) },
    socket: {
      on(_channel, callback) { listener = callback; },
      emit(_channel, message) { emitted.push(structuredClone(message)); }
    }
  };

  try {
    const transfer = await import(`../scripts/money-transfer.js?recipient-race=${Date.now()}`);
    const auth = await import("../scripts/socket-auth.js");
    transfer.registerMoneyTransferSocket();

    const offer = {
      type: "wallet-transfer-offer",
      requestId: "recipient-race-1",
      requesterId: requester.id,
      recipientUserId: recipient.id,
      primaryGmId: gm.id,
      sourceActorId: source.id,
      targetActorId: target.id,
      amounts: { gold: 1, silver: 0, copper: 0 },
      createdAt: Date.now()
    };
    await auth.createSocketProof("walletTransferOffer", offer.requestId, offer, requester);
    listener({ ...offer, packetId: "recipient-race-offer-packet" });
    await tick();
    assert.ok(dialogData, "recipient confirmation dialog should open");

    const acceptPromise = dialogData.buttons.accept.callback();
    dialogData.close();
    await acceptPromise;
    await tick();

    const decisions = emitted.filter((message) => message.type === "wallet-transfer-decision");
    assert.equal(decisions.length, 1, "button submit and Dialog close must not race into accept + decline packets");
    assert.equal(decisions[0].accepted, true);
  } finally {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
    globalThis.Dialog = previousDialog;
    globalThis.ui = previousUi;
  }
});

test("sender transfer submit survives Dialog close and rejects duplicate submit", async () => {
  const previousGame = globalThis.game;
  const previousDialog = globalThis.Dialog;
  const previousUi = globalThis.ui;
  const previousHTMLElement = globalThis.HTMLElement;

  let dialogData = null;
  let infoCount = 0;

  class FakeHTMLElement {
    querySelector(selector) {
      if (selector === "form.fblqa-money-transfer-form") return this;
      if (selector === '[name="targetActor"]') return { value: "target-submit" };
      if (selector.startsWith('[name="amount-')) return { value: "0" };
      return null;
    }
  }

  class FakeDialog {
    constructor(data) { dialogData = data; }
    render() { return this; }
  }

  const source = {
    id: "source-submit",
    name: "Source",
    type: "character",
    isOwner: true,
    system: { currency: { gold: { value: 1 }, silver: { value: 0 }, copper: { value: 0 } } }
  };
  const target = {
    id: "target-submit",
    name: "Target",
    type: "character",
    ownership: { "recipient-submit": 3 },
    testUserPermission(user, permission) {
      return permission === "OWNER" && Number(this.ownership[user.id] ?? 0) >= 3;
    }
  };
  const requester = { id: "requester-submit", isGM: false, active: true, character: source };
  const recipient = { id: "recipient-submit", isGM: false, active: true, character: target };
  const users = makeUsers(requester, recipient);

  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.Dialog = FakeDialog;
  globalThis.ui = {
    notifications: {
      info() { infoCount += 1; },
      warn() {},
      error() {}
    }
  };
  globalThis.game = {
    user: requester,
    users,
    actors: new Map([[source.id, source], [target.id, target]]),
    i18n: { localize: (key) => key, format: (_key, data) => JSON.stringify(data) }
  };

  try {
    const transfer = await import(`../scripts/money-transfer.js?sender-submit=${Date.now()}`);
    const resultPromise = transfer.openMoneyTransferDialog(null, source);
    assert.ok(dialogData, "sender dialog should be created");

    const html = new FakeHTMLElement();
    const first = dialogData.buttons.send.callback(html);
    const second = dialogData.buttons.send.callback(html);
    dialogData.close();

    const result = await resultPromise;
    await first;
    await second;
    assert.equal(result?.error, "empty-amount", "Dialog close must not replace the submitted result with null");
    assert.equal(infoCount, 1, "rapid duplicate submit must start only one transfer attempt");
  } finally {
    globalThis.game = previousGame;
    globalThis.Dialog = previousDialog;
    globalThis.ui = previousUi;
    globalThis.HTMLElement = previousHTMLElement;
  }
});
