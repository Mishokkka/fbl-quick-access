import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function saveGlobals(keys) {
  const snapshot = new Map();
  for (const key of keys) {
    snapshot.set(key, { existed: Object.prototype.hasOwnProperty.call(globalThis, key), value: globalThis[key] });
  }
  return () => {
    for (const [key, entry] of snapshot.entries()) {
      if (entry.existed) globalThis[key] = entry.value;
      else delete globalThis[key];
    }
  };
}

function makeOrdinalApi() {
  const toOrdinal = (d) => d.year * 360 + (d.month - 1) * 30 + (d.day - 1);
  const fromOrdinal = (n) => {
    const year = Math.floor(n / 360);
    const rem = ((n % 360) + 360) % 360;
    const month = Math.floor(rem / 30) + 1;
    const day = (rem % 30) + 1;
    return { year, month, day };
  };
  return {
    daysBetween: (start, end) => toOrdinal(end) - toOrdinal(start),
    addDays: (date, delta) => fromOrdinal(toOrdinal(date) + delta),
    formatDate: (date) => `${date.day}.${date.month}.${date.year}`
  };
}

function getNested(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.hasOwn(obj, key)) return obj[key];
  let cursor = obj;
  for (const part of String(key).split(".")) {
    if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setNested(obj, key, value) {
  const parts = String(key).split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (last.startsWith("-=")) delete cursor[last.slice(2)];
  else cursor[last] = structuredClone(value);
}

function expandUpdateInPlace(update, id) {
  for (const [key, value] of Object.entries(update)) {
    if (!key.includes(".")) continue;
    delete update[key];
    setNested(update, key, value);
  }
  update._id = id;
}

function deleteNested(obj, key) {
  if (!obj || typeof obj !== "object") return;
  if (Object.hasOwn(obj, key)) {
    delete obj[key];
    return;
  }
  const parts = String(key).split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = cursor[parts[i]];
  }
  if (cursor && typeof cursor === "object") delete cursor[parts[parts.length - 1]];
}

function makeFlaggedUser(overrides = {}) {
  const flags = overrides._flags ?? {};
  return {
    id: overrides.id ?? "user-1",
    name: overrides.name ?? "User",
    isGM: Boolean(overrides.isGM),
    active: overrides.active !== false,
    character: overrides.character ?? null,
    getFlag(scope, key) {
      return getNested(flags[scope], key);
    },
    async setFlag(scope, key, value) {
      flags[scope] ??= {};
      setNested(flags[scope], key, value);
      return this;
    },
    async unsetFlag(scope, key) {
      deleteNested(flags[scope], key);
      return this;
    }
  };
}

function mergeFoundryObject(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return structuredClone(source);
  const base = target && typeof target === "object" && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      base[k] = mergeFoundryObject(base[k], v);
    } else {
      base[k] = structuredClone(v);
    }
  }
  return base;
}

function setNestedFoundry(obj, path, value, { forceReplace = false } = {}) {
  const parts = String(path).split(".");
  let leaf = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  if (leaf.startsWith("-=")) {
    delete cur[leaf.slice(2)];
    return;
  }
  const replace = forceReplace || leaf.startsWith("==");
  if (leaf.startsWith("==")) leaf = leaf.slice(2);
  if (!replace && value && typeof value === "object" && !Array.isArray(value) && cur[leaf] && typeof cur[leaf] === "object" && !Array.isArray(cur[leaf])) {
    cur[leaf] = mergeFoundryObject(cur[leaf], value);
  } else {
    cur[leaf] = structuredClone(value);
  }
}

function makeFlaggedActor(overrides = {}) {
  const flags = overrides._flags ?? {};
  const { _flags, cancelSetFlag, cancelUnsetFlag, cancelUpdate, ...rest } = overrides;
  return {
    id: rest.id ?? "actor-1",
    uuid: rest.uuid ?? `Actor.${rest.id ?? "actor-1"}`,
    name: rest.name ?? "Tester",
    documentName: "Actor",
    type: "character",
    isOwner: true,
    pack: null,
    system: rest.system ?? {},
    items: rest.items ?? [],
    effects: rest.effects ?? [],
    getFlag(scope, key) {
      return getNested(flags[scope], key);
    },
    async setFlag(scope, key, value) {
      if (cancelSetFlag) return undefined;
      flags[scope] ??= {};
      setNestedFoundry(flags[scope], key, value, { forceReplace: false });
      return this;
    },
    async unsetFlag(scope, key) {
      if (cancelUnsetFlag) return undefined;
      deleteNested(flags[scope], key);
      return this;
    },
    async update(data) {
      if (cancelUpdate) return undefined;
      for (const [path, value] of Object.entries(data ?? {})) {
        const parts = path.split(".");
        if (parts[0] === "flags" && parts.length >= 3) {
          const scope = parts[1];
          const key = parts.slice(2).join(".");
          flags[scope] ??= {};
          setNestedFoundry(flags[scope], key, value);
          continue;
        }
        setNestedFoundry(this, path, value);
      }
      return this;
    },
    ...rest
  };
}

test("BIO saves languages and rumors when Foundry expands the update in place", async () => {
  const restore = saveGlobals(["game", "foundry", "ui"]);
  try {
    globalThis.game = {
      user: { id: "player-1", isGM: false },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map()
    };
    globalThis.foundry = {
      utils: {
        deepClone: (v) => structuredClone(v),
        mergeObject: (a, b) => ({ ...a, ...(b ?? {}) })
      }
    };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    const bio = await import(`../scripts/biography.js?bio-array-fix=${Date.now()}`);
    const actor = makeFlaggedActor({
      id: "bio-array-actor",
      system: { bio: { kin: { value: "Human" }, profession: { value: "Hunter" }, pride: { value: "" }, darkSecret: { value: "" }, note: { value: "" } } }
    });
    let veto = false;
    const update = actor.update;
    actor.update = async function (payload, options) {
      const sent = structuredClone(payload);
      expandUpdateInPlace(payload, this.id);
      if (veto) return undefined;
      return update.call(this, sent, options);
    };

    const state = bio.getBiographyProfile(actor);
    state.languages = [
      { id: "lang-1", languageId: "", name: "Дамийский", level: "full", cost: 2, native: false }
    ];
    state.rumors = [
      { id: "rumor-1", text: "Знает тайную тропу", truth: "uncertain" }
    ];

    bio.queueProfileSave(actor, state, null, 0, "languages");
    bio.queueProfileSave(actor, state, null, 0, "rumors");
    bio.queueProfileSave(actor, state, null, 0, "__proto__.polluted");
    await bio.flushBiographySaves(actor);

    assert.equal(({}).polluted, undefined, "prototype pollution must be rejected");
    const saved = bio.getBiographyProfile(actor);
    assert.equal(saved.languages.length, 1);
    assert.equal(saved.languages[0].name, "Дамийский");
    assert.equal(saved.languages[0].level, "full");
    assert.equal(saved.languages[0].cost, 2);
    assert.equal(saved.rumors.length, 1);
    assert.equal(saved.rumors[0].text, "Знает тайную тропу");

    saved.publicNote = "<p>Verified full profile</p>";
    assert.equal(await bio.saveBiographyProfile(actor, saved), true);
    assert.equal(actor.system.bio.note.value, saved.publicNote);
    veto = true;
    assert.equal(await bio.saveBiographyProfile(actor, { ...saved, publicNote: "<p>Vetoed</p>" }), false);
    assert.equal(actor.system.bio.note.value, saved.publicNote);

    const readonlyActor = makeFlaggedActor({ id: "bio-readonly", isOwner: false });
    const writeResult = await bio.saveBiographyProfile(readonlyActor, saved);
    assert.equal(writeResult, false, "non-owner saveBiographyProfile must refuse write");
    assert.equal(readonlyActor.getFlag("fbl-quick-access", "biographyProfile"), undefined);
  } finally {
    restore();
  }
});

test("STAT verifies embedded injury order independently of Foundry's mutated update", async () => {
  const restore = saveGlobals(["foundry", "game"]);
  try {
    globalThis.foundry = { utils: { deepClone: structuredClone } };
    globalThis.game = { modules: new Map() };
    const { ensureConditionItemOrders } = await import("../scripts/conditions/migrations.js");
    let order;
    let veto = false;
    const injury = {
      id: "wound-1", name: "Broken leg", type: "criticalInjury", system: {},
      getFlag: (_scope, key) => key === "conditions.order" ? order : undefined
    };
    const actor = {
      id: "stat-order-actor", documentName: "Actor", items: [injury],
      async updateEmbeddedDocuments(type, updates) {
        assert.equal(type, "Item");
        assert.equal(updates.length, 1);
        for (const update of updates) {
          expandUpdateInPlace(update, injury.id);
          if (!veto) order = getNested(update, "flags.fbl-quick-access.conditions.order");
        }
      }
    };
    assert.equal((await ensureConditionItemOrders(actor)).changed, true);
    assert.equal(order, 0);
    assert.equal((await ensureConditionItemOrders(actor)).changed, false);
    order = 80;
    veto = true;
    await assert.rejects(ensureConditionItemOrders(actor), /Item condition order was not persisted/);
    assert.equal(order, 80);
  } finally {
    restore();
  }
});

test("Reputation dialog separates save-status from limit-warning, skips non-dirty close writes, and passes rolls to ChatMessage", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "Roll", "ChatMessage"]);
  try {
    let dialogConfig = null;
    const updates = [];

    class FakeDialogV2 {
      constructor(config) {
        dialogConfig = config;
        this.listeners = new Map();
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      render() { return Promise.resolve(this); }
      close() { this.listeners.get("close")?.(); return Promise.resolve(this); }
    }

    globalThis.game = {
      user: { id: "player-1", isGM: false },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map(),
      settings: { get: () => false }
    };
    globalThis.foundry = {
      applications: { api: { DialogV2: FakeDialogV2 } },
      utils: { deepClone: (v) => structuredClone(v) }
    };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    const actor = makeFlaggedActor({
      id: "rep-actor",
      system: { bio: { reputation: { value: 2 } } },
      _flags: {
        "fbl-quick-access": {
          reputationEntries: [{ id: "r1", amount: 2, description: "Monster Slayer", location: "Alderland", selected: true }]
        }
      },
      async update(data) {
        updates.push(data);
        return this;
      }
    });

    const rep = await import(`../scripts/reputation.js?rep-fix=${Date.now()}`);
    const dialog = rep.openReputationDialog(null, actor);
    assert.ok(dialogConfig, "Reputation dialog should be instantiated");
    assert.match(dialogConfig.content, /data-role="save-status"/);
    assert.match(dialogConfig.content, /data-role="limit-warning"/);

    await dialog.close();
    assert.equal(updates.length, 0, "closing an unmodified reputation dialog must not write to actor");

    const repSource = readFileSync(join(root, "scripts", "reputation.js"), "utf8");
    assert.match(repSource, /createMessage\.call\(globalThis\.ChatMessage,\s*\{[\s\S]*?rolls:\s*\[roll\]/);
  } finally {
    restore();
  }
});

test("Willpower treats empty/null max as uncapped and unranked Kin talent as rank 1", async () => {
  const restore = saveGlobals(["game"]);
  try {
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map()
    };

    const wp = await import(`../scripts/willpower.js?wp-fix=${Date.now()}`);
    const actor = makeFlaggedActor({
      id: "wp-actor",
      system: {
        attribute: { empathy: { value: 4, max: 4 } },
        bio: { willpower: { value: 2, max: null } }
      },
      items: [
        { id: "kin-1", type: "talent", name: "Adaptive", system: { rank: "" } },
        { id: "prof-1", type: "talent", name: "Path of the Arrow", system: { rank: 3 } }
      ],
      _flags: {
        "fbl-quick-access": {
          willpowerTalents: { kinTalentId: "kin-1", professionalTalentId: "prof-1" }
        }
      }
    });

    const calc = wp.calculateStartWillpower(actor);
    assert.equal(calc.kinRank, 1, "empty-string Kin talent rank must fall back to 1, not 0 or NaN");
    assert.equal(calc.professionalRank, 3);
    // round((2 + ((4 + 3 + 1) / 2)) / 2) = round((2 + 4) / 2) = 3; null max must not clamp to 0!
    assert.equal(calc.value, 3);

    actor.system.bio.willpower.max = "";
    assert.equal(wp.calculateStartWillpower(actor).value, 3, "empty-string max must also stay uncapped");
  } finally {
    restore();
  }
});

test("Money transfer rejects third-party decision abort and surfaces update-incomplete on partial veto", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "ChatMessage", "Actor", "localStorage"]);
  try {
    const emitted = [];
    let socketListener = null;

    const gmUser = makeFlaggedUser({ id: "gm-1", name: "GM", isGM: true });
    const senderUser = makeFlaggedUser({ id: "player-sender", name: "Sender", character: { id: "actor-sender" } });
    const recipientUser = makeFlaggedUser({ id: "player-recipient", name: "Recipient", character: { id: "actor-recipient" } });
    const attackerUser = makeFlaggedUser({ id: "player-attacker", name: "Attacker" });

    const senderActor = makeFlaggedActor({
      id: "actor-sender",
      name: "Sender PC",
      testUserPermission: (u) => u.id === "player-sender" || u.isGM,
      system: { currency: { gold: { value: 5 }, silver: { value: 0 }, copper: { value: 0 } } }
    });
    const recipientActor = makeFlaggedActor({
      id: "actor-recipient",
      name: "Recipient PC",
      cancelUpdate: true,
      testUserPermission: (u) => u.id === "player-recipient" || u.isGM,
      system: { currency: { gold: { value: 1 }, silver: { value: 0 }, copper: { value: 0 } } }
    });

    const users = [gmUser, senderUser, recipientUser, attackerUser];
    users.get = (id) => users.find((u) => u.id === id) ?? null;
    const actors = [senderActor, recipientActor];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;

    // Simulate a partial single-sided veto in Actor.updateDocuments: sender is updated, recipient is silently vetoed.
    class FakeActorClass {
      static async updateDocuments(updates) {
        const applied = [];
        for (const patch of updates) {
          const target = actors.get(patch._id);
          if (!target) continue;
          const { _id, ...data } = patch;
          const res = await target.update(data);
          if (res) applied.push(res);
        }
        return applied;
      }
    }
    senderActor.constructor = FakeActorClass;
    recipientActor.constructor = FakeActorClass;
    globalThis.Actor = FakeActorClass;
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.ChatMessage = { async create() {} };
    globalThis.localStorage = createMemoryStorage();
    globalThis.game = {
      user: gmUser,
      world: { id: "audit-world" },
      users,
      actors,
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map(),
      socket: {
        on(_ch, fn) { socketListener = fn; },
        emit(_ch, msg) { emitted.push(structuredClone(msg)); }
      }
    };

    const { createSocketProof } = await import("../scripts/socket-auth.js");
    const mt = await import(`../scripts/money-transfer.js?mt-sec=${Date.now()}`);
    mt.registerMoneyTransferSocket();
    assert.ok(socketListener);

    const requestId = "tx-dos-check-1";
    const offer = {
      type: "wallet-transfer-offer",
      requestId,
      requesterId: senderUser.id,
      recipientUserId: recipientUser.id,
      primaryGmId: gmUser.id,
      sourceActorId: senderActor.id,
      targetActorId: recipientActor.id,
      amounts: { gold: 2, silver: 0, copper: 0 },
      createdAt: Date.now()
    };
    await createSocketProof("walletTransferOffer", requestId, offer, senderUser);
    await socketListener({ ...offer, packetId: "pkt-offer-1" });
    await new Promise((r) => setTimeout(r, 20));

    // Attacker sends a forged decline decision for the same requestId -> GM must ignore it!
    const forgedDecision = {
      type: "wallet-transfer-decision",
      requestId,
      requesterId: senderUser.id,
      recipientUserId: attackerUser.id,
      primaryGmId: gmUser.id,
      accepted: false,
      reason: "declined",
      createdAt: Date.now()
    };
    await createSocketProof("walletTransferDecision", requestId, forgedDecision, attackerUser);
    await socketListener({ ...forgedDecision, packetId: "pkt-attacker-1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.filter((m) => m.type === "wallet-transfer-result").length, 0, "third-party decision must not abort the active offer");

    // Legitimate recipient accepts -> recipient update is vetoed -> sender is refunded -> result fails cleanly!
    const decision = {
      type: "wallet-transfer-decision",
      requestId,
      requesterId: senderUser.id,
      recipientUserId: recipientUser.id,
      primaryGmId: gmUser.id,
      accepted: true,
      reason: "",
      createdAt: Date.now()
    };
    await createSocketProof("walletTransferDecision", requestId, decision, recipientUser);
    await socketListener({ ...decision, packetId: "pkt-decision-1" });
    await new Promise((r) => setTimeout(r, 30));

    const results = emitted.filter((m) => m.type === "wallet-transfer-result");
    assert.equal(results.length, 1);
    assert.equal(results[0].result.ok, false);
    assert.equal(results[0].result.error, "update-incomplete");
    assert.equal(senderActor.system.currency.gold.value, 3, "sender side persisted before recipient veto triggered update-incomplete");
    assert.equal(recipientActor.system.currency.gold.value, 1, "recipient balance remained vetoed");
  } finally {
    restore();
  }
});

test("Wash transition preserves old wash item when create is cancelled and fails cleanly when cleanup delete is cancelled", async () => {
  const restore = saveGlobals(["game", "foundry", "ui"]);
  try {
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    const washTemplate = {
      id: "world-wash-2",
      name: "Немытый",
      type: "criticalInjury",
      toObject() {
        return { name: this.name, type: this.type, system: { healingTime: "3 days" }, flags: {} };
      }
    };
    const worldItems = [washTemplate];
    worldItems.get = (id) => worldItems.find((i) => i.id === id) ?? null;

    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      items: worldItems,
      packs: [],
      modules: new Map(),
      settings: { get: (_ns, key) => (key === "washStateUuids" ? {} : true) }
    };

    const wash = await import(`../scripts/conditions/features/wash.js?wash-veto=${Date.now()}`);

    // Case 1: createEmbeddedDocuments returns [] (cancelled) -> must NOT delete old wash item.
    const deletedIds = [];
    const oldWash = { id: "old-wash", name: "Помытый", type: "criticalInjury", getFlag: () => undefined };
    const actorCreateCancelled = makeFlaggedActor({
      id: "wash-actor-1",
      items: [oldWash],
      async createEmbeddedDocuments() { return []; },
      async deleteEmbeddedDocuments(_type, ids) { deletedIds.push(...ids); return []; }
    });
    const res1 = await wash.transitionWashLevel(actorCreateCancelled, "Помытый");
    assert.equal(res1.changed, false);
    assert.equal(res1.reason, "create-failed");
    assert.deepEqual(deletedIds, [], "old wash item must not be deleted if new item creation was cancelled");

    // Case 2: create succeeds, but deleteEmbeddedDocuments is cancelled -> returns cleanup-failed.
    const itemsList = [oldWash];
    itemsList.get = (id) => itemsList.find((i) => i.id === id) ?? null;
    const actorDeleteCancelled = makeFlaggedActor({
      id: "wash-actor-2",
      items: itemsList,
      async createEmbeddedDocuments(_type, docs) {
        const created = { id: "new-wash", name: docs[0].name, type: docs[0].type, getFlag: () => "Немытый" };
        itemsList.push(created);
        return [created];
      },
      async deleteEmbeddedDocuments() { return []; }
    });
    const res2 = await wash.transitionWashLevel(actorDeleteCancelled, "Помытый");
    assert.equal(res2.changed, false);
    assert.equal(res2.reason, "cleanup-failed");
  } finally {
    restore();
  }
});

test("New Day: zero timers are not proposed as expired, Russian суток is parsed, cancelled writes fail, and FA6 provider icons normalize", async () => {
  const restore = saveGlobals(["game", "foundry", "ui"]);
  try {
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map(),
      settings: { get: () => true }
    };

    const newDay = await import(`../scripts/new-day.js?nd-fixes=${Date.now()}`);
    const providers = await import(`../scripts/integration/new-day-providers.js?ndp-fixes=${Date.now()}`);

    // Russian "суток" / "сутки" support
    assert.equal(newDay.isDailyLethalLimit("2 суток"), true);
    assert.equal(newDay.isDailyLethalLimit("1 сутки"), true);
    const decSutok = newDay.decrementFirstInteger("2 суток", 1);
    assert.equal(decSutok.afterNumber, 1);
    assert.equal(decSutok.afterText, "1 сутки");

    // Zero timer custom condition and zero healingTime injury must NOT appear as expired actions!
    const zeroInjury = {
      id: "inj-zero",
      name: "Old Scar",
      type: "criticalInjury",
      system: { healingTime: "0 days", lethal: "no", limit: "" },
      getFlag: () => undefined
    };
    const activeInjury = {
      id: "inj-active",
      name: "Deep Cut",
      type: "criticalInjury",
      system: { healingTime: "3 days", lethal: "no", limit: "" },
      getFlag: () => undefined,
      async update() { return undefined; }
    };
    const items = [zeroInjury, activeInjury];
    items.get = (id) => items.find((i) => i.id === id) ?? null;

    const actor = makeFlaggedActor({
      id: "nd-actor-1",
      items,
      _flags: {
        "fbl-quick-access": {
          "conditions.list": [{ id: "cond-zero", name: "Resolved note", time: "0", desc: "" }]
        }
      },
      async updateEmbeddedDocuments() { return []; }
    });

    const plan = newDay.buildNewDayPlan(actor);
    assert.equal(plan.actions.some((a) => a.itemId === "inj-zero"), false, "0-day injury must not be proposed as expired");
    assert.equal(plan.actions.some((a) => a.conditionId === "cond-zero"), false, "0-timer custom condition must not be proposed as expired");
    const activeAction = plan.actions.find((a) => a.itemId === "inj-active");
    assert.ok(activeAction);

    const applied = await newDay.applyNewDayPlan(actor, plan, [activeAction.id], { suppressChat: true });
    assert.equal(applied.succeeded.length, 0, "cancelled injury update must not report success");
    assert.equal(applied.failed.length, 1, "cancelled injury update must report failure");

    // Provider icon normalization, category validation & duplicate action id rejection
    const unregister = providers.registerNewDayProvider({
      id: "test-fa6-provider",
      category: "diseases",
      order: 400,
      buildActions: async () => [],
      applyAction: async () => ({ changed: true }),
      describeAction: () => "desc",
      icon: () => "fa-solid fa-virus"
    });
    try {
      assert.equal(providers.getNewDayProviderIcon({ providerId: "test-fa6-provider" }), "fa-virus", "FA6 style prefix must strip cleanly to fa-virus");
      const registeredProvider = providers.getNewDayProvider("test-fa6-provider");
      assert.throws(
        () => providers.normalizeProviderActions(registeredProvider, [
          { id: "dup", itemName: "A" },
          { id: "dup", itemName: "B" }
        ]),
        /duplicate/i
      );
    } finally {
      unregister();
    }
    assert.throws(
      () => providers.normalizeNewDayProvider({
        id: "bad-cat-provider",
        category: "invalid category!!",
        order: 100,
        buildActions: async () => [],
        applyAction: async () => ({}),
        describeAction: () => "",
        icon: () => "fa-virus"
      }),
      /category/i
    );
  } finally {
    restore();
  }
});

test("Multi-addiction New Day on active GM advances both addictions cleanly for a non-GM player", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "Roll", "ChatMessage", "fromUuid"]);
  try {
    globalThis.Roll = class HighRoll {
      constructor(formula) {
        this.formula = formula;
        this.total = 8;
      }
      async evaluate() {
        this.total = 8;
        return this;
      }
      async toMessage() { return {}; }
    };
    globalThis.ChatMessage = { async create() {} };
    globalThis.foundry = {
      utils: {
        deepClone: (v) => structuredClone(v),
        mergeObject: (a, b) => ({ ...a, ...(b ?? {}) })
      }
    };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    const gm = makeFlaggedUser({ id: "gm-1", isGM: true });
    const player = makeFlaggedUser({ id: "p-1", isGM: false });
    const users = [gm, player];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    globalThis.game = {
      user: gm,
      users,
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map(),
      settings: { get: () => true }
    };

    const makeAddictionItem = (id, name) => {
      const itemFlags = {
        "fbl-quick-access": {
          conditions: {
            kind: "addiction",
            addictionState: { severity: 1, phase: "down", die: 12, daysLeft: 0 }
          }
        }
      };
      return {
        id,
        name,
        type: "criticalInjury",
        system: { description: "" },
        getFlag(scope, key) { return getNested(itemFlags[scope], key); },
        async update(patch) {
          for (const [k, v] of Object.entries(patch)) {
            if (k.startsWith("flags.fbl-quick-access.")) {
              const fk = k.slice("flags.fbl-quick-access.".length);
              setNested(itemFlags["fbl-quick-access"], fk, v);
            }
          }
          return this;
        }
      };
    };

    const add1 = makeAddictionItem("add-1", "Зависимость: Лотос");
    const add2 = makeAddictionItem("add-2", "Зависимость: Пыль");
    const items = [add1, add2];
    items.get = (id) => items.find((i) => i.id === id) ?? null;

    const actor = makeFlaggedActor({
      id: "multi-add-actor",
      items,
      testUserPermission: (u) => u.id === "p-1" || u.isGM
    });
    const actors = [actor];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;
    globalThis.game.actors = actors;

    const newDay = await import(`../scripts/new-day.js?multi-add=${Date.now()}`);
    const plan = newDay.buildNewDayPlan(actor);
    const addictionActions = plan.actions.filter((a) => a.category === "addiction");
    assert.equal(addictionActions.length, 2);

    const applied = await newDay.applyNewDayPlan(actor, plan, addictionActions.map((a) => a.id), { suppressChat: true });
    assert.equal(applied.failed.length, 0, "both addictions must succeed on the same New Day");
    assert.equal(applied.succeeded.length, 2);
    assert.equal(add1.getFlag("fbl-quick-access", "conditions.addictionState").die, 10);
    assert.equal(add2.getFlag("fbl-quick-access", "conditions.addictionState").die, 10);

    // Delegated case: run as the non-GM player through the active-GM socket delegation flow.
    const { registerIntegrationSocket } = await import("../scripts/integration/socket-api.js");
    const { initializeAddictionOperations } = await import("../scripts/conditions/services/addiction-service.js");
    const socketListeners = [];
    globalThis.game.socket = {
      on(_channel, handler) { socketListeners.push(handler); },
      emit(_channel, payload) {
        queueMicrotask(() => {
          const targetUser = payload?.type === "integration-api-request" ? gm : player;
          globalThis.game.user = targetUser;
          for (const listener of socketListeners) listener(structuredClone(payload));
        });
      }
    };
    globalThis.game.user = gm;
    registerIntegrationSocket();
    initializeAddictionOperations();

    const delAdd1 = makeAddictionItem("del-add-1", "Зависимость: Лотос 2");
    const delAdd2 = makeAddictionItem("del-add-2", "Зависимость: Пыль 2");
    const delItems = [delAdd1, delAdd2];
    delItems.get = (id) => delItems.find((i) => i.id === id) ?? null;
    const delActor = makeFlaggedActor({
      id: "multi-add-delegated-actor",
      items: delItems,
      testUserPermission: (u) => u.id === "p-1" || u.isGM
    });
    actors.push(delActor);
    globalThis.fromUuid = async (uuid) => actors.find((a) => a.uuid === uuid) ?? null;

    globalThis.game.user = player;
    const delPlan = newDay.buildNewDayPlan(delActor);
    const delActions = delPlan.actions.filter((a) => a.category === "addiction");
    assert.equal(delActions.length, 2);

    const delApplied = await newDay.applyNewDayPlan(delActor, delPlan, delActions.map((a) => a.id), {
      postChat: false,
      suppressNotifications: true
    });
    assert.equal(delApplied.failed.length, 0, "delegated multi-addiction New Day must succeed for non-GM player");
    assert.equal(delApplied.succeeded.length, 2);
    assert.equal(delAdd1.getFlag("fbl-quick-access", "conditions.addictionState").die, 10);
    assert.equal(delAdd2.getFlag("fbl-quick-access", "conditions.addictionState").die, 10);
  } finally {
    restore();
  }
});

test("Rest detects ActiveEffect even when system.condition value is false, and serializes parallel Short Rests per actor", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "HTMLElement"]);
  try {
    const dialogs = [];
    class FakeElement {
      matches(selector) { return selector === "form"; }
      querySelector() { return null; }
    }
    class FakeShortForm extends FakeElement {
      querySelector(selector) {
        if (selector === 'input[name="restType"]:checked') return { value: "short" };
        const map = {
          useShortRecovery: { checked: true },
          shortAttribute: { value: "strength" },
          shortConsumable: { value: "food" },
          resetShortQuarter: { checked: false }
        };
        const name = selector.match(/name="([^"]+)"/)?.[1];
        return name ? map[name] ?? null : null;
      }
    }
    class FakeDialogV2 {
      constructor(config) {
        this.config = config;
        this.element = new FakeElement();
        this.form = new FakeShortForm();
        this.listeners = new Map();
        this.closed = false;
        dialogs.push(this);
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      render() { return Promise.resolve(this); }
      close() { this.closed = true; this.listeners.get("close")?.(); return Promise.resolve(this); }
    }

    globalThis.HTMLElement = FakeElement;
    globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      settings: { get: () => false },
      time: { worldTime: 0 },
      modules: new Map()
    };

    const rest = await import(`../scripts/rest.js?rest-fixes=${Date.now()}`);

    const hungryEffectActor = makeFlaggedActor({
      id: "rest-effect-actor",
      system: { condition: { hungry: { value: false } } },
      effects: [{ disabled: false, statuses: new Set(["hungry"]) }]
    });
    const condState = rest.getRestConditionState(hungryEffectActor);
    assert.equal(condState.hungry, true, "ActiveEffect must still mark Hungry active even when boolean field is false");

    let strengthUpdates = 0;
    const baseActor = makeFlaggedActor({
      id: "rest-race-actor",
      system: {
        attribute: {
          strength: { value: 1, max: 4 },
          agility: { value: 3, max: 3 },
          wits: { value: 3, max: 3 },
          empathy: { value: 3, max: 3 }
        },
        condition: {}
      }
    });
    const origUpdate = baseActor.update.bind(baseActor);
    const actor = {
      ...baseActor,
      async update(patch) {
        await new Promise((r) => setTimeout(r, 15));
        if ("system.attribute.strength.value" in patch) strengthUpdates += 1;
        return origUpdate(patch);
      }
    };

    const p1 = rest.openRestDialog(null, actor, null);
    const p2 = rest.openRestDialog(null, actor, null);
    await Promise.all(dialogs.map(dialog => dialog.config.buttons.find(button => button.action === "apply")
      .callback({}, { form: dialog.form }, dialog)));
    assert.equal(dialogs[0].closed, true);
    assert.equal(dialogs[1].closed, false);
    await dialogs[1].close();
    const [applied, cancelled] = await Promise.all([p1, p2]);
    assert.equal(applied?.changed, true);
    assert.equal(cancelled, null);

    assert.equal(strengthUpdates, 1, "parallel Short Rests in the same quarter must serialize and apply at most once");
    assert.equal(actor.system.attribute.strength.value, 2);
  } finally {
    restore();
  }
});

test("World migration detects cancelled writes, notifies failure, and refuses to stamp MIGRATION_VERSION", async () => {
  const restore = saveGlobals(["game", "foundry", "ui"]);
  try {
    let stampedVersion = null;
    const errors = [];
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error: (msg) => errors.push(msg) } };

    const gm = makeFlaggedUser({ id: "gm-1", isGM: true });
    const users = [gm];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    const heatItem = {
      id: "heat-1",
      name: "Жара",
      type: "criticalInjury",
      system: { description: "" },
      getFlag: () => undefined,
      async update() { return undefined; }
    };
    const actor = makeFlaggedActor({
      id: "mig-actor",
      items: [heatItem],
      async updateEmbeddedDocuments() { return []; }
    });

    globalThis.game = {
      user: gm,
      users,
      actors: [actor],
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map(),
      settings: {
        settings: new Map(),
        get(_ns, key) {
          if (key === "expandedConditionsMigrationVersion") return 0;
          return true;
        },
        async set(_ns, key, value) {
          if (key === "expandedConditionsMigrationVersion") stampedVersion = value;
        }
      }
    };

    const mig = await import(`../scripts/conditions/migrations.js?mig-cancel=${Date.now()}`);
    await mig.runWorldMigration();
    assert.equal(stampedVersion, null, "MIGRATION_VERSION must not be stamped when any write was cancelled");
    assert.ok(errors.some((msg) => /migration was not completed|MigrationFailed/i.test(String(msg))), "failure error notification must be surfaced");
  } finally {
    restore();
  }
});

test("Calendaria day manager fixes +300-year future markers, rewinds processed days, verifies marker writes, and rejects stale interactive previews", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "CALENDARIA", "Hooks"]);
  try {
    const api = makeOrdinalApi();
    const currentDate = { year: 882, month: 4, day: 12 };
    const context = { calendarId: "air-islands", date: currentDate, api };

    const gm = makeFlaggedUser({ id: "gm-1", isGM: true });
    const p1 = makeFlaggedUser({ id: "p-1", isGM: false, character: { id: "pc-1" } });
    const p2 = makeFlaggedUser({ id: "p-2", isGM: false, character: { id: "pc-2" } });
    const users = [gm, p1, p2];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    const injury = {
      id: "inj-stale-1",
      name: "Broken Rib",
      type: "criticalInjury",
      system: { healingTime: "5 days", lethal: "no", limit: "" },
      getFlag: () => undefined,
      async update(patch) {
        if ("system.healingTime" in patch) this.system.healingTime = patch["system.healingTime"];
        return this;
      }
    };
    const pc1Items = [injury];
    pc1Items.get = (id) => pc1Items.find((i) => i.id === id) ?? null;

    const pc1 = makeFlaggedActor({
      id: "pc-1",
      name: "Varg",
      items: pc1Items,
      _flags: {
        "fbl-quick-access": {
          stateProgressionCalendaria: { calendarId: "air-islands", date: { year: 1182, month: 4, day: 12 } }
        }
      }
    });
    const pc2 = makeFlaggedActor({
      id: "pc-2",
      name: "Sera",
      _flags: {
        "fbl-quick-access": {
          stateProgressionCalendaria: { calendarId: "air-islands", date: { year: 882, month: 4, day: 12 } }
        }
      }
    });
    const actors = [pc1, pc2];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;

    globalThis.Hooks = { on() {}, once() {} };
    globalThis.CALENDARIA = {
      api: {
        ...api,
        getActiveCalendar: () => ({ id: "air-islands" }),
        getCurrentDateTime: () => currentDate
      }
    };
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: gm,
      users,
      actors,
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map([["calendaria", { id: "calendaria", active: true }]]),
      settings: { get: () => "calendaria" },
      socket: { on() {}, emit() {} }
    };

    const sp = await import("../scripts/state-progression.js");
    const newDay = await import("../scripts/new-day.js");
    const { executeAsActiveGM } = await import("../scripts/integration/socket-api.js");
    sp.initializeStateProgression();

    // 1. Detect +300-year future marker as status: "ahead"
    const aheadStatus = sp.calculateActorCalendarStatus(sp.getActorCalendarMarker(pc1), context, api);
    assert.equal(aheadStatus.status, "ahead");
    assert.equal(aheadStatus.days, -108000);

    // 2. Rewinding an "ahead" marker anchors from CURRENT date (882.4.12 -> 882.4.9), NOT year 1182!
    const rewoundAhead = await sp.rewindActorCalendarMarker(pc1, 3, context, api);
    assert.deepEqual(rewoundAhead.marker.date, { year: 882, month: 4, day: 9 });
    assert.deepEqual(sp.calculateActorCalendarStatus(sp.getActorCalendarMarker(pc1), context, api), {
      status: "pending-multiple",
      days: 3
    });

    // 3. Reset individual actor to current date
    await sp.resetActorCalendarMarkerToCurrent(pc1, context);
    assert.deepEqual(sp.getActorCalendarMarker(pc1).date, currentDate);
    assert.deepEqual(sp.calculateActorCalendarStatus(sp.getActorCalendarMarker(pc1), context, api), {
      status: "current",
      days: 0
    });

    // 4. Rewind all assigned player actors by 2 days, then reset all back to current date
    const rewoundAll = await sp.rewindAllCalendarMarkers(2, context, api);
    assert.equal(rewoundAll.count, 2);
    assert.deepEqual(sp.getActorCalendarMarker(pc1).date, { year: 882, month: 4, day: 10 });
    assert.deepEqual(sp.getActorCalendarMarker(pc2).date, { year: 882, month: 4, day: 10 });

    const resetAll = await sp.resetAllCalendarMarkersToCurrent(context);
    assert.equal(resetAll.count, 2);
    assert.deepEqual(sp.getActorCalendarMarker(pc1).date, currentDate);
    assert.deepEqual(sp.getActorCalendarMarker(pc2).date, currentDate);

    // 5. Cancelled marker write must reject instead of silently succeeding
    const vetoedActor = makeFlaggedActor({ id: "pc-veto", cancelSetFlag: true, cancelUpdate: true });
    await assert.rejects(
      sp.setActorCalendarMarker(vetoedActor, context),
      (err) => err?.code === "write-not-persisted"
    );

    // 6. Behavioral check: rewind pc1 by 1 day, preview injury at "5 days", mutate injury to "10 days",
    // then submit the stale interactive Calendaria apply -> GM handler must reject with stale-plan!
    await sp.rewindActorCalendarMarker(pc1, 1, context, api);
    const previewPlan = newDay.buildNewDayPlan(pc1);
    const injuryAction = previewPlan.actions.find((a) => a.itemId === "inj-stale-1");
    assert.ok(injuryAction);
    const stalePrecondition = previewPlan.preconditions[injuryAction.id];

    // Live injury changes from "5 days" to "10 days" while player dialog is open
    injury.system.healingTime = "10 days";

    await assert.rejects(
      executeAsActiveGM("state-progression.apply-calendaria-day", {
        actorId: pc1.id,
        calendarId: context.calendarId,
        targetDate: currentDate,
        selectedIds: [injuryAction.id],
        selectedPreconditions: { [injuryAction.id]: stalePrecondition }
      }),
      (err) => err?.code === "stale-plan"
    );
    assert.equal(injury.system.healingTime, "10 days", "stale interactive apply must not overwrite the updated injury");
  } finally {
    restore();
  }
});

test("stripHtml is inert against script/event-handler payloads and i18n placeholders & setting labels stay consistent", async () => {
  const { compactPlainText, stripHtml } = await import(`../scripts/utils.js?strip=${Date.now()}`);
  assert.equal(stripHtml('<img src=x onerror=alert(1)>Hello <b>World</b>'), "Hello World");
  assert.equal(compactPlainText(stripHtml("<script>window.pwned=1</script>Safe&nbsp;&amp;&nbsp;Sound")), "Safe & Sound");

  const ru = JSON.parse(readFileSync(join(root, "lang", "ru.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "lang", "en.json"), "utf8"));

  const flatten = (obj, prefix = "", out = new Map()) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, p, out);
      else out.set(p, String(v));
    }
    return out;
  };
  const ruFlat = flatten(ru);
  const enFlat = flatten(en);
  assert.deepEqual([...ruFlat.keys()].sort(), [...enFlat.keys()].sort(), "ru.json and en.json must have identical key sets");

  const extractPlaceholders = (text) => [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();
  for (const [key, ruVal] of ruFlat.entries()) {
    const enVal = enFlat.get(key);
    assert.deepEqual(
      extractPlaceholders(ruVal),
      extractPlaceholders(enVal),
      `Placeholder mismatch for ${key}: ru=${ruVal} vs en=${enVal}`
    );
  }

  for (const setting of Object.values(ru.FBLEC.Settings)) {
    assert.doesNotMatch(setting.Name, /^FBLEC:/);
  }
  for (const setting of Object.values(en.FBLEC.Settings)) {
    assert.doesNotMatch(setting.Name, /^FBLEC:/);
  }

  assert.match(ru.FBLQA.Rest.Title, /\{actor\}/);
  assert.match(en.FBLQA.Rest.Title, /\{actor\}/);
  assert.match(ru.FBLQA.StateProgression.GMSummaryTitle, /\{date\}/);
  assert.match(en.FBLQA.StateProgression.GMSummaryTitle, /\{date\}/);

  // User-requested English Rest/Willpower terms in ru.json are preserved untouched
  assert.equal(ru.FBLQA.Rest.AttributeStrength, "Strength");
  assert.equal(ru.FBLQA.Rest.ConditionHungry, "Hungry");
  assert.equal(ru.FBLQA.Rest.LongTitle, "Long Rest");
  assert.equal(ru.FBLQA.Willpower.KinTalent, "Kin Talent");
});
