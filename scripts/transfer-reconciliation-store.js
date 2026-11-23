import { CURRENCIES, FLAG_MONEY_TRANSFER_RECONCILIATIONS, MODULE_ID, SETTINGS } from "./constants.js";
import { clearDocumentFlagNullVerified, createCodedError, plainValuesEqual, readDocumentFlag } from "./document-writes.js";
import { isValidSocketRequestId } from "./socket-utils.js";

const RESOLVED_HISTORY_LIMIT = 50;

function reconciliationStorage() {
  const { user, world } = globalThis.game ?? {};
  const storage = globalThis.localStorage;
  if (!user?.isGM || !user.id || !world?.id || !storage) {
    throw createCodedError("reconciliation-storage-unavailable", "GM browser reconciliation storage is unavailable");
  }
  const key = `${MODULE_ID}.reconciliation:${JSON.stringify([world.id, user.id])}`;
  return { storage, key };
}

export function readReconciliationRecords() {
  const { storage, key } = reconciliationStorage();
  const raw = storage.getItem(key);
  const records = raw === null ? {} : JSON.parse(raw);
  return Object.fromEntries(reconciliationEntries(records));
}

export function writeReconciliationRecords(records, { limitHistory = true } = {}) {
  const { storage, key } = reconciliationStorage();
  const entries = reconciliationEntries(records);
  const resolved = entries.filter(([, record]) => record.status === "resolved")
    .sort(([, left], [, right]) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt));
  const saved = limitHistory ? Object.fromEntries([
    ...entries.filter(([, record]) => record.status !== "resolved"),
    ...resolved.slice(0, RESOLVED_HISTORY_LIMIT)
  ]) : records;
  storage.setItem(key, JSON.stringify(saved));
  if (!plainValuesEqual(readReconciliationRecords(), saved)) {
    throw createCodedError("reconciliation-not-persisted", "Money transfer reconciliation was not saved");
  }
}

function reconciliationEntries(records) {
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw createCodedError("reconciliation-invalid", "Invalid money transfer reconciliation store");
  }
  const entries = Object.entries(records);
  for (const [id, record] of entries) {
    if (!isValidSocketRequestId(id) || record?.requestId !== id || !Number.isFinite(record.createdAt)
      || !["applying", "pending", "resolved"].includes(record.status)
      || !isWalletReconciliation(record.source) || !isWalletReconciliation(record.target)) {
      throw createCodedError("reconciliation-invalid", `Invalid money transfer reconciliation ${id}`);
    }
  }
  return entries;
}

function isWalletReconciliation(wallet) {
  return ["before", "expected", "observed"].every(field => CURRENCIES.every(({ key }) => {
    const amount = wallet?.[field]?.[key];
    return Number.isSafeInteger(amount) && amount >= 0;
  }));
}

export async function migrateLegacyReconciliations() {
  const key = SETTINGS.MONEY_TRANSFER_RECONCILIATIONS;
  const legacySetting = game.settings.get(MODULE_ID, key) ?? {};
  const legacyFlags = Array.from(game.users ?? [])
    .filter(user => user.isGM)
    .map(user => ({ user, records: readDocumentFlag(user, MODULE_ID, FLAG_MONEY_TRANSFER_RECONCILIATIONS) }))
    .filter(({ records }) => records != null);
  const settingEntries = reconciliationEntries(legacySetting);
  const imports = new Map(settingEntries);
  for (const { records } of legacyFlags) {
    for (const [id, record] of reconciliationEntries(records)) {
      imports.set(id, mergeLegacyRecord(imports.get(id), record));
    }
  }
  if (imports.size) {
    const local = readReconciliationRecords();
    for (const [id, record] of imports) local[id] = mergeLegacyRecord(local[id], record, { local: true });
    writeReconciliationRecords(local, { limitHistory: false });
  }
  let cleanupFailed = false;
  if (settingEntries.length) {
    try {
      await game.settings.set(MODULE_ID, key, {});
      cleanupFailed = reconciliationEntries(game.settings.get(MODULE_ID, key) ?? {}).length > 0;
    } catch (_error) {
      cleanupFailed = true;
    }
  }
  for (const { user } of legacyFlags) {
    try {
      await clearDocumentFlagNullVerified(user, MODULE_ID, FLAG_MONEY_TRANSFER_RECONCILIATIONS);
    } catch (_error) {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw createCodedError("reconciliation-cleanup-incomplete", "Some legacy reconciliation records could not be removed from the world");
}

function mergeLegacyRecord(existing, incoming, { local = false } = {}) {
  if (!existing) return incoming;
  if (plainValuesEqual(existing, incoming)) return existing;

  const samePlan = ["sourceActorId", "targetActorId"].every(key => existing[key] === incoming[key])
    && ["source", "target"].every(side => ["before", "expected"].every(key =>
      plainValuesEqual(existing[side][key], incoming[side][key])));
  if (local && existing.status === "resolved" && samePlan) return existing;
  const { legacyAlternatives: alternatives = [], ...other } = incoming;
  const candidates = [...(existing.legacyAlternatives ?? [])];
  for (const candidate of [other, ...alternatives]) {
    if (!candidates.some(value => plainValuesEqual(value, candidate))) candidates.push(candidate);
  }
  return { ...existing, status: "pending", requiresReview: true, legacyAlternatives: candidates };
}
