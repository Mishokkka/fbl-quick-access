import test from "node:test";
import assert from "node:assert/strict";

globalThis.CONFIG = {
  fbl: {
    encumbrance: {
      none: 0,
      tiny: 0,
      light: 0.5,
      regular: 1,
      heavy: 2
    }
  }
};

globalThis.game = {
  i18n: {
    lang: "ru",
    localize: (key) => key
  },
  modules: new Map()
};

const currency = await import("../scripts/currency.js");
const itemUtils = await import("../scripts/item-utils.js");
const quickAccess = await import("../scripts/quick-access.js");
const willpower = await import("../scripts/willpower.js");
const dragData = await import("../scripts/drag-data.js");

test("currency expressions accept direct and relative arithmetic", () => {
  assert.deepEqual(currency.parseCurrencyExpression("15"), { ok: true, value: 15, relative: false });
  assert.deepEqual(currency.parseCurrencyExpression("10-2"), { ok: true, value: 8, relative: false });
  assert.deepEqual(currency.parseCurrencyExpression("+5"), { ok: true, value: 5, relative: true });
  assert.deepEqual(currency.parseCurrencyExpression("-13"), { ok: true, value: -13, relative: true });
  assert.deepEqual(currency.parseCurrencyExpression("1+2-3"), { ok: true, value: 0, relative: false });
});

test("currency expressions reject unsafe or ambiguous input", () => {
  assert.equal(currency.parseCurrencyExpression("").ok, false);
  assert.equal(currency.parseCurrencyExpression("1g").ok, false);
  assert.equal(currency.parseCurrencyExpression("1*2").ok, false);
  assert.equal(currency.parseCurrencyExpression("1 + two").ok, false);
});

test("wallet total keeps Forbidden Lands denomination scale", () => {
  const actor = {
    system: {
      currency: {
        gold: { value: 2 },
        silver: { value: 3 },
        copper: { value: 4 }
      }
    }
  };

  assert.equal(currency.getWalletCopperTotal(actor), 234);
});

test("item weight aliases map to stable numeric values", () => {
  assert.equal(itemUtils.getItemWeightValue({ system: { weight: "none" } }), 0);
  assert.equal(itemUtils.getItemWeightValue({ system: { weight: "light" } }), 0.5);
  assert.equal(itemUtils.getItemWeightValue({ system: { weight: "regular" } }), 1);
  assert.equal(itemUtils.getItemWeightValue({ system: { weight: "heavy" } }), 2);
  assert.equal(itemUtils.getItemWeightValue({ system: { weight: 3 } }), 3);
});

test("carry-state normalization covers system and localized aliases", () => {
  assert.equal(itemUtils.normalizeItemCarryValue("equipped"), "equipped");
  assert.equal(itemUtils.normalizeItemCarryValue("рюкзак"), "backpack");
  assert.equal(itemUtils.normalizeItemCarryValue("брошено"), "dropped");
  assert.equal(itemUtils.normalizeItemCarryValue(true, "equipped"), "equipped");
  assert.equal(itemUtils.normalizeItemCarryValue(false, "equipped"), "");
});

test("dropped items are excluded from module encumbrance", () => {
  assert.equal(itemUtils.isItemCarriedForEncumbrance({ flags: { "forbidden-lands": { state: "dropped" } } }), false);
  assert.equal(itemUtils.isItemCarriedForEncumbrance({ flags: { "forbidden-lands": { state: "backpack" } } }), true);
  assert.equal(itemUtils.isItemCarriedForEncumbrance({ system: { equipped: true } }), true);
});

test("quick access capacity uses agility plus sleight of hand and caps at 10", () => {
  assert.deepEqual(
    quickAccess.getQuickCapacity({ system: { attribute: { agility: { max: 3 } }, skill: { "sleight-of-hand": { value: 2 } } } }),
    { capacity: 5, agilityMax: 3, sleightOfHand: 2 }
  );

  assert.equal(
    quickAccess.getQuickCapacity({ system: { attribute: { agility: { max: 9 } }, skill: { "sleight-of-hand": { value: 9 } } } }).capacity,
    10
  );
});

test("start Willpower calculation uses selected talent ranks", () => {
  const items = new Map([
    ["kin", { id: "kin", type: "talent", name: "Kin", system: { rank: { value: 2 } } }],
    ["prof", { id: "prof", type: "talent", name: "Prof", system: { rank: { value: 3 } } }]
  ]);

  const actor = {
    system: {
      attribute: { empathy: { max: 4 } },
      bio: { willpower: { value: 2, max: 10 } }
    },
    items,
    getFlag: () => ({ kinTalentId: "kin", professionalTalentId: "prof" })
  };

  const result = willpower.calculateStartWillpower(actor);
  assert.equal(result.value, 3);
  assert.equal(result.empathyMax, 4);
  assert.equal(result.professionalRank, 3);
  assert.equal(result.kinRank, 2);
});

test("drop data normalization supports item aliases and fblqa marker", () => {
  assert.deepEqual(
    dragData.normalizeDropData({ id: "abc", fblqaGearOrder: true }),
    {
      id: "abc",
      fblqaGearOrder: true,
      type: "Item",
      itemId: "abc",
      itemUuid: "",
      uuid: "",
      actorId: "",
      actorUuid: "",
      slotIndex: undefined
    }
  );

  assert.equal(dragData.normalizeDropData(null), null);
});

const rest = await import("../scripts/rest.js");

test("long rest restores only attributes not blocked by conditions", () => {
  globalThis.game.time = { worldTime: 0 };
  const actor = {
    system: {
      attribute: {
        strength: { value: 1, max: 3 },
        agility: { value: 1, max: 3 },
        wits: { value: 1, max: 3 },
        empathy: { value: 1, max: 3 }
      },
      condition: {
        hungry: { value: true },
        cold: { value: true },
        sleepy: { value: true },
        thirsty: { value: false }
      }
    },
    getFlag: () => null
  };

  const result = rest.calculateLongRestChanges(actor, { hasHeatSource: true });
  assert.deepEqual(result.updates, {
    "system.attribute.agility.value": 2,
    "system.attribute.empathy.value": 2,
    "system.condition.sleepy.value": false,
    "system.condition.cold.value": false
  });
  assert.deepEqual(result.recovered.sort(), ["agility", "empathy"]);
  assert.deepEqual(result.clearedConditions.sort(), ["cold", "sleepy"]);
});

test("short rest restores one attribute once per quarter day", () => {
  globalThis.game.time = { worldTime: 21600 };
  const actor = {
    system: {
      attribute: {
        strength: { value: 2, max: 3 },
        agility: { value: 3, max: 3 },
        wits: { value: 1, max: 3 },
        empathy: { value: 1, max: 3 }
      },
      condition: {}
    },
    getFlag: () => null
  };

  const result = rest.calculateShortRestChanges(actor, {
    useShortRecovery: true,
    shortAttribute: "strength",
    shortConsumable: "food"
  });

  assert.deepEqual(result.updates, { "system.attribute.strength.value": 3 });
  assert.equal(result.flagValue.quarterKey, "world:1");
  assert.equal(result.flagValue.attribute, "strength");
});

test("short rest refuses recovery already used in the same quarter day", () => {
  globalThis.game.time = { worldTime: 21600 };
  const actor = {
    system: {
      attribute: { strength: { value: 2, max: 3 } },
      condition: {}
    },
    getFlag: () => ({ quarterKey: "world:1", attribute: "wits" })
  };

  const result = rest.calculateShortRestChanges(actor, {
    useShortRecovery: true,
    shortAttribute: "strength"
  });

  assert.equal(Object.keys(result.updates).length, 0);
  assert.equal(result.errors.length, 1);
});

test("short rest condition blockers match house-rule mapping", () => {
  globalThis.game.time = { worldTime: 43200 };
  const actor = {
    system: {
      attribute: {
        agility: { value: 1, max: 3 },
        wits: { value: 1, max: 3 }
      },
      condition: {
        thirsty: { value: true },
        sleepy: { value: true }
      }
    },
    getFlag: () => null
  };

  assert.equal(rest.calculateShortRestChanges(actor, { useShortRecovery: true, shortAttribute: "agility" }).errors.length, 1);
  assert.equal(rest.calculateShortRestChanges(actor, { useShortRecovery: true, shortAttribute: "wits" }).errors.length, 1);
});

test("rest condition detection can fall back to Forbidden Lands data-condition controls", () => {
  const PreviousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class HTMLElementMock {};

  class ElementMock extends globalThis.HTMLElement {
    constructor(condition, classes = []) {
      super();
      this.dataset = { condition };
      this.classList = { contains: (className) => classes.includes(className) };
    }
    getAttribute(name) {
      return name === "data-active" ? "true" : null;
    }
    querySelector() {
      return null;
    }
  }

  const root = {
    querySelectorAll: () => [new ElementMock("sleepy", ["condition"])]
  };

  const state = rest.getRestConditionState({ system: {} }, { root });
  assert.equal(state.sleepy, true);
  assert.equal(state.hungry, false);

  if (PreviousHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = PreviousHTMLElement;
});


test("long rest clears conditions detected only from the sheet DOM fallback", () => {
  const PreviousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class HTMLElementMock {};

  class ElementMock extends globalThis.HTMLElement {
    constructor(condition) {
      super();
      this.dataset = { condition };
      this.classList = { contains: (className) => className === "condition" };
    }
    getAttribute(name) {
      return name === "data-active" ? "true" : null;
    }
    querySelector() {
      return null;
    }
  }

  const root = {
    querySelectorAll: () => [new ElementMock("sleepy"), new ElementMock("cold")]
  };
  const actor = {
    system: {
      attribute: {
        strength: { value: 3, max: 4 },
        wits: { value: 2, max: 3 }
      }
    },
    getFlag: () => null
  };

  const result = rest.calculateLongRestChanges(actor, { hasHeatSource: true }, { root });
  assert.equal(result.updates["system.condition.sleepy.value"], false);
  assert.equal(result.updates["system.condition.cold.value"], false);
  assert.deepEqual(result.clearedConditions.sort(), ["cold", "sleepy"]);

  if (PreviousHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = PreviousHTMLElement;
});



test("long rest clears Forbidden Lands condition ActiveEffects as well as system flags", () => {
  globalThis.game.time = { worldTime: 0 };
  const deleted = [];
  const sleepyEffect = {
    id: "sleepy-effect",
    statuses: new Set(["sleepy"]),
    delete: async () => deleted.push("sleepy")
  };
  const coldEffect = {
    id: "cold-effect",
    flags: { core: { statusId: "cold" } },
    delete: async () => deleted.push("cold")
  };
  const actor = {
    system: {
      attribute: {
        strength: { value: 3, max: 4 },
        wits: { value: 2, max: 3 }
      },
      condition: {
        sleepy: { value: true },
        cold: { value: true }
      }
    },
    effects: [sleepyEffect, coldEffect],
    getFlag: () => null
  };

  const result = rest.calculateLongRestChanges(actor, { hasHeatSource: true });
  assert.equal(result.updates["system.condition.sleepy.value"], false);
  assert.equal(result.updates["system.condition.cold.value"], false);
  assert.deepEqual(result.effectsToDelete.map((effect) => effect.id).sort(), ["cold-effect", "sleepy-effect"]);
  assert.deepEqual(result.clearedConditions.sort(), ["cold", "sleepy"]);
});

test("rest quarter keys prefer Calendaria date-time when available", () => {
  const previousCalendaria = globalThis.CALENDARIA;
  globalThis.CALENDARIA = {
    api: {
      getCurrentDateTime: () => ({ year: 1165, month: 3, day: 5, hour: 13, minute: 30, second: 0 }),
      getActiveCalendar: () => ({ days: { hoursPerDay: 24 } })
    }
  };

  const info = rest.getCurrentQuarterInfo();
  assert.equal(info.source, "calendaria");
  assert.equal(info.key, "calendaria:1165:3:5:q2");

  if (previousCalendaria === undefined) delete globalThis.CALENDARIA;
  else globalThis.CALENDARIA = previousCalendaria;
});
