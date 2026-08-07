import { FLAG_REPUTATION_ENTRIES, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml } from "./utils.js";
import { createFoundryDialog, hasFoundryDialogApi } from "./dialogs.js";

const REPUTATION_PATH = "system.bio.reputation.value";
const OPEN_DIALOGS = new Map();

export function normalizeReputationEntries(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      const amount = Math.max(0, Math.floor(Number(entry?.amount ?? entry?.value ?? entry?.quantity) || 0));
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
    id: makeEntryId(),
    amount: legacyTotal,
    description: "",
    location: ""
  }];
}

export function selectRandomReputation(entries, divisor, random = Math.random) {
  const normalized = normalizeReputationEntries(entries);
  const total = getReputationTotal(normalized);
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

  const normalized = normalizeReputationEntries(entries);
  const total = getReputationTotal(normalized);
  await actor.update({
    [`flags.${MODULE_ID}.${FLAG_REPUTATION_ENTRIES}`]: normalized,
    [REPUTATION_PATH]: total
  }, { render });
  return true;
}

export function setupReputationManager(app, actor, root) {
  setupReputationNoteSummary(actor, root);

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

export function setupReputationNoteSummary(actor, root) {
  const noteTab = root?.querySelector?.('.sheet-body > .tab[data-tab="note"]')
    ?? root?.querySelector?.('.tab.note[data-tab="note"]');
  if (!(noteTab instanceof HTMLElement)) return null;

  noteTab.querySelector?.('.fblqa-reputation-note-summary')?.remove();

  const entries = getReputationEntries(actor);
  const total = getReputationTotal(entries);
  const section = document.createElement('section');
  section.className = 'fblqa-reputation-note-summary';
  section.setAttribute('aria-label', qaLocalize('Reputation.NoteHeading', 'Репутация'));

  const rows = entries.length
    ? entries.map((entry) => {
        const description = entry.description || qaLocalize('Reputation.NoDescription', 'Причина не указана');
        const location = entry.location
          ? `<small>${escapeHtml(entry.location)}</small>`
          : '';
        return `
          <li>
            <strong>${escapeHtml(entry.amount)}</strong>
            <span>${escapeHtml(description)}${location}</span>
          </li>
        `;
      }).join('')
    : `<li class="is-empty">${escapeHtml(qaLocalize('Reputation.NoteEmpty', 'Репутация пока не записана.'))}</li>`;

  section.innerHTML = `
    <header>
      <h3>${escapeHtml(qaLocalize('Reputation.NoteHeading', 'Репутация'))}</h3>
      <strong>${escapeHtml(total)}</strong>
    </header>
    <ul>${rows}</ul>
  `;
  noteTab.append(section);
  return section;
}

export function openReputationDialog(app, actor) {
  if (!actor || !hasFoundryDialogApi()) return null;

  const key = actor.uuid ?? actor.id;
  const existing = OPEN_DIALOGS.get(key);
  if (existing) {
    existing.bringToFront?.();
    existing.bringToTop?.();
    return existing;
  }

  const editable = canModifyActor(actor);
  const content = buildDialogContent(actor, editable);
  let saveTimeout = null;
  let saveChain = Promise.resolve();
  let dialogRoot = null;
  let revision = 0;

  const queueSave = (rowsRoot, status) => {
    if (!editable || !rowsRoot) return Promise.resolve(false);
    const localRevision = ++revision;
    const entries = collectRows(rowsRoot).map(({ entry }) => entry);
    setStatus(status, qaLocalize("Reputation.Saving", "Сохранение…"), "is-saving");

    saveChain = saveChain
      .catch(() => false)
      .then(async () => {
        const saved = await saveReputationEntries(actor, entries, { render: false });
        if (saved) updateSheetReputationPresentation(app, actor, entries);
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
        setStatus(status, qaLocalize("Reputation.SaveFailed", "Не удалось сохранить репутацию."), "is-error");
        return false;
      });

    return saveChain;
  };

  const dialog = createFoundryDialog({
    title: qaLocalize("Reputation.Title", "Репутация: {name}", { name: actor.name ?? "" }),
    content,
    buttons: {
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: qaLocalize("Common.Close", "Закрыть")
      }
    },
    default: "close",
    render: (html) => {
      dialogRoot = extractElement(html);
      if (!dialogRoot) return;
      dialogRoot.closest?.(".app, .application")?.classList.add("fblqa-reputation-dialog");
      const resize = () => scheduleReputationDialogAutoSize(dialog, dialogRoot);
      setupDialogInteractions({
        app,
        actor,
        root: dialogRoot,
        editable,
        scheduleSave: (rowsRoot, status) => {
          if (!editable) return;
          if (saveTimeout) window.clearTimeout(saveTimeout);
          setStatus(status, qaLocalize("Reputation.Unsaved", "Есть несохранённые изменения"), "is-dirty");
          saveTimeout = window.setTimeout(() => {
            saveTimeout = null;
            void queueSave(rowsRoot, status);
          }, 400);
        },
        saveNow: async (rowsRoot, status) => {
          if (saveTimeout) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }
          return queueSave(rowsRoot, status);
        },
        resize
      });
      resize();
    },
    close: () => {
      if (saveTimeout) {
        window.clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      const rowsRoot = dialogRoot?.querySelector?.(".fblqa-reputation-rows");
      const status = dialogRoot?.querySelector?.(".fblqa-reputation-save-status");
      if (editable && rowsRoot) void queueSave(rowsRoot, status);
      OPEN_DIALOGS.delete(key);
    }
  }, {
    classes: ["fblqa-reputation-dialog"],
    width: 780,
    height: "auto",
    resizable: false
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

function buildDialogContent(actor, editable) {
  const entries = getReputationEntries(actor);
  const total = getReputationTotal(entries);

  return `
    <form class="fblqa-reputation-form ${editable ? "" : "is-readonly"}" autocomplete="off">
      <div class="fblqa-reputation-intro">
        <div>
          <strong>${escapeHtml(qaLocalize("Reputation.LedgerHeading", "Журнал репутации"))}</strong>
          <span>${escapeHtml(qaLocalize("Reputation.LedgerHint", "Каждая единица репутации бросает один d6. Результат 6 означает, что эту репутацию узнали."))}</span>
        </div>
        <div class="fblqa-reputation-total-badge" title="${escapeHtml(qaLocalize("Reputation.Total", "Всего репутации"))}">
          <i class="fas fa-star" aria-hidden="true"></i>
          <span data-role="total">${total}</span>
        </div>
      </div>

      <div class="fblqa-reputation-table-head" aria-hidden="true">
        <span>${escapeHtml(qaLocalize("Reputation.Use", "Бросать"))}</span>
        <span>${escapeHtml(qaLocalize("Reputation.Amount", "Количество"))}</span>
        <span>${escapeHtml(qaLocalize("Reputation.Description", "Почему получена"))}</span>
        <span>${escapeHtml(qaLocalize("Reputation.Location", "Где получена"))}</span>
        <span></span>
      </div>

      <div class="fblqa-reputation-rows"></div>

      <div class="fblqa-reputation-footer">
        <div class="fblqa-reputation-selection-summary">
          <strong data-role="selected">${total}</strong>
          <span>${escapeHtml(qaLocalize("Reputation.SelectedOf", "из {total} единиц выбрано для проверки", { total }))}</span>
        </div>
        <span class="fblqa-reputation-save-status" aria-live="polite"></span>
      </div>

      <div class="fblqa-reputation-actions">
        <button type="button" data-action="roll-half" title="${escapeHtml(qaLocalize("Reputation.HalfHint", "Случайно выбрать половину всех единиц репутации и сразу проверить их."))}">
          <i class="fas fa-adjust" aria-hidden="true"></i>
          ${escapeHtml(qaLocalize("Reputation.Half", "Половина"))}
        </button>
        <button type="button" data-action="roll-third" title="${escapeHtml(qaLocalize("Reputation.ThirdHint", "Случайно выбрать треть всех единиц репутации и сразу проверить их."))}">
          <i class="fas fa-chart-pie" aria-hidden="true"></i>
          ${escapeHtml(qaLocalize("Reputation.Third", "Треть"))}
        </button>
        <button type="button" class="fblqa-reputation-roll-button" data-action="roll-selected">
          <i class="fas fa-dice" aria-hidden="true"></i>
          ${escapeHtml(qaLocalize("Reputation.Roll", "Бросок репутации"))}
        </button>
      </div>
    </form>
  `;
}

function setupDialogInteractions({ app, actor, root, editable, scheduleSave, saveNow, resize }) {
  const rowsRoot = root.querySelector(".fblqa-reputation-rows");
  const status = root.querySelector(".fblqa-reputation-save-status");
  if (!rowsRoot) return;

  for (const entry of getReputationEntries(actor)) rowsRoot.append(buildRow(entry, editable, true));
  rowsRoot.append(buildRow(null, editable, false));
  refreshDialogSummary(root);

  rowsRoot.addEventListener("input", (event) => {
    const row = event.target?.closest?.(".fblqa-reputation-row");
    if (!row) return;
    updateRowValidity(row);
    ensureTrailingBlankRow(rowsRoot, editable);
    refreshDialogSummary(root);
    resize?.();
    if (event.target?.matches?.("input[data-field='selected']")) return;
    scheduleSave(rowsRoot, status);
  });

  rowsRoot.addEventListener("change", (event) => {
    const row = event.target?.closest?.(".fblqa-reputation-row");
    if (row) updateRowValidity(row);
    refreshDialogSummary(root);
    resize?.();
    if (event.target?.matches?.("input[data-field='selected']")) return;
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

  root.querySelector("[data-action='roll-selected']")?.addEventListener("click", async () => {
    const states = collectRows(rowsRoot);
    const selections = states
      .filter((state) => state.selected)
      .map((state) => ({ entry: state.entry, amount: state.entry.amount }));
    await saveNow(rowsRoot, status);
    await rollReputation(actor, states.map((state) => state.entry), selections);
  });

  root.querySelector("[data-action='roll-half']")?.addEventListener("click", async () => {
    const entries = collectRows(rowsRoot).map((state) => state.entry);
    await saveNow(rowsRoot, status);
    await rollReputation(actor, entries, selectRandomReputation(entries, 2));
  });

  root.querySelector("[data-action='roll-third']")?.addEventListener("click", async () => {
    const entries = collectRows(rowsRoot).map((state) => state.entry);
    await saveNow(rowsRoot, status);
    await rollReputation(actor, entries, selectRandomReputation(entries, 3));
  });

  if (!editable) {
    for (const control of root.querySelectorAll("input, button[data-action='remove-row']")) control.disabled = true;
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
  const rows = [...rowsRoot.querySelectorAll(".fblqa-reputation-row")];
  const trailing = rows.at(-1);
  if (!trailing || !isRowBlank(trailing)) rowsRoot.append(buildRow(null, editable, false));

  const updated = [...rowsRoot.querySelectorAll(".fblqa-reputation-row")];
  for (let index = updated.length - 2; index >= 0; index -= 1) {
    if (!isRowBlank(updated[index])) break;
    updated[index].remove();
  }
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

  const rollButton = root.querySelector("[data-action='roll-selected']");
  const halfButton = root.querySelector("[data-action='roll-half']");
  const thirdButton = root.querySelector("[data-action='roll-third']");
  if (rollButton) rollButton.disabled = selected < 1;
  if (halfButton) halfButton.disabled = Math.floor(total / 2) < 1;
  if (thirdButton) thirdButton.disabled = Math.floor(total / 3) < 1;
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
  const root = extractElement(app?.element);
  if (!root) return;
  const input = root.querySelector?.(`input[name="${REPUTATION_PATH}"]`);
  if (input) input.value = String(getReputationTotal(entries));
  setupReputationNoteSummary(actor, root);
}

function scheduleReputationDialogAutoSize(dialog, element) {
  const resize = () => {
    const appElement = element?.closest?.(".app, .application");
    if (!appElement?.isConnected) return;

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
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resize));
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
  return id || makeEntryId();
}

function makeEntryId() {
  const randomID = globalThis.foundry?.utils?.randomID;
  if (typeof randomID === "function") return randomID(16);
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractElement(value) {
  if (value instanceof HTMLElement) return value;
  if (value?.[0] instanceof HTMLElement) return value[0];
  if (value?.element instanceof HTMLElement) return value.element;
  return null;
}
