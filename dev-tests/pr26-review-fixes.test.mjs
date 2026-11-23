import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createMemoryStorage } from "./helpers/browser-storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function saveGlobals(keys) {
  const saved = new Map();
  for (const key of keys) {
    saved.set(key, { existed: key in globalThis, value: globalThis[key] });
  }
  return () => {
    for (const [key, entry] of saved.entries()) {
      if (entry.existed) globalThis[key] = entry.value;
      else delete globalThis[key];
    }
  };
}

function getNested(obj, path) {
  return String(path).split(".").reduce((cur, p) => (cur == null ? undefined : cur[p]), obj);
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

function setFoundryPath(obj, path, value, { forceReplace = false } = {}) {
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

function makeFoundryActor(overrides = {}) {
  const flags = overrides._flags ?? {};
  let cancelUpdate = Boolean(overrides.cancelUpdate);
  const { _flags, cancelUpdate: _cu, ...rest } = overrides;
  const actor = {
    id: rest.id ?? "actor-1",
    uuid: rest.uuid ?? `Actor.${rest.id ?? "actor-1"}`,
    name: rest.name ?? "Tester",
    documentName: "Actor",
    type: "character",
    isOwner: rest.isOwner ?? true,
    pack: null,
    system: rest.system ?? {},
    items: rest.items ?? [],
    effects: rest.effects ?? [],
    setCancelUpdate(v) { cancelUpdate = Boolean(v); },
    getFlag(scope, key) {
      return getNested(flags[scope], key);
    },
    // Faithfully mimics Foundry v13: setFlag merges plain objects into existing flags.
    async setFlag(scope, key, value) {
      if (cancelUpdate) return undefined;
      flags[scope] ??= {};
      setFoundryPath(flags[scope], key, value, { forceReplace: false });
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
          setFoundryPath(flags[scope], key, value, { forceReplace: false });
          continue;
        }
        setFoundryPath(this, path, value, { forceReplace: false });
      }
      return this;
    },
    ...rest
  };
  return actor;
}

test("PR26: undoActorCalendariaAbsent & resetActorCalendarMarkerToCurrent replace whole marker (stripping absence metadata) under Foundry setFlag merge semantics", async () => {
  const restore = saveGlobals(["game", "ui", "CALENDARIA"]);
  try {
    const ordinal = (d) => d.year * 360 + (d.month - 1) * 30 + d.day;
    const api = {
      getActiveCalendar: () => ({ id: "air" }),
      getCurrentDateTime: () => ({ year: 882, month: 4, day: 12 }),
      daysBetween: (a, b) => ordinal(b) - ordinal(a),
      addDays: (d, n) => ({ ...d, day: d.day + n })
    };
    globalThis.CALENDARIA = { api };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true, active: true },
      users: [{ id: "gm", isGM: true, active: true }],
      modules: new Map([["calendaria", { active: true }]]),
      settings: { get: () => "calendaria" },
      i18n: { localize: (k) => k, format: (k) => k }
    };

    const sp = await import(`../scripts/state-progression.js?replace-marker=${Date.now()}`);
    const context = { calendarId: "air", date: { year: 882, month: 4, day: 12 }, api };

    const actorA = makeFoundryActor({
      id: "absent-undo-actor",
      _flags: { "fbl-quick-access": { stateProgressionCalendaria: { calendarId: "air", date: { year: 882, month: 4, day: 8 } } } }
    });
    await sp.markActorCalendariaAbsent(actorA, context, api);
    assert.equal(actorA.getFlag("fbl-quick-access", "stateProgressionCalendaria").resolution, "absent");

    // Undo absent MUST strip resolution, skippedDays, previousDate completely
    const undone = await sp.undoActorCalendariaAbsent(actorA, context);
    assert.equal(undone.changed, true);
    assert.deepEqual(actorA.getFlag("fbl-quick-access", "stateProgressionCalendaria"), {
      calendarId: "air",
      date: { year: 882, month: 4, day: 8 }
    });

    // Reset from absent marker MUST also strip absence metadata completely
    await sp.markActorCalendariaAbsent(actorA, context, api);
    const resetRes = await sp.resetActorCalendarMarkerToCurrent(actorA, context);
    assert.equal(resetRes.changed, true);
    assert.deepEqual(actorA.getFlag("fbl-quick-access", "stateProgressionCalendaria"), {
      calendarId: "air",
      date: { year: 882, month: 4, day: 12 }
    });

    // Invalid date (month 0) MUST reject instead of reporting changed: true
    await assert.rejects(
      sp.resetActorCalendarMarkerToCurrent(actorA, { calendarId: "air", date: { year: 882, month: 0, day: 5 } }),
      (err) => err?.code === "calendaria-unavailable"
    );

    // Cancelled write MUST still reject with write-not-persisted
    actorA.setCancelUpdate(true);
    await assert.rejects(
      sp.resetActorCalendarMarkerToCurrent(actorA, { calendarId: "air", date: { year: 882, month: 4, day: 13 } }),
      (err) => err?.code === "write-not-persisted"
    );
  } finally {
    restore();
  }
});

test("PR26: New Day chat summary respects the chatMessages setting opt-out", async () => {
  const restore = saveGlobals(["game", "ChatMessage", "ui"]);
  try {
    let chatEnabled = false;
    const posted = [];
    globalThis.ChatMessage = {
      getSpeaker: () => ({}),
      create: async (data) => { posted.push(data); return data; }
    };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      modules: new Map(),
      settings: {
        get(_scope, key) {
          if (key === "chatMessages") return chatEnabled;
          return true;
        }
      },
      i18n: { localize: (k) => k, format: (k) => k }
    };

    const newDay = await import(`../scripts/new-day.js?chat-optout=${Date.now()}`);
    const makeActor = () => {
      const injury = {
        id: "inj-1",
        name: "Cut",
        type: "criticalInjury",
        system: { healingTime: "3 days", lethal: "no" },
        getFlag() { return null; },
        async update(patch) {
          if ("system.healingTime" in patch) this.system.healingTime = patch["system.healingTime"];
          return this;
        }
      };
      const items = [injury];
      items.get = (id) => items.find((i) => i.id === id) ?? null;
      return makeFoundryActor({
        id: "nd-chat-actor",
        items,
        async updateEmbeddedDocuments(_type, updates) {
          for (const u of updates) await items.get(u._id)?.update(u);
        }
      });
    };

    const actor1 = makeActor();
    const plan1 = newDay.buildNewDayPlan(actor1);
    const injAction1 = plan1.actions.find((a) => a.kind === "injury-healing");
    await newDay.applyNewDayPlan(actor1, plan1, [injAction1.id], { postChat: true });
    assert.equal(posted.length, 0, "chatMessages=false must suppress New Day summary chat card");

    chatEnabled = true;
    const actor2 = makeActor();
    const plan2 = newDay.buildNewDayPlan(actor2);
    const injAction2 = plan2.actions.find((a) => a.kind === "injury-healing");
    await newDay.applyNewDayPlan(actor2, plan2, [injAction2.id], { postChat: true });
    assert.equal(posted.length, 1, "chatMessages=true must post New Day summary chat card");
  } finally {
    restore();
  }
});

test("PR26: opaque preconditions cover provider actions without leaking actor text, and provider apply rejects duplicate IDs", async () => {
  const restore = saveGlobals(["game", "ui", "CALENDARIA", "fromUuid"]);
  try {
    let tickDays = 5;
    let returnDuplicate = false;
    let applyCount = 0;

    const injury = {
      id: "inj-secret",
      name: "Secret Royal Poison",
      type: "criticalInjury",
      system: { healingTime: "5 days", lethal: "no" },
      getFlag() { return null; },
      async update(patch) {
        if ("system.healingTime" in patch) this.system.healingTime = patch["system.healingTime"];
        return this;
      }
    };
    const items = [injury];
    items.get = (id) => items.find((i) => i.id === id) ?? null;

    const pc = makeFoundryActor({
      id: "pc-prov",
      name: "Hero",
      items,
      _flags: { "fbl-quick-access": { stateProgressionCalendaria: { calendarId: "air", date: { year: 882, month: 4, day: 11 } } } },
      testUserPermission: () => true,
      async updateEmbeddedDocuments(_type, updates) {
        for (const u of updates) await items.get(u._id)?.update(u);
      }
    });
    const gmUser = { id: "gm", name: "GM", isGM: true, active: true };
    const playerUser = { id: "p1", name: "Player", isGM: false, active: true, character: pc };
    const actors = [pc];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;
    const users = [gmUser, playerUser];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    const ordinal = (d) => d.year * 360 + (d.month - 1) * 30 + d.day;
    globalThis.CALENDARIA = {
      api: {
        getActiveCalendar: () => ({ id: "air" }),
        getCurrentDateTime: () => ({ year: 882, month: 4, day: 12 }),
        daysBetween: (a, b) => ordinal(b) - ordinal(a),
        addDays: (d, n) => ({ ...d, day: d.day + n })
      }
    };
    globalThis.fromUuid = async (uuid) => (uuid === pc.uuid ? pc : null);
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: gmUser,
      users,
      actors,
      modules: new Map([["calendaria", { active: true }]]),
      settings: { get: (_s, k) => (k === "stateProgressionMode" ? "calendaria" : true) },
      i18n: { localize: (k) => k, format: (k) => k }
    };

    const providers = await import("../scripts/integration/new-day-providers.js");
    const newDay = await import("../scripts/new-day.js");
    const sp = await import("../scripts/state-progression.js");
    const { executeAsActiveGM } = await import("../scripts/integration/socket-api.js");
    providers.initializeNewDayProviderBridge();
    sp.initializeStateProgression();

    const providerId = `test-prov-${Date.now()}`;
    const unregisterProvider = providers.registerNewDayProvider({
      id: providerId,
      category: "disease",
      order: 250,
      buildActions: () => {
        const base = { id: "tick", itemName: "Plague", days: tickDays };
        return returnDuplicate ? [base, { id: "tick", itemName: "Plague Duplicate", days: 99 }] : [base];
      },
      applyAction: () => { applyCount += 1; return { changed: true, summary: "ticked" }; },
      describeAction: (a) => `${a.days}d`,
      icon: () => "fas fa-biohazard"
    });
    try {

    const plan = await newDay.buildNewDayPlanWithProviders(pc);
    const injAction = plan.actions.find((a) => a.kind === "injury-healing");
    const provAction = plan.actions.find((a) => a.providerId === providerId);
    assert.ok(provAction, "provider action must be in plan");

    // Preconditions MUST be opaque tokens, never raw actor strings
    const injToken = plan.preconditions[injAction.id];
    const provToken = plan.preconditions[provAction.id];
    assert.match(injToken, /^rev:[0-9a-f]{16}$/);
    assert.match(provToken, /^rev:[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(plan.preconditions).includes("Secret Royal Poison"), false);
    assert.equal(JSON.stringify(plan.preconditions).includes("Plague"), false);

    // Mutate provider action timer from 5 to 10 (same ID "tick") -> interactive apply must reject with stale-plan
    tickDays = 10;
    await assert.rejects(
      executeAsActiveGM("state-progression.apply-calendaria-day", {
        actorId: pc.id,
        calendarId: "air",
        targetDate: { year: 882, month: 4, day: 12 },
        selectedIds: [provAction.id],
        selectedPreconditions: { [provAction.id]: provToken }
      }),
      (err) => err?.code === "stale-plan"
    );
    assert.equal(applyCount, 0, "stale provider action must not run");

    // Duplicate provider action IDs on rebuild must be rejected
    const freshPlan = await newDay.buildNewDayPlanWithProviders(pc);
    const freshProvAction = freshPlan.actions.find((a) => a.providerId === providerId);
    returnDuplicate = true;
    await assert.rejects(
      providers.applyNewDayProviderAction(pc, freshProvAction),
      (err) => err?.code === "duplicate-provider-action"
    );
    assert.equal(applyCount, 0, "duplicate rebuilt provider action must not run");
    } finally {
      unregisterProvider?.();
    }
  } finally {
    restore();
  }
});

test("PR26: Rest ignores inactive condition ActiveEffects, honors legacy Calendaria quarter keys, and avoids double recovery on failed effect-delete retry", async () => {
  const restore = saveGlobals(["game", "foundry", "ui", "CALENDARIA", "HTMLElement", "ChatMessage"]);
  try {
    let quarterHour = 2;
    globalThis.CALENDARIA = {
      api: {
        getActiveCalendar: () => ({ id: "air-islands", days: { hoursPerDay: 24 } }),
        getCurrentDateTime: () => ({ year: 1165, month: 1, day: 1, hour: quarterHour, minute: 0, second: 0 })
      }
    };
    globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => null };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      settings: { get: () => false },
      time: { worldTime: 0 },
      modules: new Map([["calendaria", { active: true }]])
    };

    const rest = await import(`../scripts/rest.js?pr26-rest=${Date.now()}`);

    // 1. Inactive Hungry effect must NOT block Strength; active Hungry effect MUST block.
    const inactiveHungryActor = makeFoundryActor({
      id: "rest-inactive",
      system: {
        attribute: { strength: { value: 2, max: 5 }, agility: { value: 4, max: 4 }, wits: { value: 4, max: 4 }, empathy: { value: 4, max: 4 } },
        condition: { hungry: { value: false }, thirsty: { value: false }, sleepy: { value: false }, cold: { value: false } }
      },
      effects: [{ id: "eff-inactive-hungry", active: false, statuses: new Set(["hungry"]) }]
    });
    const inactiveSnap = rest.buildRestSnapshot(inactiveHungryActor);
    assert.equal(inactiveSnap.conditions.hungry, false, "inactive Hungry ActiveEffect must not mark Hungry active");

    const activeHungryActor = makeFoundryActor({
      id: "rest-active",
      system: {
        attribute: { strength: { value: 2, max: 5 }, agility: { value: 4, max: 4 }, wits: { value: 4, max: 4 }, empathy: { value: 4, max: 4 } },
        condition: { hungry: { value: false }, thirsty: { value: false }, sleepy: { value: false }, cold: { value: false } }
      },
      effects: [{ id: "eff-active-hungry", active: true, statuses: new Set(["hungry"]) }]
    });
    const activeSnap = rest.buildRestSnapshot(activeHungryActor);
    assert.equal(activeSnap.conditions.hungry, true, "active Hungry ActiveEffect must still mark Hungry active");

    // 2. Legacy Calendaria quarter key without calendarId must still lock Short Rest in the same quarter
    const legacyKeyActor = makeFoundryActor({
      id: "rest-legacy-key",
      _flags: { "fbl-quick-access": { shortRestRecovery: { quarterKey: "calendaria:1165:1:1:q0", attribute: "strength" } } },
      system: {
        attribute: { strength: { value: 2, max: 5 }, agility: { value: 4, max: 4 }, wits: { value: 4, max: 4 }, empathy: { value: 4, max: 4 } },
        condition: { hungry: { value: false }, thirsty: { value: false }, sleepy: { value: false }, cold: { value: false } }
      }
    });
    assert.equal(rest.buildRestSnapshot(legacyKeyActor).shortRestUse.usedThisQuarter, true);
    quarterHour = 8; // advance to q1
    assert.equal(rest.buildRestSnapshot(legacyKeyActor).shortRestUse.usedThisQuarter, false);

    // 3. Long Rest retry after vetoed ActiveEffect deletion must NOT heal Strength twice
    let vetoDelete = true;
    const sleepyEffect = { id: "eff-sleepy", active: true, statuses: new Set(["sleepy"]) };
    const retryActor = makeFoundryActor({
      id: "rest-retry",
      system: {
        attribute: { strength: { value: 1, max: 5 }, agility: { value: 4, max: 4 }, wits: { value: 4, max: 4 }, empathy: { value: 4, max: 4 } },
        condition: { hungry: { value: false }, thirsty: { value: false }, sleepy: { value: true }, cold: { value: false } }
      },
      effects: [sleepyEffect],
      async deleteEmbeddedDocuments(_type, ids) {
        if (vetoDelete) return [];
        this.effects = this.effects.filter((e) => !ids.includes(e.id));
        return ids;
      }
    });

    let dialogConfig = null;
    class FakeElement {
      constructor() { this.classList = { add() {}, toggle() {} }; this.dataset = {}; }
      matches(s) { return s === "form"; }
      querySelector() { return null; }
      querySelectorAll() { return []; }
      addEventListener() {}
    }
    class FakeLongForm extends FakeElement {
      querySelector(selector) {
        if (selector === 'input[name="restType"]:checked') return { value: "long" };
        return null;
      }
    }
    class FakeDialogV2 {
      constructor(config) {
        dialogConfig = config;
        this.element = new FakeElement();
        this.form = new FakeLongForm();
        this.listeners = new Map();
      }
      addEventListener(t, l) { this.listeners.set(t, l); }
      render() { return Promise.resolve(this); }
      close() { this.listeners.get("close")?.(); return Promise.resolve(this); }
    }
    globalThis.HTMLElement = FakeElement;
    globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };

    const dialogPromise = rest.openRestDialog(null, retryActor, null);
    const applyBtn = dialogConfig.buttons.find((b) => b.action === "apply");
    const fakeForm = new FakeLongForm();

    // First attempt: Strength 1 -> 2, Sleepy deletion vetoed -> fails
    await applyBtn.callback(null, { form: fakeForm }, { form: fakeForm, close: async () => {} });
    assert.equal(retryActor.system.attribute.strength.value, 2);
    assert.equal(retryActor.effects.length, 1);

    // Second attempt after veto clears: Strength MUST stay 2 (NOT jump to 3), and Sleepy effect is deleted
    vetoDelete = false;
    await applyBtn.callback(null, { form: fakeForm }, { form: fakeForm, close: async () => {} });
    const finalResult = await dialogPromise;
    assert.equal(retryActor.system.attribute.strength.value, 2, "retry must not apply Strength recovery a second time");
    assert.equal(retryActor.effects.length, 0, "retry must finish deleting Sleepy ActiveEffect");
    assert.ok(finalResult?.changed);
    assert.equal(finalResult.failed, undefined);
  } finally {
    restore();
  }
});

test("PR26: BIO retains pending draft on cancelled Actor.update and ownership loss", async () => {
  const restore = saveGlobals(["game", "foundry", "ui"]);
  try {
    globalThis.game = {
      user: { id: "p1", isGM: false },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map()
    };
    globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v), mergeObject: (a, b) => ({ ...a, ...(b ?? {}) }) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    const bio = await import(`../scripts/biography.js?bio-cancel=${Date.now()}`);
    const actor = makeFoundryActor({
      id: "bio-cancel-actor",
      cancelUpdate: true,
      system: { bio: { kin: { value: "Human" }, profession: { value: "Hunter" }, pride: { value: "" }, darkSecret: { value: "" }, note: { value: "" } } }
    });

    const statusEl = { textContent: "", className: "", classList: { remove() {}, add(c) { statusEl.className = c; } } };
    const state = bio.getBiographyProfile(actor);
    state.concept = "Draft Concept";
    bio.queueProfileSave(actor, state, statusEl, 10000, "concept");
    const [firstOk] = await bio.flushBiographySaves(actor);
    assert.equal(firstOk, false, "cancelled Actor.update must fail flush instead of reporting Saved");
    assert.equal(statusEl.className.includes("is-error"), true);

    // Allow writes and flush again: retained draft must persist cleanly
    actor.setCancelUpdate(false);
    const [retryOk] = await bio.flushBiographySaves(actor);
    assert.equal(retryOk, true, "retained draft must persist on retry");
    assert.equal(actor.getFlag("fbl-quick-access", "biographyProfile").concept, "Draft Concept");
    assert.equal(statusEl.className.includes("is-saved"), true);

    // Ownership loss before flush must also retain draft and succeed once ownership returns
    actor.isOwner = false;
    state.concept = "Owner-Lost Draft";
    bio.queueProfileSave(actor, state, statusEl, 10000, "concept");
    const [lostOk] = await bio.flushBiographySaves(actor);
    assert.equal(lostOk, false);
    actor.isOwner = true;
    const [regainedOk] = await bio.flushBiographySaves(actor);
    assert.equal(regainedOk, true);
    assert.equal(actor.getFlag("fbl-quick-access", "biographyProfile").concept, "Owner-Lost Draft");
  } finally {
    restore();
  }
});

test("PR26: Reputation keeps the newest failed edit visible after reopening", async testContext => {
  const restore = saveGlobals(["game", "foundry", "ui", "HTMLElement", "document"]);
  try {
    testContext.mock.method(console, "error", () => {});
    const savedSnapshots = [];
    const firstSaveStarted = Promise.withResolvers();
    const releaseFirstSave = Promise.withResolvers();
    let allowSave = false;

    const actor = makeFoundryActor({
      id: "rep-race-actor",
      _flags: { "fbl-quick-access": { reputationEntries: [{ id: "r1", amount: 1, description: "Old Town" }] } }
    });
    const persist = actor.update;
    actor.update = async patch => {
      savedSnapshots.push(structuredClone(patch["flags.fbl-quick-access.reputationEntries"]));
      if (savedSnapshots.length === 1) {
        firstSaveStarted.resolve();
        await releaseFirstSave.promise;
      }
      if (allowSave) return persist.call(actor, patch);
    };

    class FakeDomNode {
      constructor(tag = "div") {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.textContent = "";
        this.innerHTML = "";
        this.content = { children: [], childNodes: [] };
        this._classes = new Set();
        this._listeners = new Map();
        this.classList = {
          add: (...cls) => cls.forEach((c) => this._classes.add(c)),
          remove: (...cls) => cls.forEach((c) => this._classes.delete(c)),
          toggle: (c, force) => {
            if (force === undefined) { if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c); }
            else if (force) this._classes.add(c); else this._classes.delete(c);
          },
          contains: (c) => this._classes.has(c)
        };
      }
      setAttribute(k, v) { this.attributes[k] = String(v); }
      getAttribute(k) { return this.attributes[k] ?? null; }
      append(...nodes) {
        for (const node of nodes) {
          if (node && typeof node === "object") {
            node.parentNode = this;
            this.children.push(node);
          }
        }
      }
      appendChild(node) { this.append(node); return node; }
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(fn);
      }
      dispatch(type, event) {
        for (const fn of this._listeners.get(type) ?? []) fn(event);
      }
      matches(selector) {
        for (const part of selector.split(",").map((s) => s.trim())) {
          if (part.startsWith(".") && this._classes.has(part.slice(1))) return true;
          const attrMatch = part.match(/^\[([^=\]]+)=['"]([^'"]+)['"]\]$/);
          if (attrMatch) {
            const [, attr, val] = attrMatch;
            if (attr.startsWith("data-")) {
              const camel = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
              if (this.dataset[camel] === val) return true;
            }
            if (this.attributes[attr] === val) return true;
          }
          const tagAttrMatch = part.match(/^([a-z]+)\[([^=\]]+)=['"]([^'"]+)['"]\]$/i);
          if (tagAttrMatch) {
            const [, tag, attr, val] = tagAttrMatch;
            if (this.tagName === tag.toUpperCase()) {
              if (attr.startsWith("data-")) {
                const camel = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
                if (this.dataset[camel] === val) return true;
              }
              if (this.attributes[attr] === val) return true;
            }
          }
        }
        return false;
      }
      closest(selector) {
        let cur = this;
        while (cur) {
          if (cur.matches(selector)) return cur;
          cur = cur.parentNode;
        }
        return null;
      }
      querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (child.matches(selector)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      }
    }

    globalThis.document = {
      createElement: (tag) => new FakeDomNode(tag)
    };
    class FakeDialogV2 {
      constructor() {
        this.element = new FakeDomNode("div");
        this.rowsRoot = new FakeDomNode("div");
        this.rowsRoot.classList.add("fblqa-reputation-rows");
        const status = new FakeDomNode("span");
        status.dataset.role = "save-status";
        this.element.append(this.rowsRoot, status);
        this._listeners = new Map();
      }
      addEventListener(t, fn) { this._listeners.set(t, fn); }
      render() { this._listeners.get("render")?.(); return Promise.resolve(this); }
      close() { this._listeners.get("close")?.(); return Promise.resolve(this); }
    }

    globalThis.HTMLElement = FakeDomNode;
    globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      i18n: { localize: (k) => k, format: (k) => k },
      modules: new Map()
    };

    const rep = await import(`../scripts/reputation.js?rep-rev=${Date.now()}`);
    const dialog = rep.openReputationDialog(null, actor);
    assert.ok(dialog);
    const { rowsRoot } = dialog;

    const firstRow = rowsRoot.querySelector(".fblqa-reputation-row");
    const amountInput = firstRow.querySelector("input[data-field='amount']");
    assert.ok(amountInput);

    const origSetTimeout = globalThis.setTimeout;
    let scheduledFn = null;
    globalThis.setTimeout = (fn) => { scheduledFn = fn; return 123; };
    try {
      // Edit 1 -> schedules debounce save
      amountInput.value = "2";
      rowsRoot.dispatch("input", { target: amountInput });
      assert.ok(scheduledFn, "edit 1 schedules save");

      // Fire save 1 (now suspended mid actor.update)
      const save1Fn = scheduledFn;
      scheduledFn = null;
      save1Fn();
      await firstSaveStarted.promise;

      // Edit 2 happens WHILE save 1 is in flight!
      amountInput.value = "3";
      rowsRoot.dispatch("input", { target: amountInput });
      assert.ok(scheduledFn, "edit 2 schedules another save");

      // Now save 1 resolves — dirty MUST remain true because revision advanced on edit 2!
      releaseFirstSave.resolve();
      await nextTurn();

      // User closes dialog BEFORE edit 2's debounce fires -> close() MUST still save amount=3!
      await dialog.close();
      await nextTurn();
      assert.deepEqual(savedSnapshots.map(entries => entries[0].amount), [2, 3]);
      assert.equal(rep.getReputationEntries(actor)[0].amount, 1);

      const reopened = rep.openReputationDialog(null, actor);
      assert.equal(reopened.rowsRoot.querySelector("input[data-field='amount']").value, "3");
      allowSave = true;
      await reopened.close();
      await nextTurn();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    assert.equal(rep.getReputationEntries(actor)[0].amount, 3);
  } finally {
    restore();
  }
});

test("PR26: Money transfer persists GM-visible reconciliation record on partial veto and resolves safely without double debit", async () => {
  const restore = saveGlobals(["game", "ChatMessage", "ui", "Hooks", "localStorage"]);
  try {
    const worldSettings = new Map();
    const whispers = [];

    class FakeActor {
      constructor(id, name, gold) {
        this.id = id;
        this.name = name;
        this.type = "character";
        this.documentName = "Actor";
        this.flags = {};
        this.system = { currency: { gold: { value: gold }, silver: { value: 0 }, copper: { value: 0 } } };
      }
      testUserPermission(u) {
        if (u.isGM) return true;
        return (this.id === "sender" && u.id === "u-sender") || (this.id === "target" && u.id === "u-target");
      }
      static vetoTarget = true;
      static async updateDocuments(updates) {
        for (const u of updates) {
          if (u._id === "target" && FakeActor.vetoTarget) continue;
          const a = globalThis.game.actors.get(u._id);
          for (const [path, value] of Object.entries(u)) if (path !== "_id") setFoundryPath(a, path, value);
        }
      }
    }

    const senderActor = new FakeActor("sender", "Alice", 5);
    const targetActor = new FakeActor("target", "Bob", 1);
    const gm = { id: "u-gm", name: "GM", isGM: true, active: true, _flags: {}, getFlag(s, k) { return this._flags?.[s]?.[k]; }, async setFlag(s, k, v) { this._flags[s] ??= {}; this._flags[s][k] = structuredClone(v); }, async unsetFlag(s, k) { delete this._flags?.[s]?.[k]; } };
    const senderUser = { id: "u-sender", name: "Sender", isGM: false, active: true, character: senderActor, _flags: {}, getFlag(s, k) { return this._flags?.[s]?.[k]; }, async setFlag(s, k, v) { this._flags[s] ??= {}; this._flags[s][k] = structuredClone(v); }, async unsetFlag(s, k) { delete this._flags?.[s]?.[k]; } };
    const targetUser = { id: "u-target", name: "Target", isGM: false, active: true, character: targetActor, _flags: {}, getFlag(s, k) { return this._flags?.[s]?.[k]; }, async setFlag(s, k, v) { this._flags[s] ??= {}; this._flags[s][k] = structuredClone(v); }, async unsetFlag(s, k) { delete this._flags?.[s]?.[k]; } };

    const actors = [senderActor, targetActor];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;
    const users = [gm, senderUser, targetUser];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    const emittedPackets = [];
    let socketHandler = null;
    globalThis.Hooks = { callAll() {} };
    globalThis.ChatMessage = {
      getSpeaker: () => ({}),
      create: async (msg) => { whispers.push(msg); return msg; }
    };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    const storage = globalThis.localStorage = createMemoryStorage();
    globalThis.game = {
      user: gm,
      world: { id: "reconciliation-world" },
      users,
      actors,
      modules: new Map(),
      settings: {
        get(_s, k) { return worldSettings.get(k); },
        async set(_s, k, v) { worldSettings.set(k, structuredClone(v)); }
      },
      socket: {
        on(_ch, h) { socketHandler = h; },
        emit(_ch, msg) { emittedPackets.push(structuredClone(msg)); }
      },
      i18n: { localize: (k) => k, format: (k) => k }
    };

    const mt = await import(`../scripts/money-transfer.js?reconcile=${Date.now()}`);
    const auth = await import("../scripts/socket-auth.js");
    mt.registerMoneyTransferSocket();

    const requestId = "tx-reconcile-1";
    const offer = {
      type: "wallet-transfer-offer",
      requestId,
      requesterId: senderUser.id,
      recipientUserId: targetUser.id,
      primaryGmId: gm.id,
      sourceActorId: senderActor.id,
      targetActorId: targetActor.id,
      amounts: { gold: 2, silver: 0, copper: 0 },
      createdAt: Date.now()
    };
    await auth.createSocketProof("walletTransferOffer", requestId, offer, senderUser);
    socketHandler(offer);
    await new Promise((r) => setTimeout(r, 30));

    const decision = {
      type: "wallet-transfer-decision",
      requestId,
      requesterId: senderUser.id,
      recipientUserId: targetUser.id,
      primaryGmId: gm.id,
      accepted: true,
      reason: null,
      createdAt: Date.now()
    };
    await auth.createSocketProof("walletTransferDecision", requestId, decision, targetUser);
    socketHandler(decision);
    await new Promise((r) => setTimeout(r, 50));

    // Reconciliation record must be persisted and GM-visible with exact before/expected/observed
    const pending = mt.getPendingMoneyTransferReconciliations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, requestId);
    assert.deepEqual(pending[0].source.before, { gold: 5, silver: 0, copper: 0 });
    assert.deepEqual(pending[0].source.expected, { gold: 3, silver: 0, copper: 0 });
    assert.deepEqual(pending[0].source.observed, { gold: 3, silver: 0, copper: 0 });
    assert.deepEqual(pending[0].target.before, { gold: 1, silver: 0, copper: 0 });
    assert.deepEqual(pending[0].target.expected, { gold: 3, silver: 0, copper: 0 });
    assert.deepEqual(pending[0].target.observed, { gold: 1, silver: 0, copper: 0 });

    // Player-facing socket result must NOT expose raw reconciliation balances
    const resultPacket = emittedPackets.find((p) => p.type === "wallet-transfer-result");
    assert.equal(resultPacket?.result?.error, "update-incomplete");
    assert.equal("reconciliation" in (resultPacket?.result ?? {}), false);

    // GM-only whisper must be posted with requestId
    const gmWhisper = whispers.find((w) => String(w.content).includes(requestId));
    assert.ok(gmWhisper, "GM reconciliation whisper must include requestId");
    assert.deepEqual(gmWhisper.whisper, [gm.id]);
    assert.doesNotMatch(gmWhisper.content, /Alice|Bob|before|expected|observed/);
    assert.doesNotMatch(JSON.stringify([emittedPackets, whispers, users]), /"before"|"expected"|"observed"/);
    assert.equal(worldSettings.size, 0);
    game.user = senderUser;
    assert.deepEqual(mt.getPendingMoneyTransferReconciliations(), []);
    game.user = gm;

    // If an intervening wallet edit happens, applyRemaining must refuse with intervening-update
    targetActor.system.currency.gold.value = 99;
    const blocked = await mt.resolveMoneyTransferReconciliation(requestId, { applyRemaining: true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "intervening-update");

    // Restore observed state and clear veto -> applyRemaining credits ONLY recipient without double-debiting sender
    targetActor.system.currency.gold.value = 1;
    FakeActor.vetoTarget = false;
    const persist = storage.setItem;
    storage.setItem = () => {};
    const unclosed = await mt.resolveMoneyTransferReconciliation(requestId, { applyRemaining: true });
    assert.deepEqual(unclosed, { ok: false, error: "reconciliation-not-persisted" });
    assert.equal(senderActor.system.currency.gold.value, 3);
    assert.equal(targetActor.system.currency.gold.value, 3);
    assert.equal(mt.getPendingMoneyTransferReconciliations()[0].status, "pending");
    storage.setItem = persist;
    const resolved = await mt.resolveMoneyTransferReconciliation(requestId, { applyRemaining: true });
    assert.equal(resolved.ok, true);
    assert.equal(senderActor.system.currency.gold.value, 3, "sender must not be debited again");
    assert.equal(targetActor.system.currency.gold.value, 3, "recipient must receive the missing credit");
    assert.equal(mt.getPendingMoneyTransferReconciliations().length, 0);
  } finally {
    restore();
  }
});

test("PR26: Calendaria bulk rewind partial retry, vetoed marker non-replay, and legacy custom condition deterministic IDs", async () => {
  const restore = saveGlobals(["game", "ui", "CALENDARIA", "foundry"]);
  try {
    const ordinal = (d) => d.year * 360 + (d.month - 1) * 30 + d.day;
    const api = {
      getActiveCalendar: () => ({ id: "air" }),
      getCurrentDateTime: () => ({ year: 882, month: 4, day: 12 }),
      daysBetween: (a, b) => ordinal(b) - ordinal(a),
      addDays: (date, days) => {
        const day = ordinal(date) + days - 1;
        return { year: Math.floor(day / 360), month: Math.floor(day % 360 / 30) + 1, day: day % 30 + 1 };
      }
    };
    globalThis.CALENDARIA = { api };
    globalThis.foundry = { utils: { randomID: () => "rand-new-id", deepClone: (v) => structuredClone(v) } };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

    // 1. Legacy custom condition without id receives deterministic ID across repeated reads
    const { normalizeCustomConditionList } = await import("../scripts/conditions/utils.js");
    const rawLegacy = [{ name: "Legacy Exhaustion", time: "2 days", notes: "old", desc: "" }];
    const firstNorm = normalizeCustomConditionList(rawLegacy);
    const secondNorm = normalizeCustomConditionList(rawLegacy);
    assert.equal(firstNorm.changed, true);
    assert.equal(firstNorm.list[0].id, secondNorm.list[0].id, "unmigrated legacy condition ID must be deterministic across reads");

    // 2. Bulk rewind partial failure reports per-actor outcomes and retrying failed actors never double-shifts succeeded actors
    const actorA = makeFoundryActor({
      id: "rewind-a",
      name: "Actor A",
      _flags: { "fbl-quick-access": { stateProgressionCalendaria: { calendarId: "air", date: { year: 882, month: 4, day: 12 } } } }
    });
    const actorB = makeFoundryActor({
      id: "rewind-b",
      name: "Actor B",
      cancelUpdate: true,
      _flags: { "fbl-quick-access": { stateProgressionCalendaria: { calendarId: "air", date: { year: 882, month: 4, day: 12 } } } }
    });
    const gm = { id: "gm", name: "GM", isGM: true, active: true };
    const uA = { id: "ua", name: "UA", isGM: false, active: true, character: actorA };
    const uB = { id: "ub", name: "UB", isGM: false, active: true, character: actorB };
    const actors = [actorA, actorB];
    actors.get = (id) => actors.find((a) => a.id === id) ?? null;
    const users = [gm, uA, uB];
    users.get = (id) => users.find((u) => u.id === id) ?? null;

    globalThis.game = {
      user: gm,
      users,
      actors,
      modules: new Map([["calendaria", { active: true }]]),
      settings: { get: (_s, k) => (k === "stateProgressionMode" ? "calendaria" : true) },
      i18n: { localize: (k) => k, format: (k) => k }
    };

    const sp = await import("../scripts/state-progression.js");
    const context = { calendarId: "air", date: { year: 882, month: 4, day: 12 }, api };

    const firstRewind = await sp.rewindAllCalendarMarkers(2, context, api);
    assert.equal(firstRewind.ok, false);
    assert.equal(firstRewind.count, 1);
    assert.deepEqual(firstRewind.failedActorIds, ["rewind-b"]);
    assert.deepEqual(Object.keys(firstRewind.targetDates), [actorB.id]);
    assert.deepEqual(actorA.getFlag("fbl-quick-access", "stateProgressionCalendaria").date, { year: 882, month: 4, day: 10 });
    assert.deepEqual(actorB.getFlag("fbl-quick-access", "stateProgressionCalendaria").date, { year: 882, month: 4, day: 12 });

    const nextDay = { ...context, date: { ...context.date, day: 11 } };
    await sp.setActorCalendarMarker(actorA, nextDay);
    actorB.setCancelUpdate(false);
    await sp.setActorCalendarMarker(actorB, nextDay);
    const staleRetry = await sp.rewindAllCalendarMarkers(2, context, api, { targetDates: firstRewind.targetDates });
    assert.equal(staleRetry.failed[0]?.error.code, "stale-calendar-marker");
    assert.deepEqual(sp.getActorCalendarMarker(actorB).date, nextDay.date);

    await sp.setActorCalendarMarker(actorB, context);
    const retryRewind = await sp.rewindAllCalendarMarkers(2, context, api, { targetDates: firstRewind.targetDates });
    assert.equal(retryRewind.ok, true);
    assert.deepEqual(sp.getActorCalendarMarker(actorA).date, nextDay.date);
    assert.deepEqual(actorB.getFlag("fbl-quick-access", "stateProgressionCalendaria").date, { year: 882, month: 4, day: 10 });
    const repeated = await sp.rewindAllCalendarMarkers(2, context, api, { targetDates: firstRewind.targetDates });
    assert.equal(repeated.succeeded[0]?.changed, false);

    await assert.rejects(sp.rewindActorCalendarMarker(actorA, 365, context, api), { code: "rewind-backlog-limit" });
    assert.deepEqual(sp.getActorCalendarMarker(actorA).date, nextDay.date);
    const capped = await sp.rewindActorCalendarMarker(actorA, 364, context, api);
    assert.equal(api.daysBetween(capped.marker.date, context.date), 365);

    // 3. Vetoed marker write after committed New Day actions must NOT replay injury decrement on retry
    const injury = {
      id: "inj-replay",
      name: "Broken Arm",
      type: "criticalInjury",
      system: { healingTime: "5 days", lethal: "no" },
      getFlag() { return null; },
      async update(patch) {
        if ("system.healingTime" in patch) this.system.healingTime = patch["system.healingTime"];
        return this;
      }
    };
    const pcItems = [injury];
    pcItems.get = (id) => pcItems.find((i) => i.id === id) ?? null;
    const replayActor = makeFoundryActor({
      id: "replay-pc",
      name: "Replay PC",
      items: pcItems,
      _flags: { "fbl-quick-access": { stateProgressionCalendaria: { calendarId: "air", date: { year: 882, month: 4, day: 11 } } } },
      testUserPermission: () => true,
      async updateEmbeddedDocuments(_type, updates) {
        for (const u of updates) await pcItems.get(u._id)?.update(u);
      }
    });
    const updateActor = replayActor.update;
    let vetoMarker = true;
    replayActor.update = function (data, options) {
      if (vetoMarker && Object.hasOwn(data, "flags.fbl-quick-access.==stateProgressionCalendaria")) return undefined;
      return updateActor.call(this, data, options);
    };
    const uR = { id: "ur", name: "UR", isGM: false, active: true, character: replayActor };
    actors.push(replayActor);
    users.push(uR);

    const { executeAsActiveGM } = await import("../scripts/integration/socket-api.js");
    sp.initializeStateProgression();
    const newDay = await import("../scripts/new-day.js");
    const plan = await newDay.buildNewDayPlanWithProviders(replayActor);
    const injAction = plan.actions.find((a) => a.kind === "injury-healing");

    // Attempt 1: injury decrements 5 -> 4, then marker write is vetoed -> rejects with write-not-persisted
    await assert.rejects(
      executeAsActiveGM("state-progression.apply-calendaria-day", {
        actorId: replayActor.id,
        calendarId: "air",
        targetDate: { year: 882, month: 4, day: 12 },
        selectedIds: [injAction.id],
        selectedPreconditions: { [injAction.id]: plan.preconditions[injAction.id] }
      }),
      (err) => err?.code === "write-not-persisted"
    );
    assert.equal(injury.system.healingTime, "4 days");
    assert.deepEqual(replayActor.getFlag("fbl-quick-access", "stateProgressionCalendaria").date, { year: 882, month: 4, day: 11 });

    // Attempt 2 (after marker veto lifts, even with refreshed preview): MUST persist marker ONLY and keep injury at 4 days (NOT 3 days!)
    vetoMarker = false;
    const refreshedPlan = await newDay.buildNewDayPlanWithProviders(replayActor);
    const refreshedAction = refreshedPlan.actions.find((a) => a.kind === "injury-healing");
    const retryRes = await executeAsActiveGM("state-progression.apply-calendaria-day", {
      actorId: replayActor.id,
      calendarId: "air",
      targetDate: { year: 882, month: 4, day: 12 },
      selectedIds: [refreshedAction.id],
      selectedPreconditions: { [refreshedAction.id]: refreshedPlan.preconditions[refreshedAction.id] }
    });
    assert.equal(retryRes.status, "processed");
    assert.deepEqual(retryRes.calendarResult.recoveredMarkerDate, { year: 882, month: 4, day: 12 });
    assert.deepEqual(retryRes.calendarResult.days, []);
    assert.equal(injury.system.healingTime, "4 days", "retry must NOT replay already committed injury decrement");
    assert.deepEqual(replayActor.getFlag("fbl-quick-access", "stateProgressionCalendaria").date, { year: 882, month: 4, day: 12 });
  } finally {
    restore();
  }
});

test("PR26: static guards confirm tooltip ownership and STAT live merge", () => {
  const tooltipsSrc = readFileSync(join(root, "scripts", "tooltips.js"), "utf8");
  const condMainSrc = readFileSync(join(root, "scripts", "conditions", "main.js"), "utf8");

  assert.match(tooltipsSrc, /if\s*\(itemTooltipPinned\)\s*return;\s*\r?\n\s*itemTooltipPointer\s*=/);
  assert.match(tooltipsSrc, /if\s*\(request === itemTooltipRequest && itemTooltipAnchor === anchor\)\s*hideItemTooltip\(\);/);
  assert.match(condMainSrc, /enqueueActorMutationOperation\(app\.actor, async \(\) => \{[\s\S]*?const list = getLiveCustomConditions\(\)/);
  assert.match(condMainSrc, /if \(!entry\) return false;\s*value = edit\(entry\[field\]\)/);
});
