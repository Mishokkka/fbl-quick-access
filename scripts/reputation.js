import { FLAG_REPUTATION_ENTRIES, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { actorKey, escapeHtml, makeEntryId } from "./utils.js";
import { createFoundryDialog, extractDialogElement, findDialogForm, hasFoundryDialogApi } from "./dialogs.js";
import { findNoteTab } from "./sheet-adapter/forbidden-lands-v1.js";
import { renderModuleTemplate } from "./template-renderer.js";

const REPUTATION_PATH = "system.bio.reputation.value";
const REPUTATION_DIALOG_TEMPLATE = `modules/${MODULE_ID}/templates/reputation/reputation-dialog.hbs`;
const REPUTATION_NOTE_TEMPLATE = `modules/${MODULE_ID}/templates/reputation/note-summary.hbs`;
const NOTE_RENDERS = new WeakMap();
const OPEN_DIALOGS = new Map();
const SAVE_CHAINS = new Map();
const REPUTATION_RESIZE_FRAMES = new WeakMap();
export const MAX_REPUTATION_POINTS = 1000;

/** Normalize display data while preserving finite over-limit legacy amounts.
 * Save and roll entry points enforce the pool cap before writing/allocating.
 */
export function normalizeReputationEntries(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      const rawAmount = Number(entry?.amount ?? entry?.value ?? entry?.quantity ?? 0);
      const amount = Number.isFinite(rawAmount)
        ? Math.max(0, Math.floor(rawAmount)) : 0;
      if (amount < 1) return null;

      return {
        id: normalizeEntryId(entry?.id),
        amount,
        description: String(entry?.description ?? entry?.reason ?? "").trim(),
        location: String(entry?.location ?? entry?.place ?? "").trim()
      };
    })
    .filter(Boolean);
}

export function getReputationTotal(entries) {
  return normalizeReputationEntries(entries).reduce((total, entry) => total + entry.amount, 0);
}

export function getNativeReputationValue(actor) {
  const value = Number(actor?.system?.bio?.reputation?.value);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function getReputationEntries(actor) {
  const stored = actor?.getFlag?.(MODULE_ID, FLAG_REPUTATION_ENTRIES);
  const normalized = normalizeReputationEntries(stored);
  if (Array.isArray(stored)) return normalized;

  const legacyTotal = getNativeReputationValue(actor);
  if (legacyTotal < 1) return [];

  return [{
    id: "legacy-reputation",
    amount: legacyTotal,
    description: "",
    location: ""
  }];
}

export function selectRandomReputation(entries, divisor, random = Math.random) {
  const normalized = normalizeReputationEntries(entries);
  const total = getReputationTotal(normalized);
  if (total > MAX_REPUTATION_POINTS) throw new RangeError(`Reputation pool exceeds ${MAX_REPUTATION_POINTS} points`);
  const safeDivisor = Math.max(1, Math.floor(Number(divisor) || 1));
  const target = total > 0 ? Math.floor(total / safeDivisor) : 0;

  const units = [];
  normalized.forEach((entry, entryIndex) => {
    for (let point = 0; point < entry.amount; point += 1) units.push(entryIndex);
  });

  for (let index = units.length - 1; index > 0; index -= 1) {
    const roll = Number(random());
    const bounded = Number.isFinite(roll) ? Math.min(0.999999999, Math.max(0, roll)) : 0;
    const swapIndex = Math.floor(bounded * (index + 1));
    [units[index], units[swapIndex]] = [units[swapIndex], units[index]];
  }

  const counts = new Map();
  for (const entryIndex of units.slice(0, target)) {
    counts.set(entryIndex, (counts.get(entryIndex) ?? 0) + 1);
  }

  return normalized
    .map((entry, entryIndex) => ({ entry, amount: counts.get(entryIndex) ?? 0 }))
    .filter((selection) => selection.amount > 0);
}

export async function saveReputationEntries(actor, entries, { render = false } = {}) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor();
    return false;
  }
  if (!Array.isArray(entries)) {
    throw new TypeError("Reputation entries must be an array.");
  }

  const normalized = normalizeReputationEntries(entries);
  const total = getReputationTotal(normalized);
  if (total > MAX_REPUTATION_POINTS || entries.some(entry => {
    const amount = Number(entry?.amount ?? entry?.value ?? entry?.quantity ?? 0);
    return !Number.isFinite(amount) || !Number.isSafeInteger(Math.floor(amount)) || amount > MAX_REPUTATION_POINTS;
  })) throw new RangeError(`Reputation must contain finite amounts totaling at most ${MAX_REPUTATION_POINTS} points`);
  await actor.update({
    [`flags.${MODULE_ID}.${FLAG_REPUTATION_ENTRIES}`]: normalized,
    [REPUTATION_PATH]: total
  }, { render });
  return true;
}

export function setupReputationManager(app, actor, root) {
  void setupReputationNoteSummary(actor, root);

  const input = root?.querySelector?.(`input[name="${REPUTATION_PATH}"]`);
  if (!(input instanceof HTMLElement)) return;

  const entries = getReputationEntries(actor);
  input.value = String(getReputationTotal(entries));
  input.readOnly = true;
  input.classList.add("fblqa-reputation-trigger", "fblqa-reputation-value");
  input.title = qaLocalize("Reputation.OpenTitle", "Открыть журнал репутации");
  input.setAttribute("aria-haspopup", "dialog");

  bindReputationTrigger(input, app, actor);

  const labelCell = input.closest("td")?.previousElementSibling;
  const nativeRoll = labelCell?.querySelector?.(".roll-reputation");
  if (nativeRoll instanceof HTMLElement) {
    nativeRoll.classList.add("fblqa-reputation-trigger");
    nativeRoll.title = qaLocalize("Reputation.OpenTitle", "Открыть журнал репутации");
    nativeRoll.setAttribute("aria-haspopup", "dialog");
    bindReputationTrigger(nativeRoll, app, actor);
  } else if (labelCell instanceof HTMLElement) {
    labelCell.classList.add("fblqa-reputation-label-cell");
    labelCell.title = qaLocalize("Reputation.OpenTitle", "Открыть журнал репутации");
    labelCell.setAttribute("role", "button");
    labelCell.setAttribute("tabindex", "0");
    labelCell.setAttribute("aria-haspopup", "dialog");
    bindReputationTrigger(labelCell, app, actor);
  }
}

export async function setupReputationNoteSummary(actor, root) {
  const noteTab = findNoteTab(root);
  if (!(noteTab instanceof HTMLElement)) return null;

  const token = {};
  NOTE_RENDERS.set(noteTab, token);
  try {
    const entries = getReputationEntries(actor);
    const heading = qaLocalize("Reputation.NoteHeading", "Репутация");
    const html = await renderModuleTemplate(REPUTATION_NOTE_TEMPLATE, {
      heading,
      total: getReputationTotal(entries),
      rows: entries.map(entry => ({
        amount: entry.amount,
        description: entry.description || qaLocalize("Reputation.NoDescription", "Причина не указана"),
        location: entry.location
      })),
      empty: qaLocalize("Reputation.NoteEmpty", "Репутация пока не записана.")
    });
    if (NOTE_RENDERS.get(noteTab) !== token || !noteTab.isConnected || findNoteTab(root) !== noteTab) return null;

    const section = document.createElement("section");
    section.className = "fblqa-reputation-note-summary";
    section.setAttribute("aria-label", heading);
    section.innerHTML = html;
    noteTab.querySelector(".fblqa-reputation-note-summary")?.remove();
    noteTab.append(section);
    return section;
  } catch (error) {
    console.error(`${MODULE_ID} | reputation summary render failed`, error);
    return null;
  } finally {
    if (NOTE_RENDERS.get(noteTab) === token) NOTE_RENDERS.delete(noteTab);
  }
}

export function closeReputationDialog(actorOrId) {
  const key = typeof actorOrId === "string" ? actorOrId : actorKey(actorOrId);
  const dialog = OPEN_DIALOGS.get(key);
  if (!dialog) return false;
  OPEN_DIALOGS.delete(key);
  try {
    void dialog.close?.();
  } catch (_error) {
    // Ignore close errors for already-detached dialogs.
  }
  return true;
}

export function openReputationDialog(app, actor) {
  if (!actor || !hasFoundryDialogApi()) return null;

  const key = actorKey(actor);
  const existing = OPEN_DIALOGS.get(key);
  if (existing) {
    existing.bringToFront?.();
    existing.bringToTop?.();
    return existing;
  }

  const editable = canModifyActor(actor);
  const usesDialogV2 = Boolean(globalThis.foundry?.applications?.api?.DialogV2);
  // The public opener returns the dialog immediately. Replace its marker once the template loads.
  const placeholder = '<div data-fblqa-reputation-content></div>';
  const content = usesDialogV2
    ? placeholder
    : `<form class="fblqa-reputation-form" autocomplete="off">${placeholder}</form>`;
  let saveTimeout = null;
  let dialogRoot = null;
  let revision = 0;
  let dirty = false;
  let lastSerialized = JSON.stringify(getReputationEntries(actor));

  const queueSave = (rowsRoot, status) => {
    if (!editable || !rowsRoot) return Promise.resolve(false);
    const localRevision = revision;
    const entries = collectRows(rowsRoot).map(({ entry }) => entry);
    const serialized = JSON.stringify(entries);
    if (!dirty && serialized === lastSerialized) return Promise.resolve(true);
    setStatus(status, qaLocalize("Reputation.Saving", "Сохранение…"), "is-saving");

    const chain = (SAVE_CHAINS.get(key) ?? Promise.resolve())
      .then(async () => {
        const saved = await saveReputationEntries(actor, entries, { render: false });
        if (saved) {
          lastSerialized = serialized;
          if (localRevision === revision) dirty = false;
          updateSheetReputationPresentation(app, actor, entries);
        }
        return saved;
      })
      .then((saved) => {
        if (localRevision === revision && saved) {
          setStatus(status, qaLocalize("Reputation.Saved", "Сохранено"), "is-saved");
        }
        return saved;
      })
      .catch((error) => {
        console.error(`${MODULE_ID} | reputation save failed`, error);
        if (localRevision !== revision) return false;
        setStatus(status, error instanceof RangeError
          ? qaLocalize("Reputation.OverLimitPreserved", "The reputation limit is {max}. Existing values are preserved; correct the amounts before saving or rolling.", { max: MAX_REPUTATION_POINTS })
          : qaLocalize("Reputation.SaveFailed", "Не удалось сохранить репутацию."), "is-error");
        return false;
      })
      .finally(() => {
        if (SAVE_CHAINS.get(key) === chain) SAVE_CHAINS.delete(key);
      });

    SAVE_CHAINS.set(key, chain);
    return chain;
  };

  const dialog = createFoundryDialog({
    title: qaLocalize("Reputation.Title", "Репутация: {name}", { name: actor.name ?? "" }),
    content,
    buttons: {},
    render: async (html, renderedDialog) => {
      const root = extractDialogElement(html);
      const marker = root?.querySelector("[data-fblqa-reputation-content]");
      if (!marker || OPEN_DIALOGS.get(key) !== dialog) return;
      try {
        const contentHtml = await renderModuleTemplate(REPUTATION_DIALOG_TEMPLATE, reputationTemplateData(actor));
        if (!marker.isConnected || OPEN_DIALOGS.get(key) !== dialog) return;
        const html = usesDialogV2 ? (globalThis.foundry?.utils?.cleanHTML?.(contentHtml) ?? contentHtml) : contentHtml;
        marker.insertAdjacentHTML("beforebegin", html);
        marker.remove();
      } catch (error) {
        console.error(`${MODULE_ID} | reputation dialog render failed`, error);
        if (OPEN_DIALOGS.get(key) === dialog) closeReputationDialog(key);
        return;
      }
      dialogRoot = root;
      const form = findDialogForm(renderedDialog ?? html, "form");
      form?.classList.add("fblqa-reputation-form");
      form?.classList.toggle("is-readonly", !editable);
      dialogRoot.closest?.(".app, .application")?.classList.add("fblqa-reputation-dialog");
      const resize = () => scheduleReputationDialogAutoSize(dialog, dialogRoot);
      setupDialogInteractions({
        app,
        actor,
        root: dialogRoot,
        editable,
        scheduleSave: (rowsRoot, status) => {
          if (!editable || !rowsRoot) return;
          const serialized = JSON.stringify(collectRows(rowsRoot).map(({ entry }) => entry));
          if (serialized === lastSerialized && !dirty) return;
          revision += 1;
          dirty = true;
          if (saveTimeout) globalThis.clearTimeout?.(saveTimeout);
          setStatus(status, qaLocalize("Reputation.Unsaved", "Есть несохранённые изменения"), "is-dirty");
          saveTimeout = globalThis.setTimeout?.(() => {
            saveTimeout = null;
            void queueSave(rowsRoot, status);
          }, 400);
        },
        saveNow: async (rowsRoot, status) => {
          if (saveTimeout) {
            globalThis.clearTimeout?.(saveTimeout);
            saveTimeout = null;
          }
          if (!dirty) return true;
          return queueSave(rowsRoot, status);
        },
        resize
      });
      resize();
    },
    close: () => {
      if (saveTimeout) {
        globalThis.clearTimeout?.(saveTimeout);
        saveTimeout = null;
      }
      const rowsRoot = dialogRoot?.querySelector?.(".fblqa-reputation-rows");
      const status = dialogRoot?.querySelector?.("[data-role='save-status']");
      if (editable && rowsRoot && dirty) void queueSave(rowsRoot, status);
      if (OPEN_DIALOGS.get(key) === dialog) OPEN_DIALOGS.delete(key);
    }
  }, {
    classes: ["fblqa-reputation-dialog"],
    width: 780,
    height: "auto",
    resizable: false,
    buttonless: true
  });

  OPEN_DIALOGS.set(key, dialog);
  dialog.render(true);
  return dialog;
}

function bindReputationTrigger(element, app, actor) {
  if (element.dataset.fblqaReputationBound === "true") return;
  element.dataset.fblqaReputationBound = "true";

  const open = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    openReputationDialog(app, actor);
  };

  element.addEventListener("click", open, true);
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    open(event);
  }, true);
}

function reputationTemplateData(actor) {
  const total = getReputationTotal(getReputationEntries(actor));
  return {
    total,
    overLimit: total > MAX_REPUTATION_POINTS,
    labels: {
      heading: qaLocalize("Reputation.LedgerHeading", "Журнал репутации"),
      hint: qaLocalize("Reputation.LedgerHint", "Каждая единица репутации бросает один d6. Результат 6 означает, что эту репутацию узнали."),
      total: qaLocalize("Reputation.Total", "Всего репутации"),
      limit: qaLocalize("Reputation.OverLimitPreserved", "The reputation limit is {max}. Existing values are preserved; correct the amounts before saving or rolling.", { max: MAX_REPUTATION_POINTS }),
      use: qaLocalize("Reputation.Use", "Бросать"),
      amount: qaLocalize("Reputation.Amount", "Количество"),
      description: qaLocalize("Reputation.Description", "Почему получена"),
      location: qaLocalize("Reputation.Location", "Где получена"),
      selected: qaLocalize("Reputation.SelectedOf", "из {total} единиц выбрано для проверки", { total }),
      halfHint: qaLocalize("Reputation.HalfHint", "Случайно выбрать половину всех единиц репутации и сразу проверить их."),
      half: qaLocalize("Reputation.Half", "Половина"),
      thirdHint: qaLocalize("Reputation.ThirdHint", "Случайно выбрать треть всех единиц репутации и сразу проверить их."),
      third: qaLocalize("Reputation.Third", "Треть"),
      roll: qaLocalize("Reputation.Roll", "Бросок репутации")
    }
  };
}

function setupDialogInteractions({ app, actor, root, editable, scheduleSave, saveNow, resize }) {
  const rowsRoot = root.querySelector(".fblqa-reputation-rows");
  const status = root.querySelector("[data-role='save-status']");
  if (!rowsRoot) return;

  for (const entry of getReputationEntries(actor)) rowsRoot.append(buildRow(entry, editable, true));
  if (editable) rowsRoot.append(buildRow(null, editable, false));
  refreshDialogSummary(root);

  let rolling = false;
  const runRollAction = async (handler) => {
    if (rolling) return;
    rolling = true;
    try {
      await handler();
    } finally {
      rolling = false;
    }
  };

  rowsRoot.addEventListener("input", (event) => {
    const row = event.target?.closest?.(".fblqa-reputation-row");
    if (!row) return;
    updateRowValidity(row);
    const structureChanged = editable ? ensureTrailingBlankRow(rowsRoot, editable) : false;
    const field = event.target?.dataset?.field ?? "";
    if (field === "amount" || field === "selected") refreshDialogSummary(root);
    if (structureChanged) resize?.();
    if (field === "selected") return;
    scheduleSave(rowsRoot, status);
  });

  rowsRoot.addEventListener("change", (event) => {
    const row = event.target?.closest?.(".fblqa-reputation-row");
    if (row) updateRowValidity(row);
    const field = event.target?.dataset?.field ?? "";
    if (field === "amount" || field === "selected") refreshDialogSummary(root);
    if (field === "selected") return;
    scheduleSave(rowsRoot, status);
  });

  rowsRoot.addEventListener("click", (event) => {
    const removeButton = event.target?.closest?.("[data-action='remove-row']");
    if (!removeButton) return;
    event.preventDefault();
    if (!editable) return;
    removeButton.closest(".fblqa-reputation-row")?.remove();
    ensureTrailingBlankRow(rowsRoot, editable);
    refreshDialogSummary(root);
    resize?.();
    scheduleSave(rowsRoot, status);
  });

  root.querySelector("[data-action='roll-selected']")?.addEventListener("click", () => runRollAction(async () => {
    const states = collectRows(rowsRoot);
    const selections = states
      .filter((state) => state.selected)
      .map((state) => ({ entry: state.entry, amount: state.entry.amount }));
    if (!(await saveNow(rowsRoot, status))) return;
    await rollReputation(actor, states.map((state) => state.entry), selections);
  }));

  root.querySelector("[data-action='roll-half']")?.addEventListener("click", () => runRollAction(async () => {
    const entries = collectRows(rowsRoot).map((state) => state.entry);
    if (!(await saveNow(rowsRoot, status))) return;
    await rollRandomReputation(actor, entries, 2);
  }));

  root.querySelector("[data-action='roll-third']")?.addEventListener("click", () => runRollAction(async () => {
    const entries = collectRows(rowsRoot).map((state) => state.entry);
    if (!(await saveNow(rowsRoot, status))) return;
    await rollRandomReputation(actor, entries, 3);
  }));

  if (!editable) {
    for (const control of root.querySelectorAll("input:not([data-field='selected']), button[data-action='remove-row']")) {
      control.disabled = true;
    }
  }
}

function buildRow(entry, editable, selected) {
  const row = document.createElement("div");
  row.classList.add("fblqa-reputation-row");
  row.dataset.entryId = entry?.id ?? "";

  const checkboxWrap = document.createElement("label");
  checkboxWrap.classList.add("fblqa-reputation-check");
  checkboxWrap.title = qaLocalize("Reputation.UseHint", "Включить эту строку в обычную проверку репутации");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.field = "selected";
  checkbox.checked = Boolean(selected && entry);
  checkbox.disabled = !entry;

  const marker = document.createElement("span");
  marker.setAttribute("aria-hidden", "true");
  checkboxWrap.append(checkbox, marker);

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "1";
  amount.step = "1";
  amount.inputMode = "numeric";
  amount.dataset.field = "amount";
  amount.value = entry ? String(entry.amount) : "";
  amount.placeholder = "0";
  amount.setAttribute("aria-label", qaLocalize("Reputation.Amount", "Количество"));

  const description = document.createElement("input");
  description.type = "text";
  description.dataset.field = "description";
  description.value = entry?.description ?? "";
  description.placeholder = qaLocalize("Reputation.DescriptionPlaceholder", "Например: известный охотник на чудовищ");
  description.setAttribute("aria-label", qaLocalize("Reputation.Description", "Почему получена"));

  const location = document.createElement("input");
  location.type = "text";
  location.dataset.field = "location";
  location.value = entry?.location ?? "";
  location.placeholder = qaLocalize("Reputation.LocationPlaceholder", "Город, регион или государство");
  location.setAttribute("aria-label", qaLocalize("Reputation.Location", "Где получена"));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-row";
  remove.classList.add("fblqa-reputation-remove");
  remove.title = qaLocalize("Reputation.Remove", "Удалить строку");
  remove.setAttribute("aria-label", qaLocalize("Reputation.Remove", "Удалить строку"));
  remove.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
  remove.disabled = !editable;

  for (const input of [amount, description, location]) input.disabled = !editable;

  row.append(checkboxWrap, amount, description, location, remove);
  updateRowValidity(row);
  return row;
}

function updateRowValidity(row) {
  const amountInput = row.querySelector("input[data-field='amount']");
  const checkbox = row.querySelector("input[data-field='selected']");
  const amount = Math.floor(Number(amountInput?.value) || 0);
  const valid = amount > 0;

  row.classList.toggle("is-valid", valid);
  row.classList.toggle("is-empty", isRowBlank(row));
  row.classList.toggle("is-invalid", !valid && !isRowBlank(row));

  if (checkbox) {
    const wasDisabled = checkbox.disabled;
    checkbox.disabled = !valid;
    if (valid && wasDisabled) checkbox.checked = true;
    if (!valid) checkbox.checked = false;
  }
}

function ensureTrailingBlankRow(rowsRoot, editable) {
  let changed = false;
  let trailing = rowsRoot.lastElementChild;
  if (!(trailing instanceof HTMLElement) || !trailing.classList.contains("fblqa-reputation-row") || !isRowBlank(trailing)) {
    rowsRoot.append(buildRow(null, editable, false));
    trailing = rowsRoot.lastElementChild;
    changed = true;
  }

  // Keep exactly one blank row at the end without rescanning the whole table.
  let previous = trailing?.previousElementSibling ?? null;
  while (previous instanceof HTMLElement && previous.classList.contains("fblqa-reputation-row") && isRowBlank(previous)) {
    const before = previous.previousElementSibling;
    previous.remove();
    previous = before;
    changed = true;
  }
  return changed;
}

function isRowBlank(row) {
  const amount = row.querySelector("input[data-field='amount']")?.value ?? "";
  const description = row.querySelector("input[data-field='description']")?.value ?? "";
  const location = row.querySelector("input[data-field='location']")?.value ?? "";
  return !String(amount).trim() && !String(description).trim() && !String(location).trim();
}

function collectRows(rowsRoot) {
  const states = [];
  for (const row of rowsRoot.querySelectorAll(".fblqa-reputation-row")) {
    const amount = Math.max(0, Math.floor(Number(row.querySelector("input[data-field='amount']")?.value) || 0));
    if (amount < 1) continue;

    const id = normalizeEntryId(row.dataset.entryId);
    row.dataset.entryId = id;
    states.push({
      entry: {
        id,
        amount,
        description: String(row.querySelector("input[data-field='description']")?.value ?? "").trim(),
        location: String(row.querySelector("input[data-field='location']")?.value ?? "").trim()
      },
      selected: Boolean(row.querySelector("input[data-field='selected']")?.checked)
    });
  }
  return states;
}

function refreshDialogSummary(root) {
  const rowsRoot = root.querySelector(".fblqa-reputation-rows");
  if (!rowsRoot) return;

  const states = collectRows(rowsRoot);
  const total = states.reduce((sum, state) => sum + state.entry.amount, 0);
  const selected = states.reduce((sum, state) => sum + (state.selected ? state.entry.amount : 0), 0);

  const totalElement = root.querySelector("[data-role='total']");
  const selectedElement = root.querySelector("[data-role='selected']");
  const summary = root.querySelector(".fblqa-reputation-selection-summary span");
  if (totalElement) totalElement.textContent = String(total);
  if (selectedElement) selectedElement.textContent = String(selected);
  if (summary) summary.textContent = qaLocalize("Reputation.SelectedOf", "из {total} единиц выбрано для проверки", { total });
  const overLimit = total > MAX_REPUTATION_POINTS;
  const limitWarning = root.querySelector("[data-role='limit-warning']");
  if (limitWarning) limitWarning.hidden = !overLimit;

  const rollButton = root.querySelector("[data-action='roll-selected']");
  const halfButton = root.querySelector("[data-action='roll-half']");
  const thirdButton = root.querySelector("[data-action='roll-third']");
  if (rollButton) rollButton.disabled = overLimit || selected < 1;
  if (halfButton) halfButton.disabled = overLimit || Math.floor(total / 2) < 1;
  if (thirdButton) thirdButton.disabled = overLimit || Math.floor(total / 3) < 1;
}

async function rollRandomReputation(actor, entries, divisor) {
  try { return await rollReputation(actor, entries, selectRandomReputation(entries, divisor)); }
  catch (error) {
    console.error(`${MODULE_ID} | reputation selection failed`, error);
    ui.notifications?.warn?.(qaLocalize("Reputation.PoolTooLarge", "Reputation is limited to {max} points.", { max: MAX_REPUTATION_POINTS }));
    return null;
  }
}

async function rollReputation(actor, allEntries, selections) {
  const normalizedAll = normalizeReputationEntries(allEntries);
  const normalizedSelections = (selections ?? [])
    .map((selection) => {
      const entry = normalizeReputationEntries([selection?.entry])[0];
      if (!entry) return null;
      const amount = Math.min(entry.amount, Math.max(0, Math.floor(Number(selection?.amount) || 0)));
      return amount > 0 ? { entry, amount } : null;
    })
    .filter(Boolean);

  const diceCount = normalizedSelections.reduce((sum, selection) => sum + selection.amount, 0);
  if (diceCount > MAX_REPUTATION_POINTS || getReputationTotal(normalizedAll) > MAX_REPUTATION_POINTS) {
    ui.notifications?.warn?.(qaLocalize("Reputation.PoolTooLarge", "Reputation is limited to {max} points.", { max: MAX_REPUTATION_POINTS }));
    return null;
  }
  if (diceCount < 1) {
    ui.notifications?.warn(qaLocalize("Reputation.NothingSelected", "Не выбрано ни одной единицы репутации."));
    return null;
  }

  const totalReputation = getReputationTotal(normalizedAll);
  const partial = diceCount < totalReputation;

  try {
    const roll = await new Roll(`${diceCount}d6cs=6`).evaluate();
    const results = extractRollResults(roll, diceCount);
    const content = buildChatCard(actor, normalizedSelections, results, { partial });
    const createMessage = globalThis.ChatMessage?.create;
    if (typeof createMessage !== "function") throw new Error("ChatMessage.create is unavailable");

    return await createMessage.call(globalThis.ChatMessage, {
      speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }) ?? undefined,
      rolls: [roll],
      content
    });
  } catch (error) {
    console.error(`${MODULE_ID} | reputation roll failed`, error);
    ui.notifications?.error(qaLocalize("Reputation.RollFailed", "Не удалось выполнить проверку репутации."));
    return null;
  }
}

function buildChatCard(actor, selections, results, summary) {
  let cursor = 0;
  const rows = selections.map((selection) => {
    const dice = results.slice(cursor, cursor + selection.amount);
    cursor += selection.amount;
    const known = dice.some((value) => value === 6);
    const description = selection.entry.description || qaLocalize("Reputation.NoDescription", "Причина не указана");
    const outcome = known
      ? qaLocalize("Reputation.Known", "Узнали")
      : qaLocalize("Reputation.Unknown", "Не узнали");

    return `
      <li class="${known ? "is-known" : "is-unknown"}">
        <strong>${escapeHtml(description)}</strong>
        <span aria-hidden="true">—</span>
        <span class="fblqa-reputation-chat-outcome">${escapeHtml(outcome)}</span>
      </li>
    `;
  }).join("");

  const title = summary.partial
    ? qaLocalize("Reputation.PartialCheck", "Частичная проверка репутации")
    : qaLocalize("Reputation.FullCheck", "Проверка репутации");

  return `
    <div class="fblqa-reputation-chat-card">
      <header>
        <h3>${escapeHtml(title)}</h3>
        <span>${escapeHtml(actor?.name ?? "")}</span>
      </header>
      <ul>${rows}</ul>
    </div>
  `;
}

function extractRollResults(roll, expected) {
  const results = [];
  for (const die of roll?.dice ?? []) {
    for (const result of die?.results ?? []) {
      if (result?.active === false) continue;
      const value = Number(result?.result);
      if (Number.isFinite(value)) results.push(value);
    }
  }

  while (results.length < expected) results.push(0);
  return results.slice(0, expected);
}

function updateSheetReputationPresentation(app, actor, entries) {
  const root = extractDialogElement(app?.element);
  if (!root) return;
  const input = root.querySelector?.(`input[name="${REPUTATION_PATH}"]`);
  if (input) input.value = String(getReputationTotal(entries));
  void setupReputationNoteSummary(actor, root);
}

function scheduleReputationDialogAutoSize(dialog, element) {
  const appElement = element?.closest?.(".app, .application");
  if (!appElement?.isConnected) return;

  const resize = () => {
    REPUTATION_RESIZE_FRAMES.delete(appElement);
    if (!appElement.isConnected) return;

    const content = appElement.querySelector?.(".window-content");
    appElement.style.height = "auto";
    if (content) {
      content.style.height = "auto";
      content.style.maxHeight = "none";
      content.style.overflowY = "visible";
    }

    dialog?.setPosition?.({ height: "auto" });

    const viewportHeight = Number(globalThis.innerHeight) || 0;
    if (!viewportHeight) return;
    const rect = appElement.getBoundingClientRect?.();
    if (!rect || rect.bottom <= viewportHeight - 12) return;

    dialog?.setPosition?.({
      top: Math.max(12, viewportHeight - rect.height - 12),
      height: "auto"
    });
  };

  if (typeof globalThis.requestAnimationFrame === "function") {
    const previous = REPUTATION_RESIZE_FRAMES.get(appElement);
    if (previous?.outer) globalThis.cancelAnimationFrame?.(previous.outer);
    if (previous?.inner) globalThis.cancelAnimationFrame?.(previous.inner);

    const state = { outer: 0, inner: 0 };
    state.outer = globalThis.requestAnimationFrame(() => {
      state.outer = 0;
      state.inner = globalThis.requestAnimationFrame(resize);
    });
    REPUTATION_RESIZE_FRAMES.set(appElement, state);
  } else {
    globalThis.setTimeout?.(resize, 0);
  }
}

function setStatus(element, text, className) {
  if (!element) return;
  element.textContent = text ?? "";
  element.classList.remove("is-saving", "is-saved", "is-dirty", "is-error");
  if (className) element.classList.add(className);
}

function normalizeEntryId(value) {
  const id = String(value ?? "").trim();
  return id || makeEntryId("rep");
}
