const HEAT_LEVELS = Object.freeze({
  0: Object.freeze({
    label: "Normal",
    summary: "No mechanical effect. Heat rises only after Endurance failure.",
    consequence: "Failure: 0 → 1, no damage."
  }),
  1: Object.freeze({
    label: "Warming",
    summary: "Warming up. No skill penalties.",
    consequence: "Failure: 1 → 2, no damage."
  }),
  2: Object.freeze({
    label: "Overheating",
    summary: "Overheating. No Endurance or Move penalties.",
    consequence: "Failure: 2 → 3 and 1 Strength damage."
  }),
  3: Object.freeze({
    label: "Heat exhaustion",
    summary: "On reaching this level, the character suffers 1 Strength damage.",
    consequence: "Next failure: 3 → 4 and 1 damage each to Strength and Wits."
  }),
  4: Object.freeze({
    label: "Heat stroke",
    summary: "−1 to Endurance and Move is applied automatically.",
    consequence: "Next failure: Heat remains 4/4 and deals 1 damage each to Strength, Wits and Agility. Cooling below 4 removes the penalties."
  })
});

const WASH_STATES = Object.freeze([
  "Я в раю",
  "Хорошенько помытый",
  "Помытый",
  "Немытый",
  "Вонючка",
  "Грязнуля"
]);

const WASH_PROGRESSION = Object.freeze({
  "Я в раю": "Помытый",
  "Хорошенько помытый": "Немытый",
  "Помытый": "Немытый",
  "Немытый": "Вонючка",
  "Вонючка": "Грязнуля"
});

export const CONDITION_DEFINITIONS = Object.freeze({
  heat: Object.freeze({
    key: "heat",
    names: Object.freeze(["жара", "heat"]),
    max: 4,
    levels: HEAT_LEVELS,
    storage: Object.freeze({ flag: "heatValue" })
  }),
  wash: Object.freeze({
    key: "wash",
    names: WASH_STATES,
    progression: WASH_PROGRESSION,
    exclusive: true
  })
});
