import { MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, rerenderSheet } from "./utils.js";

const WP_PATH = "system.bio.willpower.value";
export const WP_TALENTS_FLAG = "willpowerTalents";
const DEFAULT_TALENT_RANK = 1;
const WILLPOWER_LABEL_PATTERN = /(Willpower|Сила\s+воли)/i;

let activePopover = null;
let activeOutsideClickHandler = null;
let activeKeydownHandler = null;

/**
 * Adds two controls to the character header:
 * - clicking the Willpower label opens a small rank-source popover;
 * - the scale button applies the start-of-session Willpower house rule.
 *
 * The user selects the Kin and Professional talent manually. This avoids trying
 * to infer talent categories from localized or custom item data.
 */
export function setupStartWillpowerButton(app, actor, root) {
  if (!actor || !root) return;

  // Foundry may reuse some DOM between renders. Remove stale controls before
  // wrapping the label again, otherwise sheet/tab rerenders can duplicate them.
  for (const existing of root.querySelectorAll(".fblqa-start-wp-button")) existing.remove();
  for (const existing of root.querySelectorAll(".fblqa-wp-label-anchor")) unwrapElement(existing);

  const anchorNode = findWillpowerTextNode(root);
  if (!anchorNode?.parentElement) return;

  const label = wrapWillpowerWord(anchorNode);
  if (!label) return;

  label.title = qaLocalize("Willpower.ConfigureTalents", "Настроить таланты для расчёта Willpower");
  label.setAttribute("role", "button");
  label.setAttribute("tabindex", canModifyActor(actor) ? "0" : "-1");
  label.setAttribute("aria-label", qaLocalize("Willpower.ConfigureTalents", "Настроить таланты для расчёта Willpower"));

  if (canModifyActor(actor)) {
    label.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleWillpowerTalentPopover(app, actor, label);
    });

    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      toggleWillpowerTalentPopover(app, actor, label);
    });
  }

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("fblqa-start-wp-button");
  button.title = qaLocalize("Willpower.ApplyStartRule", "Выровнять Willpower по правилу начала партии");
  button.setAttribute("aria-label", qaLocalize("Willpower.ApplyStartRule", "Выровнять Willpower по правилу начала партии"));
  button.innerHTML = `<i class="fas fa-scale-balanced" aria-hidden="true"></i>`;
  button.disabled = !canModifyActor(actor);

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!canModifyActor(actor)) {
      warnCannotModifyActor();
      return;
    }

    const result = calculateStartWillpower(actor);
    try {
      await actor.update({ [WP_PATH]: result.value });
      ui.notifications?.info?.(
        qaLocalize("Willpower.Result", "Willpower на начало партии: {currentWp} → {value} (EMP {empathyMax}, проф. талант {professionalRank}, талант народа {kinRank}).", result)
      );
      if (result.notes.length) ui.notifications?.warn?.(`WP: ${result.notes.join(" ")}`);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to update session Willpower`, error);
      ui.notifications?.error?.(qaLocalize("Willpower.UpdateFailed", "Не удалось обновить Willpower. Проверь права на лист персонажа."));
    }

    rerenderSheet(app);
  });

  label.insertAdjacentElement("afterend", button);
}

export function calculateStartWillpower(actor) {
  const empathyMax = readNumber(actor.system?.attribute?.empathy?.max, 0);
  const currentWp = readNumber(actor.system?.bio?.willpower?.value, 0);
  const wpMax = readNumber(actor.system?.bio?.willpower?.max, Number.POSITIVE_INFINITY);

  const selected = getSavedWillpowerTalents(actor);
  const professional = readSelectedTalentRank(actor, selected.professionalTalentId, "Professional Talent");
  const kin = readSelectedTalentRank(actor, selected.kinTalentId, "Kin Talent");

  const base = (empathyMax + professional.rank + kin.rank) / 2;
  const raw = (base + currentWp) / 2;
  const rounded = Math.round(raw);
  const value = clamp(rounded, 0, wpMax);

  return {
    value,
    raw,
    base,
    empathyMax,
    currentWp,
    professionalRank: professional.rank,
    kinRank: kin.rank,
    notes: [...professional.notes, ...kin.notes]
  };
}

function toggleWillpowerTalentPopover(app, actor, anchor) {
  if (activePopover?.dataset.actorId === actor.id) {
    closeWillpowerTalentPopover();
    return;
  }

  openWillpowerTalentPopover(app, actor, anchor);
}

function openWillpowerTalentPopover(app, actor, anchor) {
  closeWillpowerTalentPopover();

  const saved = getWillpowerTalents(actor);
  const talents = getActorTalents(actor);
  const popover = document.createElement("div");
  popover.classList.add("fblqa-wp-popover");
  popover.dataset.actorId = actor.id;

  popover.innerHTML = `
    <div class="fblqa-wp-popover-title">${qaLocalize("Willpower.Title", "Willpower")}</div>
    <label class="fblqa-wp-popover-row">
      <span>${qaLocalize("Willpower.KinTalent", "Kin Talent")}</span>
      <select name="kinTalentId">
        ${buildTalentOptions(talents, saved.kinTalentId)}
      </select>
    </label>
    <label class="fblqa-wp-popover-row">
      <span>${qaLocalize("Willpower.ProfessionalTalent", "Professional Talent")}</span>
      <select name="professionalTalentId">
        ${buildTalentOptions(talents, saved.professionalTalentId)}
      </select>
    </label>
    <div class="fblqa-wp-popover-note">${qaLocalize("Willpower.DefaultRankNote", "Если талант не выбран, его ранг считается как {rank}.", { rank: DEFAULT_TALENT_RANK })}</div>
    <div class="fblqa-wp-popover-actions">
      <button type="button" data-action="close">${qaLocalize("Common.Cancel", "Отмена")}</button>
      <button type="button" data-action="save">${qaLocalize("Common.Save", "Сохранить")}</button>
    </div>
  `;

  document.body.appendChild(popover);
  positionPopover(popover, anchor);

  popover.querySelector('[data-action="close"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    closeWillpowerTalentPopover();
  });

  popover.querySelector('[data-action="save"]')?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!canModifyActor(actor)) {
      warnCannotModifyActor();
      return;
    }

    const kinTalentId = String(popover.querySelector('select[name="kinTalentId"]')?.value ?? "");
    const professionalTalentId = String(popover.querySelector('select[name="professionalTalentId"]')?.value ?? "");

    if (kinTalentId && professionalTalentId && kinTalentId === professionalTalentId) {
      ui.notifications?.warn?.(qaLocalize("Willpower.DuplicateTalent", "Для Kin Talent и Professional Talent нужно выбрать разные таланты."));
      return;
    }

    try {
      await saveWillpowerTalents(actor, { kinTalentId, professionalTalentId }, { render: false });
      ui.notifications?.info?.(qaLocalize("Willpower.TalentsSaved", "Таланты для расчёта Willpower сохранены."));
      closeWillpowerTalentPopover();
      rerenderSheet(app);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to save Willpower talent settings`, error);
      ui.notifications?.error?.(qaLocalize("Willpower.SaveFailed", "Не удалось сохранить таланты для Willpower."));
    }
  });

  const outsideHandler = (event) => {
    if (popover.contains(event.target) || anchor.contains(event.target)) return;
    closeWillpowerTalentPopover();
  };
  const keydownHandler = (event) => {
    if (event.key === "Escape") closeWillpowerTalentPopover();
  };

  activePopover = popover;
  activeOutsideClickHandler = outsideHandler;
  activeKeydownHandler = keydownHandler;

  // Delay registration so the click that opened the popover cannot also close it.
  setTimeout(() => {
    if (activePopover !== popover) return;
    document.addEventListener("mousedown", outsideHandler, true);
    document.addEventListener("keydown", keydownHandler, true);
  }, 0);
}

function closeWillpowerTalentPopover() {
  if (activeOutsideClickHandler) document.removeEventListener("mousedown", activeOutsideClickHandler, true);
  if (activeKeydownHandler) document.removeEventListener("keydown", activeKeydownHandler, true);
  activeOutsideClickHandler = null;
  activeKeydownHandler = null;
  activePopover?.remove();
  activePopover = null;
}

function buildTalentOptions(talents, selectedId) {
  const options = [`<option value="">${qaLocalize("Willpower.NotSelectedRank", "Не выбрано (ранг {rank})", { rank: DEFAULT_TALENT_RANK })}</option>`];
  for (const talent of talents) {
    const id = String(talent.id ?? talent._id ?? "");
    const selected = id && id === selectedId ? " selected" : "";
    const rank = readTalentRank(talent);
    const name = escapeHtml(talent.name ?? qaLocalize("Common.Untitled", "Без названия"));
    options.push(`<option value="${escapeHtml(id)}"${selected}>${qaLocalize("Willpower.OptionRank", "{name} — ранг {rank}", { name, rank })}</option>`);
  }
  return options.join("");
}

export function getWillpowerTalents(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, WP_TALENTS_FLAG) ?? {};
  return normalizeWillpowerTalents(raw);
}

export async function saveWillpowerTalents(actor, value, { render = false } = {}) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return false;
  }

  const normalized = normalizeWillpowerTalents(value);
  if (normalized.kinTalentId && normalized.professionalTalentId
    && normalized.kinTalentId === normalized.professionalTalentId) {
    throw new TypeError("Kin Talent and Professional Talent must be different items.");
  }

  await actor.update({
    [`flags.${MODULE_ID}.${WP_TALENTS_FLAG}`]: {
      kinTalentId: normalized.kinTalentId || null,
      professionalTalentId: normalized.professionalTalentId || null
    }
  }, { render });
  return true;
}

function normalizeWillpowerTalents(value) {
  const raw = value ?? {};
  return {
    kinTalentId: raw.kinTalentId ? String(raw.kinTalentId).trim() : "",
    professionalTalentId: raw.professionalTalentId ? String(raw.professionalTalentId).trim() : ""
  };
}

function getActorTalents(actor) {
  return [...(actor.items ?? [])]
    .filter((item) => String(item.type ?? "").toLowerCase() === "talent")
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n?.lang ?? undefined));
}

function readSelectedTalentRank(actor, itemId, label) {
  if (!itemId) return { rank: DEFAULT_TALENT_RANK, notes: [] };

  const item = actor.items?.get?.(itemId) ?? [...(actor.items ?? [])].find((candidate) => String(candidate.id ?? candidate._id) === String(itemId));
  if (!item) {
    return {
      rank: DEFAULT_TALENT_RANK,
      notes: [qaLocalize("Willpower.MissingTalentNote", "{label} не найден; ранг принят за {rank}.", { label, rank: DEFAULT_TALENT_RANK })]
    };
  }

  return { rank: readTalentRank(item, DEFAULT_TALENT_RANK), notes: [] };
}

function readTalentRank(item, fallback = DEFAULT_TALENT_RANK) {
  return readNumber(item.system?.rank?.value ?? item.system?.rank, fallback);
}

function readNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positionPopover(popover, anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 6;

  let left = rect.left;
  let top = rect.bottom + margin;

  const width = popover.offsetWidth || 280;
  const height = popover.offsetHeight || 160;
  left = clamp(left, margin, window.innerWidth - width - margin);

  if (top + height > window.innerHeight - margin) {
    top = rect.top - height - margin;
  }
  top = clamp(top, margin, window.innerHeight - height - margin);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function wrapWillpowerWord(textNode) {
  const text = String(textNode.textContent ?? "");
  const match = text.match(WILLPOWER_LABEL_PATTERN);
  if (!match) return null;

  const before = text.slice(0, match.index);
  const word = text.slice(match.index, match.index + match[0].length);
  const after = text.slice(match.index + match[0].length);

  const fragment = document.createDocumentFragment();
  if (before) fragment.append(document.createTextNode(before));

  const span = document.createElement("span");
  span.classList.add("fblqa-wp-label-anchor");
  span.textContent = word;
  fragment.append(span);

  if (after) fragment.append(document.createTextNode(after));
  textNode.replaceWith(fragment);
  return span;
}

function unwrapElement(element) {
  element.replaceWith(document.createTextNode(element.textContent ?? ""));
}

function findWillpowerTextNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = String(node.textContent ?? "");
      if (WILLPOWER_LABEL_PATTERN.test(text)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    if (isSafeWillpowerAnchor(node)) return node;
    node = walker.nextNode();
  }

  return null;
}

function isSafeWillpowerAnchor(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest(".tab, .sheet-body, .fblqa-panel, .fblqa-wp-popover")) return false;
  if (parent.closest("button, a, input, select, textarea")) return false;
  return true;
}
