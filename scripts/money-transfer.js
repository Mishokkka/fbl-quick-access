import { CURRENCIES, MODULE_ID } from "./constants.js";
import { buildActorCurrencyUpdate } from "./actor-data.js";
import { getCurrencyAbbreviation, getCurrencyValue, readCurrencyBalances, writeCurrencyUpdate } from "./currency.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { escapeHtml, localizeOrFallback } from "./utils.js";
import { createFoundryDialog, extractDialogElement, hasFoundryDialogApi } from "./dialogs.js";
import { getActiveGM } from "./integration/socket-api.js";
import {
  clearSocketProof,
  consumeSocketProof,
  createSocketProof,
  scheduleSocketProofCleanup,
  verifySocketProofWithRetry
} from "./socket-auth.js";
import { findGameUser, isValidSocketRequestId, makeSocketRequestId } from "./socket-utils.js";
import { enqueueCurrencyOperation } from "./operation-queue.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const OFFER_TYPE = "wallet-transfer-offer";
const DECISION_TYPE = "wallet-transfer-decision";
const RESULT_TYPE = "wallet-transfer-result";
const OFFER_PROOF_KIND = "walletTransferOffer";
const DECISION_PROOF_KIND = "walletTransferDecision";
const RESULT_PROOF_KIND = "walletTransferResult";
const REQUEST_TIMEOUT_MS = 90_000;
const RESULT_GRACE_MS = 5_000;
const PROOF_GRACE_MS = 60_000;
const SEEN_PACKET_LIMIT = 200;

let socketRegistered = false;
const pendingRequests = new Map();
const gmOffers = new Map();
const earlyDecisions = new Map();
const incomingOffers = new Map();
const seenPackets = new Set();
const seenPacketOrder = [];

export function registerMoneyTransferSocket() {
  if (socketRegistered || !game.socket?.on) return;
  game.socket.on(SOCKET_CHANNEL, (message) => {
    void handleSocketMessage(message).catch(error => console.error(`${MODULE_ID} | money transfer packet failed`, error));
  });
  game.socket.on("disconnect", handleTransferDisconnect);
  socketRegistered = true;
}

export async function openMoneyTransferDialog(app, sourceActor) {
  if (!canModifyActor(sourceActor) || sourceActor.isToken || sourceActor.pack || sourceActor.type !== "character") {
    warnCannotModifyActor(qaLocalize("Wallet.Transfer.NoSourcePermission", "Нет прав на передачу денег этого персонажа."));
    return null;
  }

  const targets = getMoneyTransferTargets(sourceActor);
  if (!targets.length) {
    ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.NoRecipients", "Не найдено других активных игроков с назначенным персонажем."));
    return null;
  }

  if (!hasFoundryDialogApi()) {
    ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.DialogUnavailable", "Окно передачи денег недоступно в этом окружении."));
    return null;
  }

  const content = buildMoneyTransferDialogContent(sourceActor, targets);

  return new Promise((resolve) => {
    let finished = false;
    let submitted = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    createFoundryDialog({
      title: qaLocalize("Wallet.Transfer.Title", "Передача денег"),
      content,
      buttons: {
        send: {
          icon: '<i class="fas fa-paper-plane"></i>',
          label: qaLocalize("Wallet.Transfer.Send", "Передать"),
          callback: async (html, event) => {
            if (submitted) return;
            submitted = true;
            const element = extractDialogElement(html);
            const form = event?.submitter?.form ?? findTransferForm(element);
            disableTransferControls(element);
            const targetActorId = String(form?.querySelector('[name="targetActor"]')?.value ?? "");
            const amounts = Object.fromEntries(CURRENCIES.map((currency) => [
              currency.key,
              form?.querySelector(`[name="amount-${currency.key}"]`)?.value ?? 0
            ]));

            const result = await requestMoneyTransfer(sourceActor.id, targetActorId, amounts, {
              onSent: () => ui.notifications?.info?.(qaLocalize("Wallet.Transfer.OfferSent", "Предложение отправлено получателю."))
            });

            if (result.ok) {
              ui.notifications?.info?.(qaLocalize("Wallet.Transfer.Completed", "Передано персонажу {target}: {amount}.", {
                target: result.targetName,
                amount: formatTransferAmounts(result.amounts)
              }));
            } else if (result.error === "declined") {
              ui.notifications?.warn?.(qaLocalize("Wallet.Transfer.Declined", "Получатель отклонил перевод."));
            } else {
              notifyTransferError(result.error);
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
      close: () => {
        if (!submitted) finish(null);
      }
    }, {
      classes: ["fblqa-money-transfer-dialog"],
      width: 430,
      height: "auto",
      resizable: false
    }).render(true);
  });
}

export function normalizeTransferAmounts(rawAmounts = {}) {
  return Object.fromEntries(CURRENCIES.map(({ key }) => {
    const amount = Math.floor(Number(rawAmounts?.[key]));
    return [key, Number.isSafeInteger(amount) && amount > 0 ? amount : 0];
  }));
}

function readTransferAmounts(rawAmounts) {
  const amounts = {};
  for (const { key } of CURRENCIES) {
    const raw = rawAmounts?.[key] ?? 0;
    const amount = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isSafeInteger(amount) || amount < 0) return { ok: false, error: "invalid-amount" };
    amounts[key] = amount;
  }
  if (!Object.values(amounts).some(Boolean)) return { ok: false, error: "empty-amount" };
  return { ok: true, amounts };
}

export function buildMoneyTransferPlan(sourceActor, targetActor, rawAmounts = {}) {
  if (!sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (sourceActor.id === targetActor.id) return { ok: false, error: "same-actor" };
  const parsed = readTransferAmounts(rawAmounts);
  if (!parsed.ok) return parsed;
  const { amounts } = parsed;

  let sourceBefore, targetBefore;
  try {
    sourceBefore = readCurrencyBalances(sourceActor);
    targetBefore = readCurrencyBalances(targetActor);
  } catch (_error) {
    return { ok: false, error: "invalid-balance" };
  }
  const sourceAfter = {};
  const targetAfter = {};
  let targetTotal = 0n;

  for (const { key, unit } of CURRENCIES) {
    const amount = amounts[key];

    if (amount > sourceBefore[key]) {
      return { ok: false, error: "insufficient-denomination", currency: key };
    }

    sourceAfter[key] = sourceBefore[key] - amount;
    const nextTarget = BigInt(targetBefore[key]) + BigInt(amount);
    targetTotal += nextTarget * BigInt(unit);
    if (targetTotal > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "amount-overflow", currency: key };
    targetAfter[key] = Number(nextTarget);
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
    sourceUpdate: buildActorCurrencyUpdate(sourceActor, changedDenominations(sourceAfter, amounts)),
    targetUpdate: buildActorCurrencyUpdate(targetActor, changedDenominations(targetAfter, amounts))
  };
}

function changedDenominations(values, amounts) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => amounts[key] > 0));
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
  const status = result?.ok ? "completed" : ({
    declined: "declined",
    "recipient-timeout": "expired",
    "partial-failure": "partial",
    "outcome-unknown": "unknown"
  }[result?.error] ?? "failed");

  return {
    status,
    requesterId: offer?.requesterId ?? null,
    recipientUserId: offer?.recipientUserId ?? null,
    sourceActorId: offer?.sourceActorId ?? null,
    targetActorId: offer?.targetActorId ?? null,
    amounts: normalizeTransferAmounts(offer?.amounts)
  };
}

export async function requestMoneyTransfer(sourceActorId, targetActorId, rawAmounts, { onSent } = {}) {
  const sourceActor = game.actors?.get?.(sourceActorId);
  const targetActor = game.actors?.get?.(targetActorId);

  if (!sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (sourceActor.id === targetActor.id) return { ok: false, error: "same-actor" };
  if (!canModifyActor(sourceActor)) return { ok: false, error: "source-permission" };
  if (sourceActor.type !== "character" || sourceActor.pack) return { ok: false, error: "source-permission" };
  if (targetActor.type !== "character" || targetActor.pack) return { ok: false, error: "invalid-recipient" };
  const parsed = readTransferAmounts(rawAmounts);
  if (!parsed.ok) return parsed;

  const recipient = selectMoneyTransferRecipient(game.users, targetActor, game.user?.id);
  if (!recipient) return { ok: false, error: "recipient-offline" };

  const primaryGm = getActiveGM();
  if (!primaryGm) return { ok: false, error: "no-gm" };
  if (!game.socket?.emit || game.socket.connected === false) return { ok: false, error: "socket-unavailable" };
  registerMoneyTransferSocket();

  const requestId = makeSocketRequestId();
  const requester = game.user;
  const offer = {
    type: OFFER_TYPE,
    requestId,
    requesterId: requester.id,
    recipientUserId: recipient.id,
    primaryGmId: primaryGm.id,
    sourceActorId,
    targetActorId,
    amounts: parsed.amounts,
    createdAt: getTransferTime()
  };

  const response = new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      settlePendingRequest(requestId, { ok: false, error: "outcome-unknown" });
    }, getOfferTimeLeft(offer) + RESULT_GRACE_MS);
    pendingRequests.set(requestId, { resolve, timeout, requester, offer });
  });
  void publishTransferOffer(offer, requester, onSent);
  return response;
}

async function publishTransferOffer(offer, requester, onSent) {
  try {
    await createSocketProof(OFFER_PROOF_KIND, offer.requestId, offer, requester);
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer offer could not be authorized`, error);
    settlePendingRequest(offer.requestId, { ok: false, error: "identity-proof-failed" });
    return;
  }

  if (!pendingRequests.has(offer.requestId)) return;
  try {
    await sendSocketMessage(offer);
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer offer could not be sent`, error);
    settlePendingRequest(offer.requestId, { ok: false, error: "socket-unavailable" });
    return;
  }
  onSent?.();
}

function settlePendingRequest(requestId, result) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  globalThis.clearTimeout(pending.timeout);
  pending.resolve(result);
  if (game.socket?.connected !== false) void clearSocketProof(pending.requester, OFFER_PROOF_KIND, requestId);
}

function handleTransferDisconnect() {
  for (const requestId of pendingRequests.keys()) settlePendingRequest(requestId, { ok: false, error: "outcome-unknown" });
  for (const [requestId, state] of incomingOffers) {
    closeIncomingOffer(requestId);
    notifyTransferError(state.accepted ? "outcome-unknown" : "socket-unavailable");
  }
}

async function handleSocketMessage(message) {
  if (!message || typeof message !== "object") return;
  if (!rememberPacket(message.packetId)) return;

  if (message.type === RESULT_TYPE) {
    await handleTransferResult(message);
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
  if (!isValidOfferMessage(message)) return;
  const primaryGm = getActiveGM();
  const isPrimaryGm = Boolean(game.user?.isGM && primaryGm?.id === game.user.id && message.primaryGmId === game.user.id);
  const isRecipient = message.recipientUserId === game.user?.id;
  if (!isPrimaryGm && !isRecipient) return;

  const requester = findGameUser(message.requesterId);
  if (!requester?.active) return;
  const proof = await verifyTransferProof(requester, OFFER_PROOF_KIND, message.requestId, withoutPacketId(message));
  if (!proof.ok) return;
  if (!consumeSocketProof(requester.id, OFFER_PROOF_KIND, message.requestId)) return;

  if (isPrimaryGm) {
    if (gmOffers.has(message.requestId)) return;
    const validation = validateIncomingOffer(message);
    if (!validation.ok) {
      await finalizeTransferOffer(message, validation);
      return;
    }

    const timeout = globalThis.setTimeout(() => {
      const stored = gmOffers.get(message.requestId);
      if (!stored) return;
      void finalizeTransferOffer(stored.offer, { ok: false, error: "recipient-timeout" });
    }, getOfferTimeLeft(message));

    gmOffers.set(message.requestId, { offer: { ...message }, timeout });

    const earlyDecision = earlyDecisions.get(message.requestId);
    if (earlyDecision) {
      globalThis.clearTimeout(earlyDecision.timeout);
      earlyDecisions.delete(message.requestId);
      await processTransferDecision(gmOffers.get(message.requestId).offer, earlyDecision.message);
    }
  }

  if (!isRecipient) return;

  const validation = validateRecipientOffer(message);
  if (!validation.ok) {
    await sendTransferDecision(message, false, validation.error);
    return;
  }

  if (!hasFoundryDialogApi()) {
    await sendTransferDecision(message, false, "recipient-dialog-unavailable");
    return;
  }

  openIncomingMoneyTransferDialog(message);
}

async function handleTransferDecision(message) {
  if (!isValidDecisionMessage(message)) return;
  const primaryGm = getActiveGM();
  if (!game.user?.isGM || primaryGm?.id !== game.user.id || message.primaryGmId !== game.user.id) return;

  const recipientUser = findGameUser(message.recipientUserId);
  if (!recipientUser?.active || recipientUser.isGM) return;
  const proof = await verifyTransferProof(recipientUser, DECISION_PROOF_KIND, message.requestId, withoutPacketId(message));
  if (!proof.ok) return;
  if (!consumeSocketProof(recipientUser.id, DECISION_PROOF_KIND, message.requestId)) return;

  const stored = gmOffers.get(message.requestId);
  if (!stored) {
    if (!earlyDecisions.has(message.requestId)) {
      const timeout = globalThis.setTimeout(() => earlyDecisions.delete(message.requestId), RESULT_GRACE_MS);
      earlyDecisions.set(message.requestId, { message: { ...message }, timeout });
    }
    return;
  }

  await processTransferDecision(stored.offer, message);
}

async function processTransferDecision(offer, message) {
  if (message.recipientUserId !== offer.recipientUserId
    || message.requesterId !== offer.requesterId
    || message.primaryGmId !== offer.primaryGmId) return;

  // Once a decision claims the offer, its waiting timer must not publish a result.
  const stored = gmOffers.get(offer.requestId);
  if (!stored) return;
  globalThis.clearTimeout(stored.timeout);
  gmOffers.delete(offer.requestId);

  if (!getOfferTimeLeft(offer)) {
    await finalizeTransferOffer(offer, { ok: false, error: "recipient-timeout" });
    return;
  }

  if (!message.accepted) {
    await finalizeTransferOffer(offer, {
      ok: false,
      error: message.reason === "recipient-dialog-unavailable" ? "recipient-dialog-unavailable" : "declined"
    });
    return;
  }

  const result = await enqueueCurrencyOperation(() => {
    if (getActiveGM()?.id !== offer.primaryGmId || game.user?.id !== offer.primaryGmId) return { ok: false, error: "no-gm" };
    if (!getOfferTimeLeft(offer)) return { ok: false, error: "recipient-timeout" };
    const parties = validateTransferParties(offer);
    if (!parties.ok) return parties;
    return executeMoneyTransfer(parties.sourceActor, parties.targetActor, offer.amounts);
  });
  await finalizeTransferOffer(offer, result);
}

async function handleTransferResult(message) {
  if (!isValidResultMessage(message)) return;
  const isRequester = message.requesterId === game.user?.id;
  const isRecipient = message.recipientUserId === game.user?.id;
  if (!isRequester && !isRecipient) return;

  const primaryGm = findGameUser(message.primaryGmId);
  if (!primaryGm?.isGM) return;
  const offer = pendingRequests.get(message.requestId)?.offer ?? incomingOffers.get(message.requestId)?.offer;
  if ((offer?.primaryGmId ?? getActiveGM()?.id) !== primaryGm.id) return;

  const proof = await verifyTransferProof(primaryGm, RESULT_PROOF_KIND, message.requestId, withoutPacketId(message));
  if (!proof.ok) return;
  if (!consumeSocketProof(primaryGm.id, RESULT_PROOF_KIND, message.requestId)) return;

  closeIncomingOffer(message.requestId);

  if (isRequester) {
    const pending = pendingRequests.get(message.requestId);
    if (pending?.offer.primaryGmId === message.primaryGmId) {
      settlePendingRequest(message.requestId, message.result ?? { ok: false, error: "outcome-unknown" });
    }
  }

  if (!isRecipient) return;
  void clearSocketProof(game.user, DECISION_PROOF_KIND, message.requestId);

  const result = message.result ?? { ok: false, error: "unknown" };
  if (result.ok) {
    ui.notifications?.info?.(qaLocalize("Wallet.Transfer.RecipientCompleted", "Перевод принят: {amount}.", {
      amount: formatTransferAmounts(result.amounts)
    }));
  } else if (result.error === "declined") {
    ui.notifications?.info?.(qaLocalize("Wallet.Transfer.RecipientDeclined", "Перевод отклонён."));
  } else {
    notifyTransferError(result.error);
  }

  const targetActor = game.actors?.get?.(message.targetActorId);
  targetActor?.sheet?.render?.(false);
}

async function sendTransferDecision(offer, accepted, reason = null) {
  const message = {
    type: DECISION_TYPE,
    requestId: offer.requestId,
    requesterId: offer.requesterId,
    recipientUserId: offer.recipientUserId,
    primaryGmId: offer.primaryGmId,
    accepted: Boolean(accepted),
    reason: reason ? String(reason) : null,
    createdAt: getTransferTime()
  };

  try {
    await createSocketProof(DECISION_PROOF_KIND, offer.requestId, message, game.user);
    scheduleSocketProofCleanup(game.user, DECISION_PROOF_KIND, offer.requestId, REQUEST_TIMEOUT_MS + PROOF_GRACE_MS);
    await sendSocketMessage(message);
    return true;
  } catch (error) {
    void clearSocketProof(game.user, DECISION_PROOF_KIND, offer.requestId);
    console.error(`${MODULE_ID} | money transfer decision could not be sent`, error);
    return false;
  }
}

function openIncomingMoneyTransferDialog(offer) {
  if (incomingOffers.has(offer.requestId)) return;

  const content = buildIncomingMoneyTransferDialogContent(offer);
  const state = { offer, decided: false, accepted: false, dialog: null, timeout: null };

  const expire = () => {
    closeIncomingOffer(offer.requestId);
    notifyTransferError(state.accepted ? "outcome-unknown" : "recipient-timeout");
  };

  const decide = async (accepted, reason = null) => {
    if (state.decided) return;
    const timeLeft = getOfferTimeLeft(offer);
    if (!timeLeft) {
      expire();
      return;
    }
    state.decided = true;
    state.accepted = accepted;
    globalThis.clearTimeout(state.timeout);
    if (accepted) {
      state.timeout = globalThis.setTimeout(expire, timeLeft + RESULT_GRACE_MS);
      state.timeout?.unref?.();
    }
    const sent = await sendTransferDecision(offer, accepted, reason);
    if (!incomingOffers.has(offer.requestId)) return;
    if (!sent) {
      closeIncomingOffer(offer.requestId);
      ui.notifications?.error?.(localizeTransferError("identity-proof-failed"));
    } else if (!accepted) {
      closeIncomingOffer(offer.requestId);
    }
  };

  const dialog = createFoundryDialog({
    title: qaLocalize("Wallet.Transfer.IncomingTitle", "Входящий перевод"),
    content,
    buttons: {
      accept: {
        icon: '<i class="fas fa-check"></i>',
        label: qaLocalize("Wallet.Transfer.Accept", "Принять"),
        callback: (html) => {
          disableTransferControls(extractDialogElement(html));
          return decide(true);
        }
      },
      decline: {
        icon: '<i class="fas fa-times"></i>',
        label: qaLocalize("Wallet.Transfer.Decline", "Отклонить"),
        callback: (html) => {
          disableTransferControls(extractDialogElement(html));
          return decide(false, "declined");
        }
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
  state.timeout = globalThis.setTimeout(expire, getOfferTimeLeft(offer));
  state.timeout?.unref?.();
  dialog.render(true);
}

function closeIncomingOffer(requestId) {
  const state = incomingOffers.get(requestId);
  if (!state) return;
  incomingOffers.delete(requestId);
  globalThis.clearTimeout(state.timeout);
  state.decided = true;
  void state.dialog?.close?.();
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
  if (!getOfferTimeLeft(message)) return { ok: false, error: "recipient-timeout" };
  const parties = validateTransferParties(message);
  if (!parties.ok) return parties;
  return readTransferAmounts(message.amounts);
}

function validateTransferParties(message) {
  const requester = findGameUser(message.requesterId);
  const recipient = findGameUser(message.recipientUserId);
  const sourceActor = game.actors?.get?.(message.sourceActorId);
  const targetActor = game.actors?.get?.(message.targetActorId);

  if (!requester || !recipient || !sourceActor || !targetActor) return { ok: false, error: "missing-actor" };
  if (sourceActor.id === targetActor.id) return { ok: false, error: "same-actor" };
  if (!requester.active || sourceActor.type !== "character" || sourceActor.pack
    || (!requester.isGM && !userOwnsActor(requester, sourceActor))) return { ok: false, error: "source-permission" };
  if (!recipient.active || recipient.isGM || recipient.id === requester.id || targetActor.type !== "character"
    || targetActor.pack || !userOwnsActor(recipient, targetActor)) return { ok: false, error: "invalid-recipient" };
  return { ok: true, sourceActor, targetActor };
}

function validateRecipientOffer(message) {
  if (!getOfferTimeLeft(message)) return { ok: false, error: "recipient-timeout" };
  if (message.primaryGmId !== getActiveGM()?.id || message.requesterId === message.recipientUserId
    || message.sourceActorId === message.targetActorId) return { ok: false, error: "invalid-request" };
  const recipient = game.user;
  const targetActor = game.actors?.get?.(message.targetActorId);
  if (!recipient?.active || recipient.isGM || !userOwnsActor(recipient, targetActor)) return { ok: false, error: "invalid-recipient" };
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

  const resultMessage = {
    type: RESULT_TYPE,
    requestId: offer.requestId,
    requesterId: offer.requesterId,
    recipientUserId: offer.recipientUserId,
    primaryGmId: offer.primaryGmId,
    sourceActorId: offer.sourceActorId,
    targetActorId: offer.targetActorId,
    result: completeResult,
    createdAt: getTransferTime()
  };

  const needsReview = ["partial-failure", "outcome-unknown"].includes(completeResult.error);
  if (needsReview) notifyTransferError(completeResult.error);
  if (game.socket?.connected === false) return;
  const whisper = postTransferWhisper(offer, completeResult);
  try {
    await sendAuthenticatedTransferResultWithRetry(resultMessage, game.user);
    scheduleSocketProofCleanup(game.user, RESULT_PROOF_KIND, offer.requestId, PROOF_GRACE_MS);
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer result delivery failed`, offer.requestId, error);
  }

  const requester = findGameUser(offer.requesterId);
  const recipient = findGameUser(offer.recipientUserId);
  scheduleSocketProofCleanup(requester, OFFER_PROOF_KIND, offer.requestId, PROOF_GRACE_MS);
  scheduleSocketProofCleanup(recipient, DECISION_PROOF_KIND, offer.requestId, PROOF_GRACE_MS);
  await whisper;
}

async function executeMoneyTransfer(sourceActor, targetActor, rawAmounts) {
  const plan = buildMoneyTransferPlan(sourceActor, targetActor, rawAmounts);
  if (!plan.ok) return plan;

  try {
    await writeCurrencyUpdate(sourceActor, plan.sourceUpdate);
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer debit failed`, sourceActor.id, error);
    return { ok: false, error: error?.code === "outcome-unknown" ? "outcome-unknown" : "update-failed" };
  }
  try {
    await writeCurrencyUpdate(targetActor, plan.targetUpdate);
  } catch (error) {
    console.error(`${MODULE_ID} | money transfer credit failed`, sourceActor.id, targetActor.id, plan.amounts, error);
    return { ok: false, error: error?.code === "outcome-unknown" ? "outcome-unknown" : "partial-failure", debitConfirmed: true };
  }

  globalThis.Hooks?.callAll?.("fblQuickAccess.walletTransferred", { sourceActor, targetActor, amounts: plan.amounts });
  return { ok: true, sourceActorId: sourceActor.id, targetActorId: targetActor.id,
    sourceName: sourceActor.name, targetName: targetActor.name, amounts: plan.amounts };
}

async function postTransferWhisper(offer, result) {
  if (!globalThis.ChatMessage?.create) return null;

  const model = buildTransferWhisperModel(offer, result);
  const requester = game.users?.get?.(offer.requesterId);
  const recipient = game.users?.get?.(offer.recipientUserId);
  const sourceActor = game.actors?.get?.(offer.sourceActorId);
  const targetActor = game.actors?.get?.(offer.targetActorId);
  const status = localizeWhisperStatus(model.status, result);
  const recipients = model.status === "partial" || model.status === "unknown"
    ? [offer.primaryGmId]
    : [...new Set([offer.requesterId, offer.recipientUserId, offer.primaryGmId].filter(Boolean))];

  const content = `
    <div class="fblqa-money-transfer-chat-card">
      <h3>${escapeHtml(qaLocalize("Wallet.Transfer.WhisperTitle", "Передача денег"))}</h3>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.From", "Отправитель"))}:</strong> ${escapeHtml(requester?.name ?? offer.requesterId)} — ${escapeHtml(sourceActor?.name ?? offer.sourceActorId)}</p>
      <p><strong>${escapeHtml(qaLocalize("Wallet.Transfer.To", "Получатель"))}:</strong> ${escapeHtml(recipient?.name ?? offer.recipientUserId)} — ${escapeHtml(targetActor?.name ?? offer.targetActorId)}</p>
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
        <span class="fblqa-money-transfer-abbr">${escapeHtml(getCurrencyAbbreviation(currency))}</span>
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
  const form = findTransferForm(element);
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

function findTransferForm(element) {
  const selector = "form.fblqa-money-transfer-form";
  return element?.matches?.(selector) ? element : element?.querySelector?.(selector);
}

function disableTransferControls(element) {
  const controls = element?.querySelectorAll?.("form button, form input, form select, .dialog-buttons button");
  for (const control of controls ?? []) control.disabled = true;
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

function withoutPacketId(message) {
  return Object.fromEntries(Object.entries(message ?? {}).filter(([key]) => key !== "packetId"));
}

function isValidOfferMessage(message) {
  return isValidSocketRequestId(message?.requestId)
    && message?.type === OFFER_TYPE
    && typeof message.requesterId === "string"
    && typeof message.recipientUserId === "string"
    && typeof message.primaryGmId === "string"
    && typeof message.sourceActorId === "string"
    && typeof message.targetActorId === "string"
    && message.amounts && typeof message.amounts === "object"
    && Number.isSafeInteger(message.createdAt);
}

function isValidDecisionMessage(message) {
  return isValidSocketRequestId(message?.requestId)
    && message?.type === DECISION_TYPE
    && typeof message.requesterId === "string"
    && typeof message.recipientUserId === "string"
    && typeof message.primaryGmId === "string"
    && typeof message.accepted === "boolean"
    && Number.isSafeInteger(message.createdAt);
}

function isValidResultMessage(message) {
  return isValidSocketRequestId(message?.requestId)
    && message?.type === RESULT_TYPE
    && typeof message.requesterId === "string"
    && typeof message.recipientUserId === "string"
    && typeof message.primaryGmId === "string"
    && typeof message.sourceActorId === "string"
    && typeof message.targetActorId === "string"
    && message.result && typeof message.result === "object"
    && Number.isSafeInteger(message.createdAt);
}

function getOfferTimeLeft(offer) {
  return Math.max(0, offer.createdAt + REQUEST_TIMEOUT_MS - getTransferTime());
}

function getTransferTime() {
  const serverTime = globalThis.game?.time?.serverTime;
  return Math.round(Number.isFinite(serverTime) && serverTime > 0 ? serverTime : Date.now());
}

function formatTransferAmounts(amounts) {
  return CURRENCIES
    .map((currency) => ({ currency, value: Math.max(0, Math.floor(Number(amounts?.[currency.key]) || 0)) }))
    .filter(({ value }) => value > 0)
    .map(({ currency, value }) => `${value} ${getCurrencyAbbreviation(currency)}`)
    .join(", ") || qaLocalize("Wallet.Transfer.Nothing", "ничего");
}

function localizeTransferError(code) {
  const key = {
    "missing-actor": "MissingActor",
    "same-actor": "SameActor",
    "empty-amount": "EmptyAmount",
    "invalid-amount": "InvalidAmount",
    "invalid-balance": "InvalidBalance",
    "amount-overflow": "AmountOverflow",
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
    "identity-proof-failed": "IdentityProofFailed",
    "outcome-unknown": "UnknownOutcome",
    "partial-failure": "PartialFailure",
    "update-failed": "UpdateFailed"
  }[code] ?? "UnknownError";
  const fallback = code === "outcome-unknown"
    ? "Исход перевода неизвестен. Перед повтором проверьте оба кошелька вручную."
    : code === "partial-failure"
      ? "Списание подтверждено, но зачисление не завершилось. Проверьте оба кошелька вручную."
      : "Не удалось передать деньги.";
  return qaLocalize(`Wallet.Transfer.${key}`, fallback);
}

function notifyTransferError(code) {
  const message = localizeTransferError(code);
  if (code === "outcome-unknown") globalThis.ui?.notifications?.warn?.(message);
  else globalThis.ui?.notifications?.error?.(message);
}

function localizeWhisperStatus(status, result) {
  if (status === "completed") return qaLocalize("Wallet.Transfer.StatusCompleted", "Принято и выполнено");
  if (status === "declined") return qaLocalize("Wallet.Transfer.StatusDeclined", "Отклонено получателем");
  if (status === "expired") return qaLocalize("Wallet.Transfer.StatusExpired", "Истекло время ожидания");
  if (status === "partial") return localizeTransferError("partial-failure");
  if (status === "unknown") {
    return result.debitConfirmed
      ? qaLocalize("Wallet.Transfer.CreditUnknown", "Списание подтверждено. Исход зачисления неизвестен. Перед повтором проверьте оба кошелька вручную.")
      : localizeTransferError("outcome-unknown");
  }
  return qaLocalize("Wallet.Transfer.StatusFailed", "Не выполнено: {reason}", {
    reason: localizeTransferError(result?.error)
  });
}

async function verifyTransferProof(user, kind, requestId, payload) {
  const result = await verifySocketProofWithRetry(user, kind, requestId, payload, {
    ttlMs: REQUEST_TIMEOUT_MS + PROOF_GRACE_MS,
    retries: 2,
    retryDelayMs: 40
  });
  if (!result.ok) {
    console.warn(`${MODULE_ID} | money transfer proof rejected`, requestId, kind, result.error);
  }
  return result;
}

async function sendAuthenticatedTransferResultWithRetry(payload, user, attempts = 2) {
  let lastError = null;
  const maximumAttempts = Math.max(1, Math.min(3, Math.floor(Number(attempts) || 2)));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await createSocketProof(RESULT_PROOF_KIND, payload.requestId, payload, user);
      await sendSocketMessage(payload);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maximumAttempts) await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
    }
  }
  throw lastError ?? new Error("Socket result delivery failed");
}

async function sendSocketMessage(payload) {
  const message = { ...payload, packetId: payload.packetId ?? makeSocketRequestId() };
  if (game.socket?.connected === false || !game.socket?.emit) throw new Error("Foundry socket is unavailable");
  await handleSocketMessage(message);
  if (game.socket.connected === false) throw new Error("Foundry socket disconnected");
  game.socket.emit(SOCKET_CHANNEL, message);
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
