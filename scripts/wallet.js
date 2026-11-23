import {
  CURRENCIES,
  CURRENCY_BY_KEY,
  ITEM_TOOLTIP_DELAY_MS,
  WALLET_EXPANDED_STORAGE_PREFIX
} from "./constants.js";
import {
  currencyError,
  getCurrencyAbbreviation,
  getCurrencyValue,
  getWalletCopperTotal,
  parseCurrencyExpression,
  readCurrencyBalances,
  writeCurrencyUpdate
} from "./currency.js";
import { qaLocalize } from "./i18n.js";
import { buildActorCurrencyUpdate } from "./actor-data.js";
import { enqueueCurrencyOperation } from "./operation-queue.js";
import { executeAsActiveGM, getActiveGM, hasSocketHandler, registerSocketHandler } from "./integration/socket-api.js";
import { canModifyActor } from "./permissions.js";
import { localizeOrFallback, rerenderSheet } from "./utils.js";
import { openMoneyTransferDialog } from "./money-transfer.js";

const OPEN_WALLET_ACTORS = new Set();
const ACTIVE_WALLET_SUMMARIES = new Set();
const WALLET_OPERATION = "wallet.apply-change";
const MAX_WALLET_COPPER = BigInt(Number.MAX_SAFE_INTEGER);
const ASCENDING_CURRENCIES = [...CURRENCIES].sort((a, b) => a.unit - b.unit);

export function initializeWalletOperations() {
  if (hasSocketHandler(WALLET_OPERATION)) return;
  registerSocketHandler(WALLET_OPERATION, async (payload, context) => {
    return enqueueCurrencyOperation(async () => {
      const actor = payload?.actorUuid ? await fromUuid(payload.actorUuid) : game.actors?.get?.(payload?.actorId);
      if (getActiveGM()?.id !== game.user?.id) throw currencyError("no-active-gm", "The active GM changed");
      const requester = context.requestUser;
      return applyWalletChange(actor, payload, Boolean(requester?.active &&
        (requester.isGM || actor?.testUserPermission?.(requester, "OWNER"))));
    });
  });
}

async function dispatchWalletChange(actor, payload) {
  if (getActiveGM()) {
    initializeWalletOperations();
    return executeAsActiveGM(WALLET_OPERATION, { actorUuid: actor.uuid, actorId: actor.id, ...payload });
  }
  return enqueueCurrencyOperation(() => {
    // An active GM can appear while a local operation waits in the queue.
    // Dispatch outside this queue to avoid waiting for it from its own callback.
    if (getActiveGM()) return null;
    return applyWalletChange(actor, payload, canModifyActor(actor));
  }).then(result => result ?? dispatchWalletChange(actor, payload));
}

export function registerWalletListeners() {
  initializeWalletOperations();
  document.addEventListener("click", closeOpenWallets);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOpenWallets();
  });
}

export function isWalletExpanded(actor) {
  return localStorage.getItem(getExpandedStorageKey(actor)) === "expanded";
}

export function buildWalletControl(app, actor) {
  pruneInactiveWalletSummaries();
  const wallet = document.createElement("div");
  wallet.classList.add("fblqa-wallet");
  wallet.dataset.actorKey = getWalletActorKey(actor);

  if (isWalletMarkedOpen(actor)) wallet.classList.add("is-open");

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("fblqa-wallet-button");
  button.setAttribute("aria-label", qaLocalize("Wallet.Open", "Открыть валюту"));
  button.innerHTML = '<i class="fas fa-wallet"></i>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideWalletSummaryTooltip(wallet);

    const wasOpen = wallet.classList.contains("is-open");
    closeOpenWallets();

    if (!wasOpen) {
      markWalletOpen(actor);
      wallet.classList.add("is-open");
    } else {
      markWalletClosed(actor);
    }
  });

  const popover = document.createElement("div");
  popover.classList.add("fblqa-wallet-popover");
  popover.addEventListener("click", (event) => event.stopPropagation());

  for (const currency of CURRENCIES) {
    popover.append(buildCurrencyRow(actor, currency, "popover"));
  }

  const message = document.createElement("div");
  message.classList.add("fblqa-wallet-message");
  message.setAttribute("aria-live", "polite");
  popover.append(message);
  popover.append(buildWalletFooter(app, actor));

  const summaryTooltip = buildWalletSummaryTooltip(actor);
  installWalletSummaryTooltip(wallet, button, summaryTooltip);

  wallet.append(button, popover, summaryTooltip);
  return wallet;
}

export function buildExpandedWalletLine(app, actor) {
  const line = document.createElement("section");
  line.classList.add("fblqa-expanded-wallet-line");
  line.dataset.actorKey = getWalletActorKey(actor);
  line.setAttribute("aria-label", qaLocalize("Wallet.ExpandedLine", "Развёрнутая валюта"));

  const toggleSlot = document.createElement("span");
  toggleSlot.classList.add("fblqa-expanded-wallet-toggle-slot");
  toggleSlot.title = qaLocalize("Wallet.ReturnToWallet", "Вернуть валюту в кошелёк");
  toggleSlot.append(buildRoundCheckbox({
    checked: true,
    ariaLabel: qaLocalize("Wallet.CollapseToWallet", "Свернуть валюту обратно в кошелёк"),
    onChange: (event) => {
      event.stopPropagation();
      setWalletExpanded(actor, false);
      rerenderSheet(app);
    }
  }));

  const currencies = document.createElement("div");
  currencies.classList.add("fblqa-expanded-wallet-currencies");
  for (const currency of CURRENCIES) {
    currencies.append(buildCurrencyRow(actor, currency, "expanded"));
  }

  const message = document.createElement("div");
  message.classList.add("fblqa-wallet-message", "fblqa-expanded-wallet-message");
  message.setAttribute("aria-live", "polite");

  const transferButton = buildMoneyTransferButton(app, actor, "expanded");

  line.append(toggleSlot, currencies, transferButton, message);
  return line;
}

function getWalletActorKey(actor) {
  return actor?.uuid ?? actor?.id ?? "unknown";
}

function getExpandedStorageKey(actor) {
  return `${WALLET_EXPANDED_STORAGE_PREFIX}.${getWalletActorKey(actor)}`;
}

function setWalletExpanded(actor, expanded) {
  localStorage.setItem(getExpandedStorageKey(actor), expanded ? "expanded" : "popover");
  if (expanded) markWalletClosed(actor);
}

function markWalletOpen(actor) {
  OPEN_WALLET_ACTORS.add(getWalletActorKey(actor));
}

function markWalletClosed(actor) {
  OPEN_WALLET_ACTORS.delete(getWalletActorKey(actor));
}

function isWalletMarkedOpen(actor) {
  return OPEN_WALLET_ACTORS.has(getWalletActorKey(actor));
}

function pruneInactiveWalletSummaries() {
  for (const wallet of [...ACTIVE_WALLET_SUMMARIES]) {
    if (wallet?.isConnected) continue;
    wallet?._fblqaHideSummaryTooltip?.();
    ACTIVE_WALLET_SUMMARIES.delete(wallet);
  }
}

export function cleanupWalletSummaries(root) {
  if (!root?.querySelectorAll) return 0;
  let cleaned = 0;
  for (const wallet of root.querySelectorAll(".fblqa-wallet")) {
    if (!ACTIVE_WALLET_SUMMARIES.has(wallet)) continue;
    wallet._fblqaHideSummaryTooltip?.();
    ACTIVE_WALLET_SUMMARIES.delete(wallet);
    cleaned += 1;
  }
  return cleaned;
}

function closeOpenWallets() {
  if (!OPEN_WALLET_ACTORS.size && !ACTIVE_WALLET_SUMMARIES.size) return;

  if (OPEN_WALLET_ACTORS.size) {
    OPEN_WALLET_ACTORS.clear();
    document.querySelectorAll(".fblqa-wallet.is-open").forEach((wallet) => {
      wallet.classList.remove("is-open");
    });
  }

  for (const wallet of [...ACTIVE_WALLET_SUMMARIES]) {
    wallet._fblqaHideSummaryTooltip?.();
  }
}

function buildCurrencyRow(actor, currency, mode = "popover") {
  const row = document.createElement("div");
  row.classList.add("fblqa-currency-row", `fblqa-currency-row-${mode}`);
  row.dataset.currency = currency.key;

  const canModify = canModifyActor(actor);

  const minus = document.createElement("button");
  minus.type = "button";
  minus.classList.add("fblqa-currency-button", "fblqa-currency-minus");
  minus.textContent = "−";
  minus.title = qaLocalize("Wallet.Decrease", "Уменьшить: {currency}", { currency: localizeOrFallback(currency.label, currency.key) });
  minus.disabled = !canModify;
  minus.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const control = event.currentTarget;
    await runWalletOperation(actor, control, { mode: "delta", key: currency.key, value: -1 });
  });

  const input = document.createElement("input");
  input.classList.add("fblqa-currency-input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 200;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = String(getCurrencyValue(actor, currency.key));
  input.title = qaLocalize("Wallet.InputTitle", "{currency}. Можно писать числа, например 8, выражения 10-2, или относительные операции +5 / -117.", { currency: localizeOrFallback(currency.label, currency.key) });
  input.setAttribute("aria-label", `${getCurrencyAbbreviation(currency)}: ${localizeOrFallback(currency.label, currency.key)}`);
  input.disabled = !canModify;
  input.addEventListener("focus", (event) => {
    event.currentTarget.select();
    clearWalletMessage(event.currentTarget);
  });
  input.addEventListener("change", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const control = event.currentTarget;
    const rawValue = control.value;
    await runWalletOperation(actor, control, { mode: "input", key: currency.key, value: rawValue });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      event.currentTarget.value = String(getCurrencyValue(actor, currency.key));
      event.currentTarget.blur();
    }
  });

  const plus = document.createElement("button");
  plus.type = "button";
  plus.classList.add("fblqa-currency-button", "fblqa-currency-plus");
  plus.textContent = "+";
  plus.title = qaLocalize("Wallet.Increase", "Увеличить: {currency}", { currency: localizeOrFallback(currency.label, currency.key) });
  plus.disabled = !canModify;
  plus.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const control = event.currentTarget;
    await runWalletOperation(actor, control, { mode: "delta", key: currency.key, value: 1 });
  });

  const label = document.createElement("span");
  label.classList.add("fblqa-currency-abbr", `fblqa-currency-abbr-${currency.key}`);
  label.textContent = getCurrencyAbbreviation(currency);
  label.title = localizeOrFallback(currency.label, currency.key);

  row.append(minus, input, plus, label);
  return row;
}

function buildWalletFooter(app, actor) {
  const row = document.createElement("div");
  row.classList.add("fblqa-wallet-expand-row");

  const expandControl = document.createElement("label");
  expandControl.classList.add("fblqa-wallet-expand-control");
  expandControl.title = qaLocalize("Wallet.ExpandTitle", "Показать валюту отдельной линией под быстрым доступом");

  const checkbox = buildRoundCheckbox({
    checked: false,
    ariaLabel: qaLocalize("Wallet.ExpandAria", "Раскрыть валюту отдельной линией"),
    onChange: (event) => {
      const checked = event.currentTarget.checked;
      setWalletExpanded(actor, checked);
      rerenderSheet(app);
    }
  });

  const text = document.createElement("span");
  text.classList.add("fblqa-wallet-expand-text");
  text.textContent = qaLocalize("Wallet.Expand", "Раскрыть");

  expandControl.append(checkbox, text);
  row.append(expandControl, buildMoneyTransferButton(app, actor, "compact"));
  return row;
}

function buildMoneyTransferButton(app, actor, mode) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("fblqa-wallet-transfer-button", `fblqa-wallet-transfer-button-${mode}`);
  button.title = qaLocalize("Wallet.Transfer.ButtonTitle", "Передать деньги другому игроку");
  button.setAttribute("aria-label", qaLocalize("Wallet.Transfer.ButtonTitle", "Передать деньги другому игроку"));
  button.disabled = !canModifyActor(actor);
  button.innerHTML = `<i class="fas fa-exchange-alt" aria-hidden="true"></i><span>${qaLocalize("Wallet.Transfer.Button", "Передать")}</span>`;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await openMoneyTransferDialog(app, actor);
    } finally {
      button.removeAttribute("aria-busy");
      button.disabled = !canModifyActor(actor);
    }
  });
  return button;
}

function buildRoundCheckbox({ checked, ariaLabel, onChange }) {
  const label = document.createElement("label");
  label.classList.add("fblqa-round-checkbox");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.setAttribute("aria-label", ariaLabel);
  input.addEventListener("change", onChange);

  const mark = document.createElement("i");
  mark.classList.add("fas", "fa-check", "fblqa-round-checkbox-mark");
  mark.setAttribute("aria-hidden", "true");

  label.append(input, mark);
  return label;
}

async function applyWalletChange(actor, { key, mode, value } = {}, authorized) {
  if (actor?.documentName !== "Actor" || actor.type !== "character" || actor.pack || !authorized) {
    throw currencyError("no-permission", "Wallet change requires ownership of a character");
  }
  if (!Object.hasOwn(CURRENCY_BY_KEY, key)) throw new TypeError("Unknown currency");

  let input;
  if (mode === "delta" && Number.isSafeInteger(value)) input = { value, relative: true };
  else if (mode === "input" && typeof value === "string" && value.length <= 200) input = parseCurrencyExpression(value);
  if (!input || input.ok === false) {
    throw currencyError("invalid-input", "Invalid wallet expression or delta");
  }

  const before = readCurrencyBalances(actor);
  const balance = Object.fromEntries(CURRENCIES.map(({ key }) => [key, BigInt(before[key])]));
  const requested = BigInt(input.value) + (input.relative ? balance[key] : 0n);
  const total = CURRENCIES.reduce((sum, { key, unit }) => sum + balance[key] * BigInt(unit), 0n);
  const nextTotal = total + (requested - balance[key]) * BigInt(CURRENCY_BY_KEY[key].unit);
  if (nextTotal < 0n) throw currencyError("insufficient-funds", "Insufficient funds");
  if (nextTotal > MAX_WALLET_COPPER) throw new RangeError("Wallet total exceeds the safe integer limit");

  balance[key] = requested;
  if (requested < 0n) {
    balance[key] = 0n;
    spendWithChange(balance, -requested * BigInt(CURRENCY_BY_KEY[key].unit));
  }

  const values = Object.fromEntries(CURRENCIES.map(({ key }) => [key, Number(balance[key])]));
  const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== before[key]));
  if (Object.keys(changed).length) await writeCurrencyUpdate(actor, buildActorCurrencyUpdate(actor, changed));
  return { values };
}

function spendWithChange(balance, remaining) {
  // Exhaust the smallest available coins first and break the last coin if needed.
  for (const { key, unit } of ASCENDING_CURRENCIES) {
    const denomination = BigInt(unit);
    const needed = (remaining + denomination - 1n) / denomination;
    const spent = needed < balance[key] ? needed : balance[key];
    balance[key] -= spent;
    remaining -= spent * denomination;
    if (remaining <= 0n) {
      let change = -remaining;
      for (const smaller of CURRENCIES) {
        if (smaller.unit >= unit) continue;
        const smallerUnit = BigInt(smaller.unit);
        balance[smaller.key] += change / smallerUnit;
        change %= smallerUnit;
      }
      return;
    }
  }
  throw currencyError("insufficient-funds", "Insufficient funds");
}

function getWalletSummaryText(actor) {
  const coinCount = CURRENCIES.reduce((sum, currency) => sum + getCurrencyValue(actor, currency.key), 0);
  const totalCopper = getWalletCopperTotal(actor);
  const coinWeight = Math.floor(coinCount / 100) * 0.5;

  return qaLocalize("Wallet.Summary", "Total: {total} copper · {coins} coins · weight {weight}", {
    total: totalCopper,
    coins: coinCount,
    weight: coinWeight
  });
}

function buildWalletSummaryTooltip(actor) {
  const tooltip = document.createElement("div");
  tooltip.classList.add("fblqa-wallet-summary-tooltip");
  tooltip.setAttribute("role", "tooltip");

  const title = document.createElement("div");
  title.classList.add("fblqa-wallet-summary-tooltip-title");
  title.textContent = qaLocalize("Wallet.Currency", "Валюта");

  const summary = document.createElement("div");
  summary.classList.add("fblqa-wallet-summary-tooltip-text");
  summary.textContent = getWalletSummaryText(actor);

  tooltip.append(title, summary);
  return tooltip;
}

function installWalletSummaryTooltip(wallet, button, tooltip) {
  let timer = null;

  const schedule = () => {
    clearTimeout(timer);
    if (wallet.classList.contains("is-open")) return;
    ACTIVE_WALLET_SUMMARIES.add(wallet);
    timer = window.setTimeout(() => {
      if (!button.isConnected || wallet.classList.contains("is-open")) {
        ACTIVE_WALLET_SUMMARIES.delete(wallet);
        return;
      }
      tooltip.classList.add("is-visible");
    }, ITEM_TOOLTIP_DELAY_MS);
  };

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    tooltip.classList.remove("is-visible");
    ACTIVE_WALLET_SUMMARIES.delete(wallet);
  };

  button.addEventListener("mouseenter", schedule);
  button.addEventListener("mouseleave", hide);
  button.addEventListener("focus", schedule);
  button.addEventListener("blur", hide);

  wallet._fblqaHideSummaryTooltip = hide;
}

function hideWalletSummaryTooltip(wallet) {
  wallet?._fblqaHideSummaryTooltip?.();
}

async function runWalletOperation(actor, sourceElement, payload) {
  const row = sourceElement?.closest?.(".fblqa-currency-row") ?? null;
  if (row?.classList.contains("is-busy")) return;
  setWalletRowBusy(row, true);
  clearWalletMessage(sourceElement);

  try {
    markWalletOpenUnlessExpanded(actor);
    const { values } = await dispatchWalletChange(actor, payload);
    if (sourceElement?.tagName === "INPUT") sourceElement.value = String(values[payload.key]);
  } catch (error) {
    if (error?.code === "insufficient-funds") {
      showWalletMessage(sourceElement, qaLocalize("Wallet.InsufficientFunds", "Недостаточно средств"), true);
    } else if (error?.code === "invalid-input") {
      showWalletMessage(sourceElement, qaLocalize("Wallet.InvalidInput", "Можно использовать только числа, + и -."), true);
    } else if (["timeout", "outcome-unknown"].includes(error?.code)) {
      ui.notifications?.warn?.(qaLocalize("Wallet.UnknownOutcome", "Исход изменения кошелька неизвестен. Перед повтором проверьте баланс вручную."));
    } else {
      console.error("fbl-quick-access | wallet operation failed", error);
      ui.notifications?.error?.(qaLocalize("Wallet.UpdateFailed", "Could not update the wallet."));
    }
    if (sourceElement?.tagName === "INPUT") sourceElement.value = String(getCurrencyValue(actor, payload.key));
  } finally {
    setWalletRowBusy(row, false);
  }
}

function setWalletRowBusy(row, busy) {
  if (!(row instanceof HTMLElement)) return;
  row.classList.toggle("is-busy", busy);
  row.setAttribute("aria-busy", busy ? "true" : "false");
  for (const control of row.querySelectorAll("button, input")) {
    if (busy) {
      control.dataset.fblqaWasDisabled = control.disabled ? "true" : "false";
      control.disabled = true;
    } else {
      const wasDisabled = control.dataset.fblqaWasDisabled === "true";
      delete control.dataset.fblqaWasDisabled;
      control.disabled = wasDisabled;
    }
  }
}

function markWalletOpenUnlessExpanded(actor) {
  if (!isWalletExpanded(actor)) markWalletOpen(actor);
}

function showWalletMessage(input, message, isError = false) {
  const container = input?.closest?.(".fblqa-wallet, .fblqa-expanded-wallet-line");
  const messageElement = container?.querySelector?.(".fblqa-wallet-message");
  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.classList.toggle("is-error", isError);
}

function clearWalletMessage(element) {
  const container = element?.closest?.(".fblqa-wallet, .fblqa-expanded-wallet-line");
  const messageElement = container?.querySelector?.(".fblqa-wallet-message");
  if (!messageElement) return;

  messageElement.textContent = "";
  messageElement.classList.remove("is-error");
}
