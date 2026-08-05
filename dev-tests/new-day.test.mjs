import test from "node:test";
import assert from "node:assert/strict";

globalThis.game = {
  i18n: {
    localize: (key) => key,
    format: (key) => key
  },
  settings: {
    get: (_moduleId, key) => key === "chatMessages" ? false : true
  },
  user: { isGM: true },
  modules: new Map()
};

globalThis.foundry = {
  utils: {
    deepClone: (value) => structuredClone(value),
    mergeObject: (base, patch) => ({ ...base, ...(patch ?? {}) })
  }
};

const newDay = await import("../scripts/new-day.js");
const addiction = await import("../scripts/conditions/services/addiction-service.js");
const addictionChat = await import("../scripts/conditions/services/chat-service.js");

test("new-day timer helpers preserve text and reject unresolved dice formulas", () => {
  assert.deepEqual(newDay.decrementFirstInteger("3 days"), {
    beforeNumber: 3,
    afterNumber: 2,
    beforeText: "3 days",
    afterText: "2 days"
  });
  assert.equal(newDay.decrementFirstInteger("d6 days"), null);
  assert.equal(newDay.decrementFirstInteger("Permanent"), null);
  assert.equal(newDay.isDailyLethalLimit("2 days"), true);
  assert.equal(newDay.isDailyLethalLimit("3"), true);
  assert.equal(newDay.isDailyLethalLimit("4 hours"), false);
  assert.equal(newDay.isDailyLethalLimit("d6 days"), false);
});

test("addiction cycle progression is shared by STAT and the new-day assistant", () => {
  assert.deepEqual(addiction.calculateNextAddictionState({ phase: "down", die: 12, severity: 5 }), {
    state: { phase: "down", die: 10, daysLeft: 0, severity: 5 },
    cured: false
  });
  assert.deepEqual(addiction.calculateNextAddictionState({ phase: "down", die: 6, severity: 5 }), {
    state: { phase: "flat", die: 6, daysLeft: 5, severity: 5 },
    cured: false
  });
  assert.deepEqual(addiction.calculateNextAddictionState({ phase: "flat", die: 6, daysLeft: 1, severity: 5 }), {
    state: { phase: "up", die: 6, daysLeft: 0, severity: 5 },
    cured: false
  });
  assert.equal(addiction.calculateNextAddictionState({ phase: "up", die: 12, severity: 5 }).cured, true);
  assert.equal(addiction.shouldAdvanceAddictionAfterRoll(1), false);
  assert.equal(addiction.shouldAdvanceAddictionAfterRoll(2), false);
  assert.equal(addiction.shouldAdvanceAddictionAfterRoll(3), true);
  assert.equal(addiction.shouldAdvanceAddictionAfterRoll(6), true);
});

test("automatic addiction progression happens only after a controlled craving roll", async () => {
  const originalRoll = globalThis.Roll;
  try {
    globalThis.Roll = class MockRoll {
      constructor() {}
      async evaluate() {
        this.total = 2;
        return this;
      }
    };

    const blockedItem = makeAddictionItem({ phase: "down", die: 12, daysLeft: 0, severity: 5 });
    const blocked = await addiction.processAddictionNewDay({ name: "Tester" }, blockedItem);
    assert.equal(blocked.advanced, false);
    assert.equal(blockedItem.savedState.die, 12);

    globalThis.Roll = class MockRoll {
      constructor() {}
      async evaluate() {
        this.total = 4;
        return this;
      }
    };

    const advancedItem = makeAddictionItem({ phase: "down", die: 12, daysLeft: 0, severity: 5 });
    const advanced = await addiction.processAddictionNewDay({ name: "Tester" }, advancedItem);
    assert.equal(advanced.advanced, true);
    assert.equal(advancedItem.savedState.die, 10);
  } finally {
    globalThis.Roll = originalRoll;
  }
});

test("automatic addiction chat does not ask for manual cycle advancement", () => {
  const flavor = addictionChat.buildAddictionRollMessage("Tester", "Addiction", { die: 12 }, 4, {
    autoAdvanced: true
  });
  assert.match(flavor, /automatically/i);
  assert.doesNotMatch(flavor, /Remember to advance/i);
});

test("new-day plan covers injuries, lethal limits, wash, custom conditions, addiction, and Short Rest reset", () => {
  const actor = makeActor();
  const plan = newDay.buildNewDayPlan(actor);
  const kinds = plan.actions.map((action) => action.kind);

  assert.ok(kinds.includes("injury-healing"));
  assert.ok(kinds.includes("injury-expire"));
  assert.ok(kinds.includes("lethal-limit"));
  assert.ok(kinds.includes("wash-transition"));
  assert.ok(kinds.includes("custom-condition"));
  assert.ok(kinds.includes("custom-condition-expire"));
  assert.ok(kinds.includes("addiction-day"));
  assert.ok(kinds.includes("short-rest-reset"));
  assert.equal(kinds.includes("heat"), false);
  assert.equal(kinds.includes("mor"), false);

  assert.equal(plan.actions.filter((action) => action.kind === "addiction-day").length, 1,
    "addiction must be processed as one conditional daily action");
});

test("selected new-day actions update timers without applying unselected actions", async () => {
  const actor = makeActor();
  const plan = newDay.buildNewDayPlan(actor);
  const selected = plan.actions
    .filter((action) => ["injury-healing", "lethal-limit", "custom-condition", "short-rest-reset"].includes(action.kind))
    .map((action) => action.id);

  const result = await newDay.applyNewDayPlan(actor, plan, selected);
  assert.equal(result.failed.length, 0);
  assert.equal(result.succeeded.length, 4);

  const injury = actor.items.find((item) => item.id === "injury");
  assert.deepEqual(injury.updates, [
    { "system.healingTime": "2 days" },
    { "system.limit": "1 day" }
  ]);
  assert.equal(actor.savedConditions.find((condition) => condition.id === "custom").time, "1 day");
  assert.deepEqual(actor.unsetFlags, [["fbl-quick-access", "shortRestRecovery"]]);

  const wash = actor.items.find((item) => item.id === "wash");
  assert.deepEqual(wash.updates, [], "unselected wash progression must not run");
});


test("non-permanent injuries and custom conditions are deleted when their daily timer reaches zero", async () => {
  const actor = makeActor();
  const plan = newDay.buildNewDayPlan(actor);
  const selected = plan.actions
    .filter((action) => ["injury-expire", "custom-condition-expire"].includes(action.kind))
    .map((action) => action.id);

  const result = await newDay.applyNewDayPlan(actor, plan, selected);
  assert.equal(result.failed.length, 0);
  assert.equal(result.succeeded.length, 2);
  assert.equal(actor.items.find((item) => item.id === "healed").deleted, true);
  assert.equal(actor.savedConditions.some((condition) => condition.id === "custom-expire"), false);
});

function makeActor() {
  const addictionState = { phase: "down", die: 12, daysLeft: 0, severity: 5 };
  const items = [
    makeItem("injury", "Broken Arm", { healingTime: "3 days", lethal: "yes", limit: "2 days" }),
    makeItem("healed", "Shallow Cut", { healingTime: "1 day", lethal: "no", limit: "0" }),
    makeItem("wash", "Помытый", { healingTime: "1 day", lethal: "no", limit: "0" }),
    makeItem("addiction", "Зависимость: Морфин", { healingTime: "", lethal: "no", limit: "0" }, addictionState),
    makeItem("heat", "Heat", { healingTime: "2", lethal: "no", limit: "0" }),
    makeItem("mor", "Mor", { healingTime: "1/0", lethal: "no", limit: "0" })
  ];

  return {
    id: "actor",
    name: "Tester",
    items,
    savedConditions: [
      { id: "custom", name: "Fever", time: "2 days", notes: "", desc: "" },
      { id: "custom-expire", name: "Bruised", time: "1 day", notes: "", desc: "" },
      { id: "arc", name: "[ARC] Story", time: "4 days", notes: "", desc: "" }
    ],
    unsetFlags: [],
    getFlag(_moduleId, key) {
      if (key === "conditions.list") return this.savedConditions;
      return null;
    },
    async setFlag(_moduleId, key, value) {
      if (key === "conditions.list") this.savedConditions = value;
    },
    async unsetFlag(moduleId, key) {
      this.unsetFlags.push([moduleId, key]);
    }
  };
}

function makeItem(id, name, system, addictionState = null) {
  return {
    id,
    name,
    type: "criticalInjury",
    system,
    updates: [],
    deleted: false,
    getFlag(_moduleId, key) {
      if (key === "conditions.addictionState") return addictionState;
      return undefined;
    },
    async update(data) {
      this.updates.push(data);
    },
    async delete() {
      this.deleted = true;
    }
  };
}

function makeAddictionItem(initialState) {
  return {
    id: "addiction-test",
    name: "Addiction",
    type: "criticalInjury",
    system: { rollModifiers: {} },
    savedState: structuredClone(initialState),
    modifierKeys: [],
    getFlag(_moduleId, key) {
      if (key === "conditions.addictionState") return this.savedState;
      if (key === "conditions.addictionModifierKeys") return this.modifierKeys;
      return undefined;
    },
    async setFlag(_moduleId, key, value) {
      if (key === "conditions.addictionState") this.savedState = structuredClone(value);
    },
    async update(data) {
      const addictionStatePath = "flags.fbl-quick-access.conditions.addictionState";
      const modifierKeysPath = "flags.fbl-quick-access.conditions.addictionModifierKeys";
      if (data[addictionStatePath]) this.savedState = structuredClone(data[addictionStatePath]);
      if (Array.isArray(data[modifierKeysPath])) this.modifierKeys = [...data[modifierKeysPath]];
    },
    async delete() {
      this.deleted = true;
    }
  };
}
