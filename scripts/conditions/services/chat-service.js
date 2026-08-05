import { escapeHTML, localize } from "../utils.js";

const ATTRIBUTE_KEYS = Object.freeze({
  strength: "Attribute.Strength",
  agility: "Attribute.Agility",
  wits: "Attribute.Wits",
  empathy: "Attribute.Empathy"
});

export function describeAttributeDamage(appliedDamage) {
  if (!Array.isArray(appliedDamage) || !appliedDamage.length) return "";

  return appliedDamage
    .map((entry) => {
      const key = ATTRIBUTE_KEYS[entry.attribute];
      const label = key ? localize(key, entry.attribute) : String(entry.attribute || "");
      return `${label}: ${entry.previous} → ${entry.value}`;
    })
    .join(", ");
}

export function buildAddictionFlatMessage(actorName, itemName, state) {
  return [
    localize("Chat.Addiction.Intro", "<b>{actor}</b> wakes and feels the call of <b>{condition}</b>...<br>", {
      actor: escapeHTML(actorName),
      condition: escapeHTML(itemName)
    }),
    localize("Chat.Addiction.Flat", "<span class=\"fblec-chat-danger\">Severe withdrawal. Days remaining: {days}.</span><br>", {
      days: Number(state.daysLeft) || 0
    }),
    localize("Chat.Addiction.EnduranceRequired", "No craving die is rolled. <b>Make an Endurance roll.</b> Failure causes a relapse.")
  ].join("");
}

export function buildAddictionRollMessage(actorName, itemName, state, rollTotal, options = {}) {
  let content = localize("Chat.Addiction.Intro", "<b>{actor}</b> wakes and feels the call of <b>{condition}</b>...<br>", {
    actor: escapeHTML(actorName),
    condition: escapeHTML(itemName)
  });
  content += localize("Chat.Addiction.Roll", "Craving roll (1d{die}): <b>{total}</b>.<br>", {
    die: Number(state.die) || 6,
    total: Number(rollTotal) || 0
  });

  if (rollTotal === 1 || rollTotal === 2) {
    content += localize("Chat.Addiction.Urge", "<span class=\"fblec-chat-danger\">Rolled {total}. Compulsive urge.</span><br>", { total: rollTotal });
    content += localize("Chat.Addiction.EnduranceRequired", "<b>Make an Endurance roll.</b> Failure causes a relapse.");
  } else if (options.cured) {
    content += localize("Chat.Addiction.ControlledCured", "The craving is controlled. The addiction cycle advances automatically and the condition is cured.");
  } else if (options.autoAdvanced) {
    content += localize("Chat.Addiction.ControlledAutomatic", "The craving is controlled. No Endurance roll is required today; the addiction cycle advances automatically.");
  } else {
    content += localize("Chat.Addiction.Controlled", "The craving is controlled. No Endurance roll is required today. Remember to advance the cycle.");
  }

  return content;
}

export function buildAddictionRelapseMessage(actorName, itemName) {
  return localize("Chat.Addiction.Relapse", "<b>{actor}</b> gives in to <b>{condition}</b> and takes a dose.<br><i>The addiction cycle returns to its beginning (decline: d12).</i>", {
    actor: escapeHTML(actorName),
    condition: escapeHTML(itemName)
  });
}

export function buildHeatChangeMessage(actorName, result, mode = "gain") {
  const verbKey = result.overcap
    ? "Chat.Heat.VerbIntensify"
    : mode === "reduce"
      ? "Chat.Heat.VerbReduce"
      : "Chat.Heat.VerbGain";
  const verb = localize(verbKey, mode === "reduce" ? "reduces" : "gains");

  let content = localize("Chat.Heat.Change", "<b>{actor}</b> {verb} Heat: <b>{previous}/{max}</b> ➔ <b>{value}/{max}</b>.<br>", {
    actor: escapeHTML(actorName),
    verb: escapeHTML(verb),
    previous: Number(result.previousValue) || 0,
    value: Number(result.value) || 0,
    max: Number(result.heat?.max) || 4
  });
  content += `<b>${escapeHTML(result.level?.label)}:</b> ${escapeHTML(result.level?.summary)}<br>`;
  content += `<i>${escapeHTML(result.level?.consequence)}</i>`;

  const damage = describeAttributeDamage(result.appliedDamage);
  if (damage) {
    content += localize("Chat.Heat.AutomaticDamage", "<br><b>Automatic damage:</b> {damage}.", {
      damage: escapeHTML(damage)
    });
  }

  return content;
}

export function buildHeatCheckMessage(actorName, value, heat, level) {
  let content = localize("Chat.Heat.Status", "<b>{actor}</b>: Heat <b>{value}/{max}</b> — <b>{level}</b>.<br>", {
    actor: escapeHTML(actorName),
    value,
    max: heat.max,
    level: escapeHTML(level.label)
  });
  content += `${escapeHTML(level.summary)}<br><i>${escapeHTML(level.consequence)}</i>`;
  content += `<br><br>${localize(`Chat.Heat.Check${Math.max(0, Math.min(4, Number(value) || 0))}`, "Make an Endurance roll as required by the current Heat level.")}`;
  return content;
}

export function buildMorGainMessage(actorName, state, diceCount, ones, appliedDamage = []) {
  let content = localize("Chat.Mor.Gain", "<b>{actor}</b> gains 1 current Mor point. Mor: <b>{current}/{permanent}</b>.<br>", {
    actor: escapeHTML(actorName),
    current: state.current,
    permanent: state.permanent
  });
  content += localize("Chat.Mor.DamageRoll", "Roll ({dice}d6), ones: <b>{ones}</b>.<br>", { dice: diceCount, ones });
  if (ones > 0) {
    content += localize("Chat.Mor.StrengthDamage", '<span class="fblec-chat-danger">Strength damage: {damage}.</span>', { damage: ones });
    const damageText = describeAttributeDamage(appliedDamage);
    if (damageText) content += localize("Chat.Mor.AutomaticDamage", "<br><em>Applied automatically: {damage}.</em>", { damage: escapeHTML(damageText) });
  } else {
    content += localize("Chat.Mor.NoDamage", "No Strength damage.");
  }
  return content;
}

export function buildMorRemoveMessage(actorName, rollTotal, state, becamePermanent) {
  let content = localize("Chat.Mor.RemoveIntro", "<b>{actor}</b> removes 1 current Mor point.<br>Permanence roll (1d6): <b>{total}</b>.<br>", {
    actor: escapeHTML(actorName),
    total: rollTotal
  });

  content += becamePermanent
    ? localize("Chat.Mor.BecamePermanent", "<span class=\"fblec-chat-danger\">Rolled 1. The point becomes permanent. Mor: {current}/{permanent}.</span>", state)
    : localize("Chat.Mor.Removed", "The point is removed. Mor: {current}/{permanent}.", state);
  return content;
}
