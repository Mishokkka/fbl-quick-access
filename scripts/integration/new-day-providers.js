import { MODULE_ID } from "../constants.js";
import { escapeHtml, humanizeKey } from "../utils.js";
import { executeAsActiveGM, getActiveGM, registerSocketHandler } from "./socket-api.js";
import { createObjectOperationQueue } from "../operation-queue.js";
import { createCodedError, plainValuesEqual } from "../document-writes.js";
import { findGameUser } from "../socket-utils.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const FA_NON_ICON_CLASSES = new Set([
  "fa-solid", "fa-regular", "fa-light", "fa-thin", "fa-duotone", "fa-brands", "fa-sharp",
  "fa-fw", "fa-lg", "fa-sm", "fa-xs", "fa-xl", "fa-2x", "fa-3x", "fa-spin", "fa-pulse", "fa-beat", "fa-fade", "fa-bounce"
]);
const BUILD_OPERATION = "integration.new-day.build-provider";
const APPLY_OPERATION = "integration.new-day.apply-provider";
const providers = new Map();
const enqueueProviderApply = createObjectOperationQueue();
let bridgeRegistered = false;

export function registerNewDayProvider(definition) {
  const provider = normalizeNewDayProvider(definition);
  if (providers.has(provider.id)) throw new Error(`New-day provider is already registered: ${provider.id}`);

  providers.set(provider.id, provider);
  globalThis.Hooks?.callAll?.("fblQuickAccess.newDayProviderRegistered", provider.id);

  return () => {
    if (providers.get(provider.id) !== provider) return false;
    providers.delete(provider.id);
    globalThis.Hooks?.callAll?.("fblQuickAccess.newDayProviderUnregistered", provider.id);
    return true;
  };
}

export function initializeNewDayProviderBridge() {
  if (bridgeRegistered) return;
  registerSocketHandler(BUILD_OPERATION, handleBuildProviderActions);
  registerSocketHandler(APPLY_OPERATION, handleApplyProviderAction);
  bridgeRegistered = true;
}

export function getNewDayProviders() {
  return Array.from(providers.values()).sort(compareProviders);
}

export function getNewDayProvider(id) {
  return providers.get(String(id ?? "")) ?? null;
}

/** Build public-safe actions on the active GM, where hidden documents exist. */
export async function buildNewDayProviderActions(actor) {
  const actions = [];
  const errors = [];

  for (const provider of getNewDayProviders()) {
    try {
      const rawActions = await executeAsActiveGM(BUILD_OPERATION, {
        providerId: provider.id,
        actorUuid: actor?.uuid ?? "",
        actorId: actor?.id ?? ""
      });
      const normalized = normalizeProviderActions(provider, rawActions);
      actions.push(...normalized);
    } catch (error) {
      errors.push({ providerId: provider.id, error: String(error?.message ?? error) });
      console.error(`${MODULE_ID} | new-day provider action build failed`, provider.id, error);
    }
  }

  return { actions, errors };
}

export async function applyNewDayProviderAction(actor, action, options = {}) {
  const provider = getNewDayProvider(action?.providerId);
  if (!provider) throw new Error(`Missing new-day provider: ${action?.providerId ?? "<empty>"}`);

  return executeAsActiveGM(APPLY_OPERATION, {
    providerId: provider.id,
    actorUuid: actor?.uuid ?? "",
    actorId: actor?.id ?? "",
    action: action.providerAction ?? stripQuickAccessActionFields(action),
    actionId: action.providerActionId,
    suppressChat: Boolean(options.suppressChat)
  });
}

export function describeNewDayProviderAction(action) {
  const provider = getNewDayProvider(action?.providerId);
  if (!provider) return String(action?.detail ?? action?.description ?? "");
  try {
    const value = provider.describeAction(action.providerAction ?? action);
    if (value && typeof value.then !== "function") return String(value);
  } catch (error) {
    console.error(`${MODULE_ID} | new-day provider description failed`, provider.id, error);
  }
  return String(action?.detail ?? action?.description ?? "");
}

export function getNewDayProviderIcon(action) {
  const provider = getNewDayProvider(action?.providerId);
  if (!provider) return "fa-check";
  try {
    const value = provider.icon(action.providerAction ?? action);
    if (value && typeof value.then !== "function") return normalizeIcon(value);
  } catch (error) {
    console.error(`${MODULE_ID} | new-day provider icon failed`, provider.id, error);
  }
  return "fa-check";
}

export function getNewDayProviderCategory(providerOrId) {
  const provider = typeof providerOrId === "string" ? getNewDayProvider(providerOrId) : providerOrId;
  if (!provider) return null;

  let label = provider.categoryLabel;
  if (typeof label === "function") {
    try {
      label = label({ id: provider.category, providerId: provider.id });
    } catch (error) {
      console.error(`${MODULE_ID} | new-day provider category label failed`, provider.id, error);
      label = null;
    }
  }

  return {
    id: provider.category,
    order: provider.order,
    label: String(label || humanizeKey(provider.category) || provider.category)
  };
}

export function normalizeNewDayProvider(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("New-day provider definition is required");
  const id = String(definition.id ?? "").trim();
  const category = String(definition.category ?? "").trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new TypeError(`Invalid new-day provider id: ${id || "<empty>"}`);
  if (!PROVIDER_ID_PATTERN.test(category)) throw new TypeError(`Invalid new-day category id: ${category || "<empty>"}`);
  for (const method of ["buildActions", "applyAction", "describeAction", "icon"]) {
    if (typeof definition[method] !== "function") throw new TypeError(`New-day provider ${id} requires ${method}()`);
  }
  if (definition.categoryLabel !== undefined && typeof definition.categoryLabel !== "string" && typeof definition.categoryLabel !== "function") {
    throw new TypeError(`New-day provider ${id} categoryLabel must be a string or function`);
  }

  return Object.freeze({
    id,
    category,
    order: finiteOrder(definition.order),
    buildActions: definition.buildActions,
    applyAction: definition.applyAction,
    describeAction: definition.describeAction,
    icon: definition.icon,
    categoryLabel: definition.categoryLabel ?? null
  });
}

export function normalizeProviderActions(provider, rawActions) {
  if (!Array.isArray(rawActions)) {
    if (rawActions === null || rawActions === undefined) return [];
    throw new TypeError(`New-day provider ${provider.id} buildActions() must return an array`);
  }

  const seenIds = new Set();
  return rawActions.map((rawAction, index) => {
    if (!rawAction || typeof rawAction !== "object") {
      throw new TypeError(`New-day provider ${provider.id} returned a non-object action at index ${index}`);
    }
    const rawId = normalizeProviderActionId(rawAction.id, index);
    if (seenIds.has(rawId)) {
      throw createCodedError("duplicate-provider-action", `New-day provider ${provider.id} returned duplicate action id: ${rawId}`);
    }
    seenIds.add(rawId);
    const itemName = String(rawAction.itemName ?? rawAction.label ?? rawAction.name ?? provider.id);
    const rawCategory = String(rawAction.category ?? "").trim();
    const category = rawCategory && PROVIDER_ID_PATTERN.test(rawCategory) ? rawCategory : provider.category;

    return {
      ...rawAction,
      id: `provider:${provider.id}:${rawId}`,
      providerId: provider.id,
      providerActionId: rawId,
      providerAction: rawAction,
      kind: String(rawAction.kind ?? "provider-action"),
      category,
      categoryOrder: Number.isFinite(Number(rawAction.categoryOrder)) ? Number(rawAction.categoryOrder) : provider.order,
      providerOrder: provider.order,
      itemName,
      checked: rawAction.checked !== false,
      warning: Boolean(rawAction.warning)
    };
  });
}

function normalizeProviderActionId(value, index) {
  return String(value ?? "").trim() || String(index);
}

async function handleBuildProviderActions(payload, context) {
  const provider = requireProvider(payload?.providerId);
  const actor = await resolveActor(payload);
  assertRequesterCanManageActor(actor, context.requestUser);

  const actions = await provider.buildActions(actor, Object.freeze({
    requesterId: context.requesterId,
    requestUser: context.requestUser,
    activeGM: context.activeGM,
    isRemote: context.isRemote
  }));
  return actions ?? [];
}

async function handleApplyProviderAction(payload, context) {
  const provider = requireProvider(payload?.providerId);
  const actor = await resolveActor(payload);
  assertRequesterCanManageActor(actor, context.requestUser);

  return enqueueProviderApply(actor, async () => {
    assertCurrentProvider(provider);
    const requestUser = requireLiveApplyAuthority(actor, context);
    const buildContext = Object.freeze({
      requesterId: context.requesterId,
      requestUser,
      activeGM: context.activeGM,
      isRemote: context.isRemote
    });
    const rawActions = await provider.buildActions(actor, buildContext);
    assertCurrentProvider(provider);
    const freshActions = normalizeProviderActions(provider, rawActions);
    const actionId = normalizeProviderActionId(payload?.actionId ?? payload?.action?.id, 0);
    const action = freshActions.find(candidate => candidate.providerActionId === actionId)?.providerAction;
    const liveUser = requireLiveApplyAuthority(actor, context);
    if (!action || !plainValuesEqual(action, payload.action)) {
      throw createCodedError("stale-provider-action", "Provider action changed. Refresh the preview.");
    }
    const liveContext = Object.freeze({
      ...buildContext,
      requestUser: liveUser,
      suppressChat: Boolean(payload?.suppressChat) && liveUser.isGM && !context.isRemote
    });
    const result = await provider.applyAction(actor, action, liveContext) ?? {};

    const normalized = {
      changed: Boolean(result.changed),
      summary: String(result.summary ?? "")
    };

    if (result.privateSummary) {
      if (!liveContext.suppressChat) await postPrivateSummary(actor, provider, String(result.privateSummary));
      if (liveUser.isGM && !context.isRemote) normalized.privateSummary = String(result.privateSummary);
    }

    return normalized;
  });
}

function assertCurrentProvider(provider) {
  if (getNewDayProvider(provider.id) !== provider) {
    throw createCodedError("provider-registration-changed", `New-day provider registration changed: ${provider.id}`);
  }
}

function requireLiveApplyAuthority(actor, context) {
  // Foundry can resolve live non-compendium documents synchronously. Keep the
  // authority and action checks in the same turn as dispatch.
  const fromUuidSync = globalThis.foundry?.utils?.fromUuidSync ?? globalThis.fromUuidSync;
  const liveActor = actor.uuid && fromUuidSync
    ? fromUuidSync(actor.uuid)
    : globalThis.game?.actors?.get?.(actor.id);
  if (liveActor !== actor) {
    throw createCodedError("missing-actor", "New-day provider actor changed");
  }
  if (getActiveGM()?.id !== globalThis.game?.user?.id) {
    throw createCodedError("active-gm-only", "Active GM changed");
  }
  const user = findGameUser(context.requesterId);
  assertRequesterCanManageActor(actor, user);
  return user;
}

function requireProvider(id) {
  const provider = getNewDayProvider(id);
  if (!provider) {
    const error = new Error(`Unknown new-day provider: ${id ?? "<empty>"}`);
    error.code = "unknown-provider";
    throw error;
  }
  return provider;
}

async function resolveActor(payload) {
  let actor = null;
  if (payload?.actorUuid && globalThis.fromUuid) {
    actor = await fromUuid(payload.actorUuid);
  }
  if (actor?.documentName !== "Actor" && payload?.actorId) {
    actor = globalThis.game?.actors?.get?.(payload.actorId) ?? null;
  }
  if (actor?.documentName !== "Actor" || actor?.pack) {
    const error = new Error("New-day provider actor was not found");
    error.code = "missing-actor";
    throw error;
  }
  return actor;
}

function assertRequesterCanManageActor(actor, user) {
  if (!user || user.active === false) {
    const error = new Error("Requesting user was not found");
    error.code = "missing-requester";
    throw error;
  }
  if (user.isGM) return;
  const allowed = typeof actor.testUserPermission === "function"
    ? actor.testUserPermission(user, "OWNER")
    : Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0) >= 3;
  if (allowed) return;

  const error = new Error(`User ${user.id} cannot manage actor ${actor.id}`);
  error.code = "actor-permission";
  throw error;
}

async function postPrivateSummary(actor, provider, privateSummary) {
  if (!privateSummary || !globalThis.ChatMessage?.create) return null;
  const recipients = Array.from(globalThis.game?.users ?? [])
    .filter((user) => user?.isGM)
    .map((user) => user.id);
  if (!recipients.length) return null;

  const heading = getNewDayProviderCategory(provider)?.label || provider.id;
  const content = `
    <div class="fblqa-rest-chat-card fblqa-new-day-chat-card fblqa-new-day-private-card">
      <h3>${escapeHtml(heading)}</h3>
      <p>${escapeHtml(privateSummary)}</p>
    </div>`;
  try {
    return await ChatMessage.create({
      speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }) ?? undefined,
      content,
      whisper: recipients
    });
  } catch (error) {
    console.error(`${MODULE_ID} | could not post provider private summary`, provider.id, error);
    return null;
  }
}

function stripQuickAccessActionFields(action) {
  const copy = { ...action };
  for (const key of ["providerId", "providerActionId", "providerAction", "providerOrder", "categoryOrder"]) delete copy[key];
  return copy;
}

function normalizeIcon(value) {
  const icon = String(value ?? "")
    .trim()
    .split(/\s+/)
    .find((part) => /^fa-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part) && !FA_NON_ICON_CLASSES.has(part));
  return icon || "fa-check";
}

function compareProviders(a, b) {
  return a.order - b.order || a.id.localeCompare(b.id);
}

function finiteOrder(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 500;
}
