import {
  CURRENCIES,
  CURRENCY_BY_KEY,
  ITEM_TOOLTIP_DELAY_MS,
  WALLET_EXPANDED_STORAGE_PREFIX
} from "./constants.js";
import {
  getCurrencyAbbreviation,
  getCurrencyValue,
  getWalletCopperTotal,
  parseCurrencyExpression
} from "./currency.js";
import { qaLocalize } from "./i18n.js";
import { buildActorCurrencyUpdate, getActorCurrencyPath } from "./actor-data.js";
import { createObjectOperationQueue } from "./operation-queue.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { localizeOrFallback, rerenderSheet } from "./utils.js";
import { openMoneyTransferDialog } from "./money-transfer.js";

const OPEN_WALLET_ACTORS = new Set();
const ACTIVE_WALLET_SUMMARIES = new Set();
const enqueueWalletOperation = createObjectOperationQueue();

export function registerWalletListeners() {
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
    popover.append(buildCurrencyRow(app, actor, currency, "popover"));
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
    currencies.append(buildCurrencyRow(app, actor, currency, "expanded"));
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

function buildCurrencyRow(app, actor, currency, mode = "popover") {
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
    await runWalletOperation(actor, control, () => changeCurrency(app, actor, currency.key, -1, control));
  });

  const input = document.createElement("input");
  input.classList.add("fblqa-currency-input");
  input.type = "text";
  input.inputMode = "numeric";
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
    await runWalletOperation(actor, control, () => applyCurrencyInput(app, actor, currency.key, rawValue, control));
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
    await runWalletOperation(actor, control, () => changeCurrency(app, actor, currency.key, 1, control));
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

async function changeCurrency(app, actor, key, delta, sourceElement = null) {
  const currency = CURRENCY_BY_KEY[key];
  if (!currency) return;

  const current = getCurrencyValue(actor, key);

  if (delta < 0) {
    await spendCurrencyUnits(app, actor, key, Math.abs(delta), sourceElement);
    return;
  }

  await setCurrencyValue(app, actor, key, current + delta);
}

async function setCurrencyValue(app, actor, key, value) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor(qaLocalize("Permissions.NoCurrencyModify", "Нет прав на изменение валюты этого персонажа."));
    return;
  }

  const number = Math.max(0, Math.floor(Number(value) || 0));
  markWalletOpenUnlessExpanded(actor);
  await actor.update({ [getActorCurrencyPath(actor, key)]: number });
  markWalletOpenUnlessExpanded(actor);
}

async function applyCurrencyInput(app, actor, key, rawValue, input) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor(qaLocalize("Permissions.NoCurrencyModify", "Нет прав на изменение валюты этого персонажа."));
    resetCurrencyInput(actor, key, input);
    return;
  }

  const text = String(rawValue ?? "").trim();
  const parsed = parseCurrencyExpression(text);

  if (!parsed.ok) {
    showWalletMessage(input, qaLocalize("Wallet.InvalidInput", "Можно использовать только числа, + и -."));
    resetCurrencyInput(actor, key, input);
    return;
  }

  const currency = CURRENCY_BY_KEY[key];
  if (!currency) return;

  const currentTotal = getWalletCopperTotal(actor);
  const currentCurrencyValue = getCurrencyValue(actor, key);

  // Relative entries preserve the selected denomination when possible.
  // Example: 11 ММ with -1 becomes 10 ММ, not 1 СМ.
  if (parsed.relative) {
    if (parsed.value < 0) {
      await spendCurrencyUnits(app, actor, key, Math.abs(parsed.value), input);
      return;
    }

    await setCurrencyValue(app, actor, key, currentCurrencyValue + parsed.value);
    return;
  }

  // Expressions like 4-5 mean “spend 5 units from the whole wallet”, not “set this field to -1”.
  const delta = (parsed.value - currentCurrencyValue) * currency.unit;
  const nextTotal = currentTotal + delta;

  if (nextTotal < 0) {
    showInsufficientFunds(input);
    resetCurrencyInput(actor, key, input);
    return;
  }

  if (parsed.value < 0) {
    await spendCurrencyUnits(app, actor, key, currentCurrencyValue + Math.abs(parsed.value), input);
    return;
  }

  await setCurrencyValue(app, actor, key, parsed.value);
}

async function spendCurrencyUnits(app, actor, key, amountUnits, input = null) {
  const currency = CURRENCY_BY_KEY[key];
  if (!currency) return;

  const amount = Math.max(0, Math.floor(Number(amountUnits) || 0));
  if (amount <= 0) return;

  const deltaCopper = amount * currency.unit;
  const currentTotal = getWalletCopperTotal(actor);

  if (currentTotal - deltaCopper < 0) {
    showInsufficientFunds(input);
    resetCurrencyInput(actor, key, input);
    return;
  }

  const current = getCurrencyValue(actor, key);

  // Common case: reduce the visible denomination literally.
  // 11 ММ minus 1 must become 10 ММ, not 1 СМ.
  if (current >= amount) {
    await setCurrencyValue(app, actor, key, current - amount);
    return;
  }

  const values = getWalletValues(actor);
  const remainingAfterSelected = (amount - current) * currency.unit;
  values[key] = 0;

  const changed = spendCopperFromWalletValues(values, remainingAfterSelected, key);
  if (!changed) {
    showInsufficientFunds(input);
    resetCurrencyInput(actor, key, input);
    return;
  }

  await setCurrencyValues(app, actor, values);
}

function getWalletValues(actor) {
  return Object.fromEntries(CURRENCIES.map((currency) => [currency.key, getCurrencyValue(actor, currency.key)]));
}

function spendCopperFromWalletValues(values, amountCopper, preferredKey) {
  let remaining = Math.max(0, Math.floor(Number(amountCopper) || 0));
  if (remaining <= 0) return true;

  // Spend lower denominations first before breaking larger coins.
  // This keeps unrelated large coins intact whenever the wallet can cover the cost with small money.
  const preferredCurrency = CURRENCY_BY_KEY[preferredKey];
  const smallerOrEqual = CURRENCIES
    .filter((currency) => currency.unit <= preferredCurrency.unit && currency.key !== preferredKey)
    .sort((a, b) => a.unit - b.unit);

  for (const currency of smallerOrEqual) {
    remaining = spendFromExistingCoins(values, currency, remaining);
    if (remaining <= 0) return true;
  }

  const larger = CURRENCIES
    .filter((currency) => currency.unit > preferredCurrency.unit)
    .sort((a, b) => a.unit - b.unit);

  for (const currency of larger) {
    while (remaining > 0 && values[currency.key] > 0) {
      values[currency.key] -= 1;

      if (currency.unit >= remaining) {
        const changeCopper = currency.unit - remaining;
        remaining = 0;
        addChange(values, changeCopper, currency.unit);
        return true;
      }

      remaining -= currency.unit;
    }
  }

  // Last resort: if a higher selected denomination was being spent and smaller coins cover it,
  // consume them without normalizing the wallet.
  const allSmaller = CURRENCIES
    .filter((currency) => currency.unit < preferredCurrency.unit)
    .sort((a, b) => a.unit - b.unit);

  for (const currency of allSmaller) {
    remaining = spendFromExistingCoins(values, currency, remaining);
    if (remaining <= 0) return true;
  }

  return remaining <= 0;
}

function spendFromExistingCoins(values, currency, amountCopper) {
  if (amountCopper <= 0) return 0;

  const coinsToSpend = Math.min(values[currency.key], Math.floor(amountCopper / currency.unit));
  if (coinsToSpend <= 0) return amountCopper;

  values[currency.key] -= coinsToSpend;
  return amountCopper - coinsToSpend * currency.unit;
}

function addChange(values, changeCopper, brokenCoinUnit) {
  let remaining = Math.max(0, Math.floor(Number(changeCopper) || 0));

  const changeCurrencies = CURRENCIES
    .filter((currency) => currency.unit < brokenCoinUnit)
    .sort((a, b) => b.unit - a.unit);

  for (const currency of changeCurrencies) {
    const count = Math.floor(remaining / currency.unit);
    if (count <= 0) continue;
    values[currency.key] += count;
    remaining -= count * currency.unit;
  }
}

async function setCurrencyValues(app, actor, values) {
  if (!canModifyActor(actor)) {
    warnCannotModifyActor(qaLocalize("Permissions.NoCurrencyModify", "Нет прав на изменение валюты этого персонажа."));
    return;
  }

  const updateData = buildActorCurrencyUpdate(actor, values);

  markWalletOpenUnlessExpanded(actor);
  await actor.update(updateData);
  markWalletOpenUnlessExpanded(actor);
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

async function runWalletOperation(actor, sourceElement, operation) {
  const row = sourceElement?.closest?.(".fblqa-currency-row") ?? null;
  setWalletRowBusy(row, true);

  try {
    return await enqueueWalletOperation(actor, operation);
  } catch (error) {
    console.error("fbl-quick-access | wallet operation failed", error);
    ui.notifications?.error?.(qaLocalize("Wallet.UpdateFailed", "Could not update the wallet."));
    return undefined;
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

function resetCurrencyInput(actor, key, input) {
  if (!input || input.tagName !== "INPUT") return;
  input.value = String(getCurrencyValue(actor, key));
}

function showInsufficientFunds(input) {
  showWalletMessage(input, qaLocalize("Wallet.InsufficientFunds", "INSUFFICIENT FUNDS"), true);
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
