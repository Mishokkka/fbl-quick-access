const HEAT_LEVELS = Object.freeze({
  0: Object.freeze({
    label: "Normal",
    summary: "The temperature is tolerable. There is no mechanical effect.",
    consequence: "Heat deals no damage. Travel can continue normally."
  }),
  1: Object.freeze({
    label: "Warming",
    summary: "The character is warming up. The next hot quarter day is dangerous.",
    consequence: "There is no penalty. Resting in shade with water removes 1 Heat point."
  }),
  2: Object.freeze({
    label: "Overheating",
    summary: "-1 to Endurance and Move while the character remains in the heat.",
    consequence: "At the end of each hot quarter day, make an Endurance roll. Failure increases Heat by 1."
  }),
  3: Object.freeze({
    label: "Heat exhaustion",
    summary: "On reaching this level, the character suffers 1 Strength damage.",
    consequence: "Each further hot quarter day requires Endurance. Failure deals another 1 Strength damage."
  }),
  4: Object.freeze({
    label: "Heat stroke",
    summary: "A failed Endurance roll deals 1 Strength damage and 1 Wits damage.",
    consequence: "Daytime travel without water, shade, or magic carries severe risk."
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
