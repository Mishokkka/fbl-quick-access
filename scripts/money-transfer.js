import { CURRENCIES, MODULE_ID } from "./constants.js";
import { buildActorCurrencyUpdate } from "./actor-data.js";
import { getCurrencyValue } from "./currency.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, localizeOrFallback, rerenderSheet } from "./utils.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const OFFER_TYPE = "wallet-transfer-offer";
const DECISION_TYPE = "wallet-transfer-decision";
const RESULT_TYPE = "wallet-transfer-result";
const REQUEST_TIMEOUT_MS = 90_000;
const RESULT_GRACE_MS = 5_000;
const SEEN_PACKET_LIMIT = 200;

let socketRegistered = false;
let transferQueue = Promise.resolve();
const pendingRequests = new Map();
const gmOffers = new Map();
const earlyDecisions = new Map();
const incomingOffers = new Map();
const seenPackets = new Set();
const seenPacketOrder = [];

export function registerMoneyTransferSocket() {
  if (socketRegistered || !game.socket?.on) return;
  game.socket.on(SOCKET_CHANNEL, (message) => {
    void handleSocketMessage(message);
  });
  socketRegistered = true;
}

export async function openMoneyTransferDialog(app, sourceActor) {
  if (!canModifyActor(sourceActor)) {
    warnCannotModifyActor(qaLocalize("Wallet.Transfer.NoSourcePermission", "Нет прав на передачу денег этого персонажа."));
    return null;
  }

  const targets = getMoneyTransferTargets(sourceActor);
  if (!targets.length) {
    ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.NoRecipients", "Не найдено других активных игроков с назначенным персонажем."));
    return null;
  }

  if (!globalThis.Dialog) {
    ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.DialogUnavailable", "Окно передачи денег недоступно в этом окружении."));
    return null;
  }

  const content = buildMoneyTransferDialogContent(sourceActor, targets);

  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    new Dialog({
      title: qaLocalize("Wallet.Transfer.Title", "Передача денег"),
      content,
      buttons: {
        send: {
          icon: '<i class="fas fa-paper-plane"></i>',
          label: qaLocalize("Wallet.Transfer.Send", "Передать"),
          callback: async (html) => {
            const form = extractDialogElement(html)?.querySelector("form.fblqa-money-transfer-form");
            const targetActorId = String(form?.querySelector('[name="targetActor"]')?.value ?? "");
            const amounts = Object.fromEntries(CURRENCIES.map((currency) => [
              currency.key,
              Math.max(0, Math.floor(Number(form?.querySelector(`[name="amount-${currency.key}"]`)?.value) || 0))
            ]));

            const resultPromise = requestMoneyTransfer(sourceActor.id, targetActorId, amounts);
            ui.notifications?.info?.(qaLocalize("Wallet.Transfer.OfferSent", "Предложение отправлено получателю."));
            const result = await resultPromise;

            if (result.ok) {
              ui.notifications?.info?.(qaLocalize("Wallet.Transfer.Completed", "Передано персонажу {target}: {amount}.", {
                target: result.targetName,
                amount: formatTransferAmounts(result.amounts)
              }));
              rerenderSheet(app);
            } else if (result.error === "declined") {
              ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.Declined", "Получатель отклонил перевод."));
            } else {
              ui.notifications?.error?.(localizeTransferError(result.error));
            }
            finish(result);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: qaLocalize("Common.Cancel", "Отмена"),
          callback: () => finish(null)
        }
      },
      default: "send",
      render: (html) => {
        const element = extractDialogElement(html);
        element?.closest?.(".app")?.classList.add("fblqa-money-transfer-dialog");
        setupMoneyTransferDialog(element, sourceActor);
      },
      close: () => finish(null)
    }, {
      classes: ["fblqa-money-transfer-dialog"],
      width: 430,
      height: "auto",
      resizable: false
    }).render(true);
  });
}

export function normalizeTransferAmounts(rawAmounts = {}) {
  return Object.fromEntries(CURRENCIES.map((currency) => [
    currency.key,
    Math.max(0, Math.floor(Number(rawAmounts?.[currency.key]) || 0))
  ]));
}

export function buildMoneyTransferPlan(sourceActor, targetActor, rawAmounts = {}) {
  if (!sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (sourceActor.id === targetActor.id) return { ok: false, error: "same-actor" };

  const amounts = normalizeTransferAmounts(rawAmounts);
  const totalCoins = Object.values(amounts).reduce((sum, value) => sum + value, 0);
  if (totalCoins <= 0) return { ok: false, error: "empty-amount" };

  const sourceBefore = {};
  const targetBefore = {};
  const sourceAfter = {};
  const targetAfter = {};

  for (const currency of CURRENCIES) {
    const sourceValue = getCurrencyValue(sourceActor, currency.key);
    const targetValue = getCurrencyValue(targetActor, currency.key);
    const amount = amounts[currency.key];

    if (amount > sourceValue) {
      return { ok: false, error: "insufficient-denomination", currency: currency.key };
    }

    sourceBefore[currency.key] = sourceValue;
    targetBefore[currency.key] = targetValue;
    sourceAfter[currency.key] = sourceValue - amount;
    targetAfter[currency.key] = targetValue + amount;
  }

  return {
    ok: true,
    sourceActor,
    targetActor,
    amounts,
    sourceBefore,
    targetBefore,
    sourceAfter,
    targetAfter,
    sourceUpdate: buildActorCurrencyUpdate(sourceActor, sourceAfter),
    targetUpdate: buildActorCurrencyUpdate(targetActor, targetAfter)
  };
}

export function selectMoneyTransferRecipient(users, targetActor, requesterId = null) {
  const candidates = Array.from(users ?? [])
    .filter((user) => user && !user.isGM && user.active && user.id !== requesterId && userOwnsActor(user, targetActor))
    .sort((a, b) => {
      const aAssigned = resolveUserCharacterFromCollection(a, null)?.id === targetActor?.id ? 1 : 0;
      const bAssigned = resolveUserCharacterFromCollection(b, null)?.id === targetActor?.id ? 1 : 0;
      if (aAssigned !== bAssigned) return bAssigned - aAssigned;
      return String(a.id).localeCompare(String(b.id));
    });
  return candidates[0] ?? null;
}

export function buildTransferWhisperModel(offer, result) {
  const status = result?.ok
    ? "completed"
    : result?.error === "declined"
      ? "declined"
      : result?.error === "recipient-timeout"
        ? "expired"
        : "failed";

  return {
    status,
    requesterId: offer?.requesterId ?? null,
    recipientUserId: offer?.recipientUserId ?? null,
    sourceActorId: offer?.sourceActorId ?? null,
    targetActorId: offer?.targetActorId ?? null,
    amounts: normalizeTransferAmounts(offer?.amounts)
  };
}

export async function requestMoneyTransfer(sourceActorId, targetActorId, rawAmounts) {
  const sourceActor = game.actors?.get?.(sourceActorId);
  const targetActor = game.actors?.get?.(targetActorId);
  const amounts = normalizeTransferAmounts(rawAmounts);

  if (!sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (!canModifyActor(sourceActor)) return { ok: false, error: "source-permission" };

  const preliminaryPlan = buildMoneyTransferPlan(sourceActor, targetActor, amounts);
  if (!preliminaryPlan.ok) return preliminaryPlan;

  const recipient = selectMoneyTransferRecipient(game.users, targetActor, game.user?.id);
  if (!recipient) return { ok: false, error: "recipient-offline" };

  const primaryGm = getPrimaryActiveGm();
  if (!primaryGm) return { ok: false, error: "no-gm" };
  if (!game.socket?.emit) return { ok: false, error: "socket-unavailable" };

  const requestId = makeRequestId();
  const response = new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ ok: false, error: "timeout" });
    }, REQUEST_TIMEOUT_MS + RESULT_GRACE_MS);
    pendingRequests.set(requestId, { resolve, timeout });
  });

  await sendSocketMessage({
    type: OFFER_TYPE,
    requestId,
    requesterId: game.user.id,
    recipientUserId: recipient.id,
    primaryGmId: primaryGm.id,
    sourceActorId,
    targetActorId,
    amounts,
    createdAt: Date.now()
  });

  return response;
}

async function handleSocketMessage(message) {
  if (!message || typeof message !== "object") return;
  if (!rememberPacket(message.packetId)) return;

  if (message.type === RESULT_TYPE) {
    handleTransferResult(message);
    return;
  }

  if (message.type === OFFER_TYPE) {
    await handleTransferOffer(message);
    return;
  }

  if (message.type === DECISION_TYPE) {
    await handleTransferDecision(message);
  }
}

async function handleTransferOffer(message) {
  const primaryGm = getPrimaryActiveGm();

  if (game.user?.isGM && primaryGm?.id === game.user.id) {
    const validation = validateIncomingOffer(message);
    if (!validation.ok) {
      await finalizeTransferOffer(message, validation);
      return;
    }

    const timeout = globalThis.setTimeout(() => {
      const stored = gmOffers.get(message.requestId);
      if (!stored) return;
      void finalizeTransferOffer(stored.offer, { ok: false, error: "recipient-timeout" });
    }, REQUEST_TIMEOUT_MS);

    gmOffers.set(message.requestId, { offer: { ...message }, timeout });

    const earlyDecision = earlyDecisions.get(message.requestId);
    if (earlyDecision) {
      globalThis.clearTimeout(earlyDecision.timeout);
      earlyDecisions.delete(message.requestId);
      await handleTransferDecision(earlyDecision.message);
    }
  }

  if (message.recipientUserId !== game.user?.id) return;

  const validation = validateRecipientOffer(message);
  if (!validation.ok) {
    await sendSocketMessage({
      type: DECISION_TYPE,
      requestId: message.requestId,
      requesterId: message.requesterId,
      recipientUserId: message.recipientUserId,
      accepted: false,
      reason: validation.error
    });
    return;
  }

  if (!globalThis.Dialog) {
    await sendSocketMessage({
      type: DECISION_TYPE,
      requestId: message.requestId,
      requesterId: message.requesterId,
      recipientUserId: message.recipientUserId,
      accepted: false,
      reason: "recipient-dialog-unavailable"
    });
    return;
  }

  openIncomingMoneyTransferDialog(message);
}

async function handleTransferDecision(message) {
  const primaryGm = getPrimaryActiveGm();
  if (!game.user?.isGM || primaryGm?.id !== game.user.id) return;

  const stored = gmOffers.get(message.requestId);
  if (!stored) {
    if (!earlyDecisions.has(message.requestId)) {
      const timeout = globalThis.setTimeout(() => earlyDecisions.delete(message.requestId), RESULT_GRACE_MS);
      earlyDecisions.set(message.requestId, { message: { ...message }, timeout });
    }
    return;
  }
  const offer = stored.offer;

  if (message.recipientUserId !== offer.recipientUserId || message.requesterId !== offer.requesterId) {
    await finalizeTransferOffer(offer, { ok: false, error: "invalid-request" });
    return;
  }

  if (!message.accepted) {
    await finalizeTransferOffer(offer, {
      ok: false,
      error: message.reason === "recipient-dialog-unavailable" ? "recipient-dialog-unavailable" : "declined"
    });
    return;
  }

  const recipientUser = game.users?.get?.(offer.recipientUserId);
  const targetActor = game.actors?.get?.(offer.targetActorId);
  if (!recipientUser || !recipientUser.active || !userOwnsActor(recipientUser, targetActor)) {
    await finalizeTransferOffer(offer, { ok: false, error: "invalid-recipient" });
    return;
  }

  const sourceActor = game.actors?.get?.(offer.sourceActorId);
  const result = await enqueueTransfer(() => executeMoneyTransfer(sourceActor, targetActor, offer.amounts));
  await finalizeTransferOffer(offer, result);
}

function handleTransferResult(message) {
  const incoming = incomingOffers.get(message.requestId);
  if (incoming) {
    incoming.decided = true;
    incoming.dialog?.close?.();
    incomingOffers.delete(message.requestId);
  }

  if (message.requesterId === game.user?.id) {
    const pending = pendingRequests.get(message.requestId);
    if (pending) {
      globalThis.clearTimeout(pending.timeout);
      pendingRequests.delete(message.requestId);
      pending.resolve(message.result ?? { ok: false, error: "unknown" });
    }
  }

  if (message.recipientUserId !== game.user?.id) return;

  const result = message.result ?? { ok: false, error: "unknown" };
  if (result.ok) {
    ui.notifications?.info?.(qaLocalize("Wallet.Transfer.RecipientCompleted", "Перевод принят: {amount}.", {
      amount: formatTransferAmounts(result.amounts)
    }));
  } else if (result.error === "declined") {
    ui.notifications?.info?.(qaLocalize("Wallet.Transfer.RecipientDeclined", "Перевод отклонён."));
  } else {
    ui.notifications?.error?.(localizeTransferError(result.error));
  }

  const targetActor = game.actors?.get?.(message.targetActorId);
  targetActor?.sheet?.render?.(false);
}

function openIncomingMoneyTransferDialog(offer) {
  if (incomingOffers.has(offer.requestId)) return;

  const content = buildIncomingMoneyTransferDialogContent(offer);
  const state = { decided: false, dialog: null };

  const decide = async (accepted, reason = null) => {
    if (state.decided) return;
    state.decided = true;
    incomingOffers.delete(offer.requestId);
    await sendSocketMessage({
      type: DECISION_TYPE,
      requestId: offer.requestId,
      requesterId: offer.requesterId,
      recipientUserId: offer.recipientUserId,
      accepted,
      reason
    });
  };

  const dialog = new Dialog({
    title: qaLocalize("Wallet.Transfer.IncomingTitle", "Входящий перевод"),
    content,
    buttons: {
      accept: {
        icon: '<i class="fas fa-check"></i>',
        label: qaLocalize("Wallet.Transfer.Accept", "Принять"),
        callback: () => decide(true)
      },
      decline: {
        icon: '<i class="fas fa-times"></i>',
        label: qaLocalize("Wallet.Transfer.Decline", "Отклонить"),
        callback: () => decide(false, "declined")
      }
    },
    default: "accept",
    render: (html) => {
      const element = extractDialogElement(html);
      element?.closest?.(".app")?.classList.add("fblqa-money-transfer-dialog", "fblqa-money-transfer-offer-dialog");
    },
    close: () => {
      if (!state.decided) void decide(false, "declined");
    }
  }, {
    classes: ["fblqa-money-transfer-dialog", "fblqa-money-transfer-offer-dialog"],
    width: 420,
    height: "auto",
    resizable: false
  });

  state.dialog = dialog;
  incomingOffers.set(offer.requestId, state);
  dialog.render(true);
}

function buildIncomingMoneyTransferDialogContent(offer) {
  const requester = game.users?.get?.(offer.requesterId);
  const sourceActor = game.actors?.get?.(offer.sourceActorId);
  const targetActor = game.actors?.get?.(offer.targetActorId);
  const amount = formatTransferAmounts(offer.amounts);

  return `
    <div class="fblqa-money-transfer-offer">
      <p class="fblqa-money-transfer-offer-intro">${escapeHtml(qaLocalize("Wallet.Transfer.IncomingDescription", "Игрок предлагает передать деньги вашему персонажу."))}</p>
      <dl class="fblqa-money-transfer-offer-details">
        <div><dt>${escapeHtml(qaLocalize("Wallet.Transfer.From", "Отправитель"))}</dt><dd>${escapeHtml(requester?.name ?? "?")} — ${escapeHtml(sourceActor?.name ?? "?")}</dd></div>
        <div><dt>${escapeHtml(qaLocalize("Wallet.Transfer.To", "Получатель"))}</dt><dd>${escapeHtml(targetActor?.name ?? "?")}</dd></div>
        <div><dt>${escapeHtml(qaLocalize("Wallet.Transfer.Amount", "Сумма"))}</dt><dd>${escapeHtml(amount)}</dd></div>
      </dl>
    </div>`;
}

function validateIncomingOffer(message) {
  const requester = game.users?.get?.(message.requesterId);
  const recipient = game.users?.get?.(message.recipientUserId);
  const sourceActor = game.actors?.get?.(message.sourceActorId);
  const targetActor = game.actors?.get?.(message.targetActorId);

  if (!requester || !recipient || !sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (!requester.isGM && !userOwnsActor(requester, sourceActor)) return { ok: false, error: "source-permission" };
  if (!recipient.active || recipient.isGM || !userOwnsActor(recipient, targetActor)) return { ok: false, error: "invalid-recipient" };
  if (sourceActor.type !== "character" || targetActor.type !== "character") return { ok: false, error: "invalid-recipient" };
  return buildMoneyTransferPlan(sourceActor, targetActor, message.amounts);
}

function validateRecipientOffer(message) {
  const recipient = game.users?.get?.(message.recipientUserId);
  const targetActor = game.actors?.get?.(message.targetActorId);
  if (!recipient || recipient.id !== game.user?.id || !targetActor) return { ok: false, error: "invalid-recipient" };
  if (!recipient.active || !userOwnsActor(recipient, targetActor)) return { ok: false, error: "invalid-recipient" };
  return { ok: true };
}

async function finalizeTransferOffer(offer, result) {
  const stored = gmOffers.get(offer.requestId);
  if (stored) globalThis.clearTimeout(stored.timeout);
  gmOffers.delete(offer.requestId);

  const completeResult = {
    ...(result ?? { ok: false, error: "unknown" }),
    sourceActorId: offer.sourceActorId,
    targetActorId: offer.targetActorId,
    requesterId: offer.requesterId,
    recipientUserId: offer.recipientUserId,
    amounts: normalizeTransferAmounts(result?.amounts ?? offer.amounts)
  };

  await sendSocketMessage({
    type: RESULT_TYPE,
    requestId: offer.requestId,
    requesterId: offer.requesterId,
    recipientUserId: offer.recipientUserId,
    sourceActorId: offer.sourceActorId,
    targetActorId: offer.targetActorId,
    result: completeResult
  });
  await postTransferWhisper(offer, completeResult);
}

async function executeMoneyTransfer(sourceActor, targetActor, rawAmounts) {
  const plan = buildMoneyTransferPlan(sourceActor, targetActor, rawAmounts);
  if (!plan.ok) return plan;

  let sourceChanged = false;
  try {
    await sourceActor.update(plan.sourceUpdate);
    sourceChanged = true;
    await targetActor.update(plan.targetUpdate);

    Hooks.callAll?.("fblQuickAccess.walletTransferred", {
      sourceActor,
      targetActor,
      amounts: plan.amounts
    });

    return {
      ok: true,
      sourceActorId: sourceActor.id,
      targetActorId: targetActor.id,
      sourceName: sourceActor.name,
      targetName: targetActor.name,
      amounts: plan.amounts
    };
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer failed`, error);
    if (sourceChanged) {
      try {
        await sourceActor.update(buildActorCurrencyUpdate(sourceActor, plan.sourceBefore));
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | money transfer rollback failed`, rollbackError);
        return { ok: false, error: "rollback-failed" };
      }
    }
    return { ok: false, error: "update-failed" };
  }
}

async function postTransferWhisper(offer, result) {
  if (!globalThis.ChatMessage?.create) return null;

  const model = buildTransferWhisperModel(offer, result);
  const requester = game.users?.get?.(offer.requesterId);
  const recipient = game.users?.get?.(offer.recipientUserId);
  const sourceActor = game.actors?.get?.(offer.sourceActorId);
  const targetActor = game.actors?.get?.(offer.targetActorId);
  const status = localizeWhisperStatus(model.status, result?.error);
  const primaryGm = getPrimaryActiveGm();
  const recipients = [...new Set([offer.requesterId, offer.recipientUserId, primaryGm?.id].filter(Boolean))];

  const content = `
    <div class="fblqa-money-transfer-chat-card">
      <h3>${escapeHtml(qaLocalize("Wallet.Transfer.WhisperTitle", "Передача денег"))}</h3>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.From", "Отправитель"))}:</strong> ${escapeHtml(requester?.name ?? "?")} — ${escapeHtml(sourceActor?.name ?? "?")}</p>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.To", "Получатель"))}:</strong> ${escapeHtml(recipient?.name ?? "?")} — ${escapeHtml(targetActor?.name ?? "?")}</p>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.Amount", "Сумма"))}:</strong> ${escapeHtml(formatTransferAmounts(model.amounts))}</p>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.Status", "Статус"))}:</strong> ${escapeHtml(status)}</p>
    </div>`;

  try {
    return await ChatMessage.create({
      speaker: globalThis.ChatMessage?.getSpeaker?.({ actor: sourceActor }) ?? undefined,
      content,
      whisper: recipients
    });
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer whisper failed`, error);
    return null;
  }
}

function enqueueTransfer(operation) {
  const next = transferQueue.catch(() => {}).then(operation);
  transferQueue = next.catch(() => {});
  return next;
}

function buildMoneyTransferDialogContent(sourceActor, targets) {
  const targetOptions = targets.map(({ actor, users }) => {
    const ownerNames = users.map((user) => user.name).join(", ");
    const label = ownerNames ? `${actor.name} — ${ownerNames}` : actor.name;
    return `<option value="${escapeHtml(actor.id)}">${escapeHtml(label)}</option>`;
  }).join("");

  const currencyRows = CURRENCIES.map((currency) => {
    const available = getCurrencyValue(sourceActor, currency.key);
    return `
      <label class="fblqa-money-transfer-row" data-currency="${currency.key}">
        <span class="fblqa-money-transfer-abbr">${escapeHtml(currency.abbr)}</span>
        <span class="fblqa-money-transfer-name">${escapeHtml(localizeOrFallback(currency.label, currency.key))}</span>
        <input type="number" name="amount-${currency.key}" min="0" max="${available}" step="1" value="0">
        <small>${escapeHtml(qaLocalize("Wallet.Transfer.Available", "Доступно: {amount}", { amount: available }))}</small>
      </label>`;
  }).join("");

  return `
    <form class="fblqa-money-transfer-form">
      <div class="fblqa-money-transfer-source">
        <strong>${escapeHtml(sourceActor.name)}</strong>
        <span>${escapeHtml(qaLocalize("Wallet.Transfer.Description", "Выберите получателя и количество монет каждого номинала."))}</span>
      </div>
      <label class="fblqa-money-transfer-target">
        <span>${escapeHtml(qaLocalize("Wallet.Transfer.Recipient", "Получатель"))}</span>
        <select name="targetActor">${targetOptions}</select>
      </label>
      <div class="fblqa-money-transfer-currencies">${currencyRows}</div>
      <div class="fblqa-money-transfer-preview" aria-live="polite"></div>
    </form>`;
}

function setupMoneyTransferDialog(element, sourceActor) {
  const form = element?.querySelector?.("form.fblqa-money-transfer-form");
  if (!form) return;

  const updatePreview = () => {
    const amounts = Object.fromEntries(CURRENCIES.map((currency) => [
      currency.key,
      Math.max(0, Math.floor(Number(form.querySelector(`[name="amount-${currency.key}"]`)?.value) || 0))
    ]));
    const preview = form.querySelector(".fblqa-money-transfer-preview");
    if (!preview) return;
    const count = Object.values(amounts).reduce((sum, value) => sum + value, 0);
    preview.textContent = count
      ? qaLocalize("Wallet.Transfer.Preview", "Будет передано: {amount}", { amount: formatTransferAmounts(amounts) })
      : qaLocalize("Wallet.Transfer.PreviewEmpty", "Укажите количество монет.");
  };

  for (const currency of CURRENCIES) {
    const input = form.querySelector(`[name="amount-${currency.key}"]`);
    input?.addEventListener("input", () => {
      const max = getCurrencyValue(sourceActor, currency.key);
      input.value = String(Math.min(max, Math.max(0, Math.floor(Number(input.value) || 0))));
      updatePreview();
    });
  }
  updatePreview();
}

function getMoneyTransferTargets(sourceActor) {
  const targets = new Map();
  const users = Array.from(game.users ?? []).filter((user) => !user.isGM && user.active && user.id !== game.user?.id);

  for (const user of users) {
    const assigned = resolveUserCharacter(user);
    const ownedActors = assigned && userOwnsActor(user, assigned)
      ? [assigned]
      : Array.from(game.actors ?? []).filter((actor) => actor?.type === "character" && userOwnsActor(user, actor));

    for (const actor of ownedActors) {
      if (!actor || actor.type !== "character" || actor.id === sourceActor?.id) continue;
      if (!targets.has(actor.id)) targets.set(actor.id, { actor, users: [] });
      targets.get(actor.id).users.push(user);
    }
  }

  return [...targets.values()].sort((a, b) => String(a.actor.name).localeCompare(String(b.actor.name)));
}

function resolveUserCharacter(user) {
  return resolveUserCharacterFromCollection(user, game.actors);
}

function resolveUserCharacterFromCollection(user, actors) {
  const character = user?.character;
  if (character?.documentName === "Actor" || character?.id) return character;
  const id = character?.id ?? character;
  return id && actors?.get ? actors.get(id) ?? null : null;
}

function userOwnsActor(user, actor) {
  if (!user || !actor) return false;
  if (typeof actor.testUserPermission === "function") return actor.testUserPermission(user, "OWNER");
  const ownership = actor.ownership ?? actor.permission ?? {};
  return Number(ownership[user.id] ?? ownership.default ?? 0) >= 3;
}

function getPrimaryActiveGm() {
  return Array.from(game.users ?? [])
    .filter((user) => user.isGM && user.active)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function formatTransferAmounts(amounts) {
  return CURRENCIES
    .map((currency) => ({ currency, value: Math.max(0, Math.floor(Number(amounts?.[currency.key]) || 0)) }))
    .filter(({ value }) => value > 0)
    .map(({ currency, value }) => `${value} ${currency.abbr}`)
    .join(", ") || qaLocalize("Wallet.Transfer.Nothing", "ничего");
}

function localizeTransferError(code) {
  const key = {
    "missing-actor": "MissingActor",
    "same-actor": "SameActor",
    "empty-amount": "EmptyAmount",
    "insufficient-denomination": "InsufficientDenomination",
    "source-permission": "NoSourcePermission",
    "invalid-recipient": "InvalidRecipient",
    "recipient-offline": "RecipientOffline",
    "recipient-dialog-unavailable": "RecipientDialogUnavailable",
    "recipient-timeout": "RecipientTimeout",
    "declined": "Declined",
    "invalid-request": "InvalidRequest",
    "no-gm": "NoGm",
    "socket-unavailable": "SocketUnavailable",
    "timeout": "Timeout",
    "rollback-failed": "RollbackFailed",
    "update-failed": "UpdateFailed"
  }[code] ?? "UnknownError";
  return qaLocalize(`Wallet.Transfer.${key}`, "Не удалось передать деньги.");
}

function localizeWhisperStatus(status, error) {
  if (status === "completed") return qaLocalize("Wallet.Transfer.StatusCompleted", "Принято и выполнено");
  if (status === "declined") return qaLocalize("Wallet.Transfer.StatusDeclined", "Отклонено получателем");
  if (status === "expired") return qaLocalize("Wallet.Transfer.StatusExpired", "Истекло время ожидания");
  return qaLocalize("Wallet.Transfer.StatusFailed", "Не выполнено: {reason}", {
    reason: localizeTransferError(error)
  });
}

async function sendSocketMessage(payload) {
  const message = { ...payload, packetId: payload.packetId ?? makeRequestId() };
  await handleSocketMessage(message);
  game.socket?.emit?.(SOCKET_CHANNEL, message);
}

function rememberPacket(packetId) {
  if (!packetId) return true;
  if (seenPackets.has(packetId)) return false;
  seenPackets.add(packetId);
  seenPacketOrder.push(packetId);
  while (seenPacketOrder.length > SEEN_PACKET_LIMIT) {
    const oldest = seenPacketOrder.shift();
    seenPackets.delete(oldest);
  }
  return true;
}

function makeRequestId() {
  return globalThis.foundry?.utils?.randomID?.(20)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function extractDialogElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}
