import { CURRENCIES } from "./constants.js";
import { getActorAttributeMaximum } from "./actor-data.js";
import { getCurrencyValue } from "./currency.js";
import { getItemWeightValue, isItemCarriedForEncumbrance } from "./item-utils.js";
import { firstFiniteNumber } from "./utils.js";

export function getEncumbrance(actor) {
  const system = actor.system ?? {};
  let value = 0;

  for (const item of actor.items ?? []) {
    value += getCarriedItemEncumbrance(item);
  }

  if (actor.type === "character") {
    for (const consumable of Object.values(system.consumable ?? {})) {
      if (Number(consumable?.value ?? 0) > 0) value += 1;
    }

    const coins = CURRENCIES.reduce((sum, currency) => {
      return sum + getCurrencyValue(actor, currency.key);
    }, 0);

    value += Math.floor(coins / 100) * 0.5;
  }

  const strengthMax = getActorAttributeMaximum(actor, "strength");

  const modifierOptions = typeof actor.getRollModifierOptions === "function"
    ? actor.getRollModifierOptions("carryingCapacity")
    : [];
  const carryingModifiers = Array.isArray(modifierOptions) ? modifierOptions : [];

  const modifierTotal = carryingModifiers.reduce((sum, modifier) => {
    return sum + (Number.parseInt(modifier?.value ?? 0, 10) || 0);
  }, 0);

  const max = strengthMax * 2 + modifierTotal;

  return { value, max, over: value > max };
}

function getCarriedItemEncumbrance(item) {
  if (!isItemCarriedForEncumbrance(item)) return 0;

  if (item.type === "rawMaterial") {
    return Math.max(0, firstFiniteNumber(item.system?.quantity, 0));
  }

  if (["gear", "armor", "weapon"].includes(item.type)) {
    return getItemWeightValue(item);
  }

  return 0;
}
