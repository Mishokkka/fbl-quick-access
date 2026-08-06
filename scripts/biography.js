import { FLAG_BIOGRAPHY_PROFILE, MODULE_ID } from "./constants.js";
import { qaLocalize } from "./i18n.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { applyPilgrimCardFont, getPilgrimCardFontFamily } from "./settings.js";
import { findApplicationRoot, findBiographyTab } from "./sheet-adapter/forbidden-lands-v1.js";
import { escapeHtml, stripHtml } from "./utils.js";

const PROFILE_VERSION = 1;
const QUESTION_FIELDS = Object.freeze([
  ["bestFriend", "Bio.Questions.BestFriend", "Лучший друг или самый близкий человек"],
  ["favoriteFood", "Bio.Questions.FavoriteFood", "Любимое блюдо и причина"],
  ["prejudices", "Bio.Questions.Prejudices", "Предубеждения о расах и видах"],
  ["aristocracy", "Bio.Questions.Aristocracy", "Отношение к аристократии"],
  ["favoriteMemory", "Bio.Questions.FavoriteMemory", "Любимое воспоминание"],
  ["oneWish", "Bio.Questions.OneWish", "Одно желание"],
  ["greatestFear", "Bio.Questions.GreatestFear", "Самый большой страх"],
  ["notes", "Bio.Questions.Notes", "Дополнительные ответы и заметки"]
]);
const LANGUAGE_LEVELS = Object.freeze({
  basic: ["Bio.LanguageLevels.Basic", "Базовый"],
  full: ["Bio.LanguageLevels.Full", "Полный"],
  academic: ["Bio.LanguageLevels.Academic", "Академический"]
});
const DRAWERS = new Map();
const SAVE_TIMERS = new Map();
const SAVE_CHAINS = new Map();
const COLLAPSED_SECTIONS = new Map();
const FLOATING_ACTIONS = new WeakMap();
const ACTIVE_RICH_EDITORS = new WeakMap();
const BIO_SCROLL_POSITIONS = new Map();
const BIO_VIEWPORT_TRACKERS = new WeakMap();
const LANGUAGE_LAYOUT_FRAMES = new WeakMap();
const LANGUAGE_LAYOUT_OBSERVERS = new WeakMap();

export function normalizeBiographyProfile(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const identity = source.identity && typeof source.identity === "object" ? source.identity : {};
  const physical = source.physical && typeof source.physical === "object" ? source.physical : {};
  const questions = source.questions && typeof source.questions === "object" ? source.questions : {};
  const legacy = source.legacy && typeof source.legacy === "object" ? source.legacy : {};

  return {
    version: PROFILE_VERSION,
    identity: {
      name: String(identity.name ?? source.name ?? ""),
      kin: String(identity.kin ?? ""),
      kinVariant: String(identity.kinVariant ?? identity.subrace ?? ""),
      profession: String(identity.profession ?? ""),
      issuingCountry: String(identity.issuingCountry ?? identity.country ?? identity.citizenship ?? ""),
      origin: String(identity.origin ?? ""),
      religion: String(identity.religion ?? ""),
      birthDate: normalizeBirthDate(identity.birthDate)
    },
    concept: String(source.concept ?? ""),
    pride: String(source.pride ?? ""),
    darkSecret: String(source.darkSecret ?? ""),
    physical: {
      appearance: String(physical.appearance ?? source.appearance ?? ""),
      height: String(physical.height ?? ""),
      weight: String(physical.weight ?? ""),
      skin: String(physical.skin ?? ""),
      eyes: String(physical.eyes ?? ""),
      hair: String(physical.hair ?? ""),
      distinguishingMarks: String(physical.distinguishingMarks ?? physical.marks ?? "")
    },
    background: String(source.background ?? ""),
    family: String(source.family ?? ""),
    motivation: String(source.motivation ?? ""),
    partyConnections: String(source.partyConnections ?? source.connections ?? ""),
    publicNote: String(source.publicNote ?? source.note ?? ""),
    languages: normalizeLanguages(source.languages),
    questions: Object.fromEntries(QUESTION_FIELDS.map(([key]) => [key, String(questions[key] ?? "")])),
    rumors: normalizeRumors(source.rumors),
    legacy: {
      face: String(legacy.face ?? ""),
      body: String(legacy.body ?? ""),
      clothing: String(legacy.clothing ?? "")
    }
  };
}

export function getBiographyProfile(actor) {
  const stored = actor?.getFlag?.(MODULE_ID, FLAG_BIOGRAPHY_PROFILE);
  let profile;
  if (stored && typeof stored === "object") profile = normalizeBiographyProfile(stored);
  else profile = profileFromActor(actor);

  profile.identity.name = String(actor?.name ?? profile.identity.name ?? "");
  profile.identity.kin ||= plainActorBio(actor, "kin");
  profile.identity.profession ||= plainActorBio(actor, "profession");
  profile.pride ||= actorBioHtml(actor, "pride");
  profile.darkSecret ||= actorBioHtml(actor, "darkSecret");
  profile.publicNote ||= actorBioHtml(actor, "note");

  // Keep the original BIO fields available even after the Quick Access profile
  // has already been saved once.
  profile.legacy.face ||= actorBioHtml(actor, "face");
  profile.legacy.body ||= actorBioHtml(actor, "body");
  profile.legacy.clothing ||= actorBioHtml(actor, "clothing");
  return profile;
}

export async function saveBiographyProfile(actor, value, { render = false } = {}) {
  if (!actor?.update) return false;
  const profile = sanitizeBiographyProfile(normalizeBiographyProfile(value));
  profile.identity.name = String(profile.identity.name || actor.name || "").trim();

  const update = {
    [`flags.${MODULE_ID}.${FLAG_BIOGRAPHY_PROFILE}`]: profile,
    "system.bio.kin.value": profile.identity.kin,
    "system.bio.profession.value": profile.identity.profession,
    "system.bio.pride.value": normalizeRichText(profile.pride),
    "system.bio.darkSecret.value": normalizeRichText(profile.darkSecret),
    "system.bio.note.value": normalizeRichText(profile.publicNote)
  };
  if (profile.identity.name && profile.identity.name !== actor.name) update.name = profile.identity.name;
  await actor.update(update, { render });
  return true;
}

export function setupBiographyTab(app, actor, root) {
  const bioTab = findBiographyTab(root);
  if (!(bioTab instanceof HTMLElement)) return null;

  const nativePrideRoll = captureNativePrideRoll(bioTab);
  const headingSpec = captureNativeHeadingSpec(bioTab);
  bioTab.classList.add("fblqa-biography-tab");
  const editable = canModifyActor(actor);
  const state = getBiographyProfile(actor);

  const render = () => {
    commitActiveRichEditor(bioTab);
    const viewport = captureBiographyViewport(bioTab, actor);
    cleanupBiographyMount(bioTab);
    bioTab.innerHTML = biographyHtml(actor, state, editable, headingSpec);
    bioTab.dataset.fblqaBiographyMounted = "true";
    mountNativePrideRoll(bioTab, nativePrideRoll);
    bindBiographyInteractions({ app, actor, root, bioTab, state, editable, render });
    restoreBiographyViewport(bioTab, actor, viewport);
  };
  render();
  return bioTab;
}

export function cleanupBiographyTab(root) {
  const bioTab = findBiographyTab(root);
  if (!(bioTab instanceof HTMLElement)) return false;
  cleanupBiographyMount(bioTab);
  commitActiveRichEditor(bioTab);
  return true;
}

export function releaseBiographyState(actorOrId) {
  const key = typeof actorOrId === "string" ? actorOrId : drawerKey(actorOrId);
  closeBiographyDrawer(key);
  const timer = SAVE_TIMERS.get(key);
  if (timer) globalThis.clearTimeout?.(timer);
  SAVE_TIMERS.delete(key);
  SAVE_CHAINS.delete(key);
  COLLAPSED_SECTIONS.delete(key);
  BIO_SCROLL_POSITIONS.delete(key);
}

export function closeBiographyDrawer(actorOrId) {
  const key = typeof actorOrId === "string" ? actorOrId : drawerKey(actorOrId);
  const record = DRAWERS.get(key);
  if (!record) return;
  const drawer = record.element ?? record;
  record.cleanup?.();
  drawer.classList.remove("is-open");
  window.setTimeout(() => drawer.remove(), 180);
  DRAWERS.delete(key);
}

function profileFromActor(actor) {
  const imported = actor?.getFlag?.("air-islands-character-importer", "profile");
  const bio = imported?.biography ?? {};
  const identity = imported?.identity ?? {};
  const legacyFace = actorBioHtml(actor, "face");
  const legacyBody = actorBioHtml(actor, "body");
  const legacyClothing = actorBioHtml(actor, "clothing");

  return normalizeBiographyProfile({
    identity: {
      name: actor?.name ?? "",
      kin: plainActorBio(actor, "kin"),
      kinVariant: identity.kinVariantName ?? identity.kinVariantId ?? "",
      profession: plainActorBio(actor, "profession"),
      issuingCountry: identity.citizenship ?? identity.originName ?? identity.originId ?? "",
      origin: identity.originName ?? identity.originId ?? "",
      religion: identity.religionName ?? identity.religionId ?? "",
      birthDate: identity.birthDate ?? ""
    },
    concept: bio.concept,
    pride: bio.pride ?? actorBioHtml(actor, "pride"),
    darkSecret: bio.darkSecret ?? actorBioHtml(actor, "darkSecret"),
    appearance: bio.appearance || legacyFace,
    physical: bio.physical,
    background: bio.background,
    family: bio.family,
    motivation: bio.motivation,
    partyConnections: bio.partyConnections,
    publicNote: bio.publicNote ?? actorBioHtml(actor, "note"),
    languages: (imported?.languages ?? []).map((entry) => ({
      id: makeId("lang"),
      languageId: entry.languageId ?? "",
      name: entry.name ?? entry.languageId ?? "",
      level: entry.level ?? "basic",
      cost: entry.cost ?? 0,
      native: Boolean(entry.native)
    })),
    questions: bio.questions,
    rumors: bio.rumors,
    legacy: {
      face: bio.appearance ? legacyFace : "",
      body: legacyBody,
      clothing: bio.background ? legacyClothing : ""
    }
  });
}

function biographyHtml(actor, profile, editable, headingSpec) {
  const disabled = editable ? "" : " disabled";
  const questionFields = QUESTION_FIELDS.map(([key, localizationKey, fallback]) => fieldEditor(
    actor,
    `questions.${key}`,
    t(localizationKey, fallback),
    profile.questions[key],
    disabled,
    {
      headingSpec,
      sectionKey: `question-${key}`,
      subheading: true
    }
  )).join("");
  const legacyVisible = Object.values(profile.legacy).some((value) => richTextHasContent(value));
  const addLanguage = editable ? iconButton({
    action: "add-language",
    icon: "fa-plus",
    label: t("Bio.Languages.Add", "Добавить язык")
  }) : "";
  const addRumor = editable ? iconButton({
    action: "add-rumor",
    icon: "fa-plus",
    label: t("Bio.Rumors.Add", "Добавить слух")
  }) : "";

  const languagesCollapsed = isSectionCollapsed(actor, "languages");
  const questionsCollapsed = isSectionCollapsed(actor, "questions");
  const rumorsCollapsed = isSectionCollapsed(actor, "rumors");

  return `
    <div class="fblqa-bio-shell ${editable ? "" : "is-readonly"}">
      <div class="fblqa-bio-actions" data-bio-floating-actions>
        ${legacyVisible ? `<button type="button" class="fblqa-archive-trigger" data-bio-action="archive" aria-expanded="false"><i class="fa-solid fa-box-archive"></i><span>${escapeHtml(t("Bio.Archive.Button", "Архив BIO"))}</span></button>` : ""}
        <button type="button" class="fblqa-pilgrim-trigger" data-bio-action="pilgrim"><i class="fa-solid fa-id-card"></i><span>${escapeHtml(t("Bio.Pilgrim.Button", "Карта пилигрима"))}</span></button>
      </div>

      <div class="fblqa-bio-stack">
        ${fieldEditor(actor, "pride", t("Bio.Fields.Pride", "Гордость"), profile.pride, disabled, {
          headingSpec,
          sectionKey: "pride",
          actionHtml: '<span class="fblqa-pride-roll-slot" data-bio-pride-roll-slot></span>',
          actionBeforeTitle: true
        })}
        ${fieldEditor(actor, "darkSecret", t("Bio.Fields.DarkSecret", "Тёмный секрет"), profile.darkSecret, disabled, { headingSpec, sectionKey: "dark-secret" })}
        ${fieldEditor(actor, "background", t("Bio.Fields.Background", "Предыстория"), profile.background, disabled, { headingSpec, sectionKey: "background" })}
        ${fieldEditor(actor, "family", t("Bio.Fields.Family", "Семья"), profile.family, disabled, { headingSpec, sectionKey: "family" })}
        ${fieldEditor(actor, "motivation", t("Bio.Fields.Motivation", "Мотивация к приключениям"), profile.motivation, disabled, { headingSpec, sectionKey: "motivation" })}
        ${fieldEditor(actor, "partyConnections", t("Bio.Fields.PartyConnections", "Связь с группой"), profile.partyConnections, disabled, { headingSpec, sectionKey: "party-connections" })}

        <section class="fblqa-bio-block fblqa-language-section" data-bio-section="languages">
          ${headingHtml(t("Bio.Languages.Title", "Языки"), headingSpec, addLanguage, {
            sectionKey: "languages",
            collapsed: languagesCollapsed
          })}
          <div class="fblqa-bio-section-body" data-bio-section-body="languages"${languagesCollapsed ? " hidden" : ""}>
            <div class="fblqa-bio-list fblqa-language-list">
              ${profile.languages.length
                ? profile.languages.map((entry, index) => languageRow(entry, index, editable)).join("")
                : `<p class="fblqa-bio-empty">${escapeHtml(t("Bio.Languages.Empty", "Языки не записаны."))}</p>`}
            </div>
          </div>
        </section>

        <section class="fblqa-bio-block fblqa-questions-section" data-bio-section="questions">
          ${headingHtml(t("Bio.Questions.Title", "Ответы на вопросы"), headingSpec, "", {
            sectionKey: "questions",
            collapsed: questionsCollapsed
          })}
          <div class="fblqa-bio-section-body fblqa-question-list" data-bio-section-body="questions"${questionsCollapsed ? " hidden" : ""}>
            ${questionFields}
          </div>
        </section>

        <section class="fblqa-bio-block fblqa-rumor-section" data-bio-section="rumors">
          ${headingHtml(t("Bio.Rumors.Title", "Слухи"), headingSpec, addRumor, {
            sectionKey: "rumors",
            collapsed: rumorsCollapsed
          })}
          <div class="fblqa-bio-section-body" data-bio-section-body="rumors"${rumorsCollapsed ? " hidden" : ""}>
            <div class="fblqa-bio-list fblqa-rumor-list">
              ${profile.rumors.length
                ? profile.rumors.map((entry, index) => rumorRow(entry, index, editable)).join("")
                : `<p class="fblqa-bio-empty">${escapeHtml(t("Bio.Rumors.Empty", "Слухи не записаны."))}</p>`}
            </div>
          </div>
        </section>
      </div>

      ${legacyVisible ? legacySection(profile.legacy, headingSpec) : ""}
    </div>`;
}

function bindBiographyInteractions({ actor, root, bioTab, state, editable, render }) {
  bindSimpleControls(bioTab, actor, state, editable, null);
  bindRichEditors(bioTab, actor, state, editable, null);
  bindSectionToggles(bioTab, actor);
  setupFloatingBiographyActions(bioTab);
  setupBiographyViewportTracking(bioTab, actor);
  setupLanguageLayout(bioTab);

  bioTab.querySelector('[data-bio-action="pilgrim"]')?.addEventListener("click", () => openPilgrimCard(actor, root, state, editable, bioTab));
  bioTab.querySelector('[data-bio-action="archive"]')?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const archive = bioTab.querySelector("[data-bio-archive]");
    if (!(archive instanceof HTMLElement)) return;
    const open = archive.hidden;
    archive.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) archive.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  });

  for (const button of bioTab.querySelectorAll('[data-bio-action="copy-legacy"]')) {
    button.addEventListener("click", async () => {
      const key = button.dataset.legacyKey;
      if (!key || !Object.hasOwn(state.legacy, key)) return;
      const copied = await copyRichText(state.legacy[key]);
      if (copied) {
        button.classList.add("is-copied");
        const oldTitle = button.title;
        button.title = t("Bio.Archive.Copied", "Скопировано");
        window.setTimeout(() => {
          button.classList.remove("is-copied");
          button.title = oldTitle;
        }, 1200);
      }
    });
  }

  for (const content of bioTab.querySelectorAll("[data-bio-selectable]")) {
    content.addEventListener("dblclick", () => selectElementText(content));
  }

  bioTab.querySelector('[data-bio-action="add-language"]')?.addEventListener("click", () => {
    if (!editable) return warnCannotModifyActor();
    state.languages.push({ id: makeId("lang"), languageId: "", name: "", level: "basic", cost: 0, native: false });
    render();
    queueProfileSave(actor, state, null, 0);
  });
  for (const button of bioTab.querySelectorAll('[data-bio-action="remove-language"]')) {
    button.addEventListener("click", () => {
      if (!editable) return;
      state.languages.splice(Number(button.dataset.index), 1);
      render();
      queueProfileSave(actor, state, null, 0);
    });
  }

  bioTab.querySelector('[data-bio-action="add-rumor"]')?.addEventListener("click", () => {
    if (!editable) return warnCannotModifyActor();
    state.rumors.push({ id: makeId("rumor"), name: "", text: "" });
    render();
    queueProfileSave(actor, state, null, 0);
  });
  for (const button of bioTab.querySelectorAll('[data-bio-action="remove-rumor"]')) {
    button.addEventListener("click", () => {
      if (!editable) return;
      state.rumors.splice(Number(button.dataset.index), 1);
      render();
      queueProfileSave(actor, state, null, 0);
    });
  }
}

function openPilgrimCard(actor, root, state, editable, bioTab) {
  closeBiographyDrawer(actor);
  const application = findApplicationRoot(root) ?? root;
  const drawer = document.createElement("aside");
  drawer.className = "fblqa-pilgrim-drawer";
  drawer.dataset.actorId = actor.id;
  drawer.dataset.attached = "true";
  drawer.innerHTML = pilgrimCardHtml(actor, state, editable);
  document.body.append(drawer);
  applyPilgrimCardFont(drawer, getPilgrimCardFontFamily());

  const cleanup = setupPilgrimMovement(drawer, application);
  DRAWERS.set(drawerKey(actor), { element: drawer, cleanup });
  positionPilgrimDrawer(drawer, application);
  updatePilgrimAttachmentUi(drawer);
  requestAnimationFrame(() => drawer.classList.add("is-open"));

  drawer.querySelector('[data-bio-action="close-pilgrim"]')?.addEventListener("click", () => closeBiographyDrawer(actor));
  drawer.querySelector('[data-bio-action="toggle-pilgrim-attachment"]')?.addEventListener("click", () => {
    drawer.dataset.attached = drawer.dataset.attached === "true" ? "false" : "true";
    updatePilgrimAttachmentUi(drawer);
    if (drawer.dataset.attached === "true") positionPilgrimDrawer(drawer, application);
  });
  bindSimpleControls(drawer, actor, state, editable, null, bioTab);
  bindRichEditors(drawer, actor, state, editable, null, bioTab);
}

function pilgrimCardHtml(actor, profile, editable) {
  const disabled = editable ? "" : " disabled";
  const serial = `АО-${String(actor?.id ?? "000000").slice(-6).toUpperCase()}`;
  const stamp = t("Bio.Pilgrim.Stamp", "ПОДТВЕРЖДЕНО");
  return `
    <div class="fblqa-pilgrim-pocket">
      <div class="fblqa-pilgrim-windowbar" data-pilgrim-drag>
        <span class="fblqa-pilgrim-window-title"><i class="fa-solid fa-id-card"></i>${escapeHtml(t("Bio.Pilgrim.Title", "Карта пилигрима"))}</span>
        <span class="fblqa-pilgrim-window-actions">
          <button type="button" data-bio-action="toggle-pilgrim-attachment"><i class="fa-solid fa-link"></i></button>
          <button type="button" data-bio-action="close-pilgrim" aria-label="${escapeHtml(t("Bio.Pilgrim.Close", "Закрыть"))}" title="${escapeHtml(t("Bio.Pilgrim.Close", "Закрыть"))}"><i class="fa-solid fa-xmark"></i></button>
        </span>
      </div>
      <div class="fblqa-pilgrim-card" data-stamp="${escapeHtml(stamp)}">
        <div class="fblqa-pilgrim-serial">${escapeHtml(serial)}</div>
        <div class="fblqa-pilgrim-identity">
          ${fieldInput("identity.name", t("Bio.Pilgrim.Name", "Имя"), profile.identity.name, disabled)}
          <div class="fblqa-pilgrim-pair">
            ${fieldInput("identity.kin", t("Bio.Pilgrim.Kin", "Раса"), profile.identity.kin, disabled)}
            ${fieldInput("identity.kinVariant", t("Bio.Pilgrim.KinVariant", "Подраса"), profile.identity.kinVariant, disabled)}
          </div>
          ${fieldInput("identity.issuingCountry", t("Bio.Pilgrim.IssuingCountry", "Страна выдачи"), profile.identity.issuingCountry, disabled)}
        </div>
        ${fieldTextarea("physical.appearance", t("Bio.Pilgrim.Appearance", "Общее описание внешности"), profile.physical.appearance, disabled, "fblqa-pilgrim-appearance")}
        <div class="fblqa-pilgrim-details">
          ${fieldInput("physical.height", t("Bio.Pilgrim.Height", "Рост"), profile.physical.height, disabled)}
          ${fieldInput("physical.weight", t("Bio.Pilgrim.Weight", "Вес"), profile.physical.weight, disabled)}
          ${fieldInput("physical.skin", t("Bio.Pilgrim.Skin", "Кожа"), profile.physical.skin, disabled)}
          ${fieldInput("physical.eyes", t("Bio.Pilgrim.Eyes", "Глаза"), profile.physical.eyes, disabled)}
          ${fieldInput("physical.hair", t("Bio.Pilgrim.Hair", "Волосы"), profile.physical.hair, disabled, "fblqa-pilgrim-hair")}
        </div>
        ${fieldTextarea("physical.distinguishingMarks", t("Bio.Pilgrim.DistinguishingMarks", "Особые приметы"), profile.physical.distinguishingMarks, disabled, "fblqa-pilgrim-marks")}
        <footer><span>${escapeHtml(birthDateLabel(profile.identity.birthDate) || t("Bio.Pilgrim.BirthDateMissing", "Дата рождения не указана"))}</span><span>${escapeHtml(t("Bio.Pilgrim.Validity", "Действительна во всех портах"))}</span></footer>
      </div>
    </div>`;
}

function setupPilgrimMovement(drawer, application) {
  const dragHandle = drawer.querySelector("[data-pilgrim-drag]");
  let drag = null;

  const sync = () => {
    if (drawer.dataset.attached === "true") positionPilgrimDrawer(drawer, application);
  };
  const onResize = () => {
    if (drawer.dataset.attached === "true") positionPilgrimDrawer(drawer, application);
    else clampDrawerToViewport(drawer);
  };
  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drawer.style.left = `${event.clientX - drag.offsetX}px`;
    drawer.style.top = `${event.clientY - drag.offsetY}px`;
    clampDrawerToViewport(drawer);
  };
  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragHandle?.releasePointerCapture?.(event.pointerId);
    drag = null;
    drawer.classList.remove("is-dragging");
  };
  const startDrag = (event) => {
    if (event.button !== 0 || event.target.closest("button, input, select, prose-mirror, [contenteditable='true']")) return;
    const rect = drawer.getBoundingClientRect();
    drawer.dataset.attached = "false";
    updatePilgrimAttachmentUi(drawer);
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    drawer.classList.add("is-dragging");
    dragHandle?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  dragHandle?.addEventListener("pointerdown", startDrag);
  dragHandle?.addEventListener("pointermove", onPointerMove);
  dragHandle?.addEventListener("pointerup", finishDrag);
  dragHandle?.addEventListener("pointercancel", finishDrag);
  window.addEventListener("resize", onResize);

  const mutationObserver = typeof MutationObserver === "function" && application instanceof HTMLElement
    ? new MutationObserver(sync)
    : null;
  mutationObserver?.observe(application, { attributes: true, attributeFilter: ["style", "class"] });

  const resizeObserver = typeof ResizeObserver === "function" && application instanceof HTMLElement
    ? new ResizeObserver(sync)
    : null;
  resizeObserver?.observe(application);

  return () => {
    dragHandle?.removeEventListener("pointerdown", startDrag);
    dragHandle?.removeEventListener("pointermove", onPointerMove);
    dragHandle?.removeEventListener("pointerup", finishDrag);
    dragHandle?.removeEventListener("pointercancel", finishDrag);
    window.removeEventListener("resize", onResize);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
  };
}

function updatePilgrimAttachmentUi(drawer) {
  const attached = drawer.dataset.attached === "true";
  const button = drawer.querySelector('[data-bio-action="toggle-pilgrim-attachment"]');
  if (!(button instanceof HTMLElement)) return;
  const label = attached
    ? t("Bio.Pilgrim.Detach", "Отлепить от листа")
    : t("Bio.Pilgrim.Attach", "Прикрепить к листу");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(attached));
  const icon = button.querySelector("i");
  if (icon) icon.className = `fa-solid ${attached ? "fa-link" : "fa-link-slash"}`;
}

function positionPilgrimDrawer(drawer, application) {
  if (drawer.dataset.attached !== "true") return;
  const rect = application?.getBoundingClientRect?.() ?? { left: 20, right: window.innerWidth - 20, top: 40, bottom: window.innerHeight - 20 };
  const width = Math.min(342, Math.max(292, window.innerWidth - 18));
  const gap = 8;
  let left = rect.right + gap;
  let side = "right";
  if (left + width > window.innerWidth - 6) {
    left = rect.left - width - gap;
    side = "left";
  }
  if (left < 6) {
    left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.right - width - 10));
    side = "overlay";
  }
  drawer.dataset.side = side;
  drawer.style.width = `${width}px`;
  drawer.style.left = `${left}px`;
  drawer.style.top = `${Math.max(8, Math.min(rect.top + 24, window.innerHeight - 360))}px`;
  drawer.style.maxHeight = `${Math.max(300, window.innerHeight - 16)}px`;
}

function clampDrawerToViewport(drawer) {
  const rect = drawer.getBoundingClientRect();
  const width = rect.width || Number.parseFloat(drawer.style.width) || 330;
  const height = rect.height || 300;
  const left = Math.min(Math.max(6, rect.left), Math.max(6, window.innerWidth - width - 6));
  const top = Math.min(Math.max(6, rect.top), Math.max(6, window.innerHeight - Math.min(height, window.innerHeight - 12) - 6));
  drawer.style.left = `${left}px`;
  drawer.style.top = `${top}px`;
  drawer.style.maxHeight = `${Math.max(300, window.innerHeight - 12)}px`;
}

function languageRow(entry, index, editable) {
  const disabled = editable ? "" : " disabled";
  return `<div class="fblqa-language-row">
    <label class="fblqa-row-field fblqa-language-name"><span>${escapeHtml(t("Bio.Languages.Language", "Язык"))}</span><input type="text" data-bio-path="languages.${index}.name" value="${escapeHtml(entry.name)}" placeholder="${escapeHtml(t("Bio.Languages.NamePlaceholder", "Название"))}"${disabled}></label>
    <label class="fblqa-row-field fblqa-language-level"><span>${escapeHtml(t("Bio.Languages.Level", "Уровень"))}</span><select data-bio-path="languages.${index}.level"${disabled}>${Object.entries(LANGUAGE_LEVELS).map(([value, [key, fallback]]) => `<option value="${value}"${entry.level === value ? " selected" : ""}>${escapeHtml(t(key, fallback))}</option>`).join("")}</select></label>
    <label class="fblqa-row-field fblqa-cost-field"><span>${escapeHtml(t("Bio.Languages.Cost", "Цена"))}</span><input type="number" min="0" step="1" data-bio-path="languages.${index}.cost" value="${escapeHtml(entry.cost)}"${disabled}></label>
    ${editable ? `<button type="button" class="fblqa-row-remove" data-bio-action="remove-language" data-index="${index}" aria-label="${escapeHtml(t("Bio.Languages.Remove", "Удалить язык"))}" title="${escapeHtml(t("Bio.Languages.Remove", "Удалить язык"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
  </div>`;
}

function rumorRow(entry, index, editable) {
  const disabled = editable ? "" : " disabled";
  return `<div class="fblqa-rumor-row">
    <label class="fblqa-row-field fblqa-rumor-text"><span>${escapeHtml(t("Bio.Rumors.Text", "Слух"))}</span><input type="text" data-bio-path="rumors.${index}.text" value="${escapeHtml(plainTextFromHtml(entry.text))}" placeholder="${escapeHtml(t("Bio.Rumors.Text", "Слух"))}"${disabled}></label>
    ${editable ? `<button type="button" class="fblqa-row-remove" data-bio-action="remove-rumor" data-index="${index}" aria-label="${escapeHtml(t("Bio.Rumors.Remove", "Удалить слух"))}" title="${escapeHtml(t("Bio.Rumors.Remove", "Удалить слух"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
  </div>`;
}

function legacySection(legacy, headingSpec) {
  const entries = [
    ["face", t("Bio.Archive.Face", "Лицо"), legacy.face],
    ["body", t("Bio.Archive.Body", "Телосложение"), legacy.body],
    ["clothing", t("Bio.Archive.Clothing", "Одежда"), legacy.clothing]
  ].filter(([, , value]) => richTextHasContent(value));
  return `<section class="fblqa-legacy-section" data-bio-archive hidden>
    ${headingHtml(t("Bio.Archive.Title", "Архив старой вкладки BIO"), headingSpec, "", { collapsible: false })}
    <div class="fblqa-legacy-grid">${entries.map(([key, label, value]) => `<article>
      <header><strong>${escapeHtml(label)}</strong><button type="button" data-bio-action="copy-legacy" data-legacy-key="${escapeHtml(key)}" title="${escapeHtml(t("Bio.Archive.Copy", "Копировать"))}" aria-label="${escapeHtml(t("Bio.Archive.CopyField", "Копировать: {field}", { field: label }))}"><i class="fa-regular fa-copy"></i></button></header>
      <div class="fblqa-legacy-content" tabindex="0" data-bio-selectable>${sanitizeRichHtml(normalizeRichText(value))}</div>
    </article>`).join("")}</div>
  </section>`;
}

function fieldEditor(actor, path, label, value, disabled, {
  extraClass = "",
  headingSpec = null,
  actionHtml = "",
  compact = false,
  sectionKey = path,
  subheading = false,
  collapsible = true,
  actionBeforeTitle = false
} = {}) {
  const html = sanitizeRichHtml(normalizeRichText(value));
  const displayHtml = richTextHasContent(html) ? html : "<p><br></p>";
  const name = `flags.${MODULE_ID}.${FLAG_BIOGRAPHY_PROFILE}.${path}`;
  const collapsed = collapsible && isSectionCollapsed(actor, sectionKey);
  const editable = !disabled;
  const editLabel = t("Bio.Edit", "Редактировать");
  return `<section class="fblqa-bio-block fblqa-rich-field ${escapeHtml(extraClass)} ${compact ? "is-compact" : ""} ${subheading ? "is-subheading" : ""}" data-bio-section="${escapeHtml(sectionKey)}">
    ${headingHtml(label, headingSpec, actionHtml, { sectionKey, collapsed, subheading, collapsible, actionBeforeTitle })}
    <div class="fblqa-bio-section-body" data-bio-section-body="${escapeHtml(sectionKey)}"${collapsed ? " hidden" : ""}>
      <div class="fblqa-rich-control" data-bio-rich-control data-bio-path="${escapeHtml(path)}" data-bio-name="${escapeHtml(name)}" data-bio-value="${escapeHtml(html)}">
        <div class="fblqa-rich-preview" data-bio-action="edit-rich" tabindex="${editable ? "0" : "-1"}" role="${editable ? "button" : "document"}" aria-label="${editable ? escapeHtml(editLabel) : ""}">${displayHtml}</div>
        ${editable ? `<button type="button" class="fblqa-rich-edit" data-bio-action="edit-rich" aria-label="${escapeHtml(editLabel)}" title="${escapeHtml(editLabel)}"><i class="fa-solid fa-pen"></i></button>` : ""}
      </div>
    </div>
  </section>`;
}

function fieldInput(path, label, value, disabled, extraClass = "") {
  return `<label class="fblqa-bio-field ${escapeHtml(extraClass)}"><span>${escapeHtml(label)}</span><input type="text" data-bio-path="${escapeHtml(path)}" value="${escapeHtml(value)}"${disabled}></label>`;
}

function fieldTextarea(path, label, value, disabled, extraClass = "") {
  const plain = plainTextFromHtml(value);
  return `<label class="fblqa-bio-field fblqa-growing-text-field ${escapeHtml(extraClass)}"><span>${escapeHtml(label)}</span><textarea rows="1" data-bio-autosize data-bio-path="${escapeHtml(path)}"${disabled}>${escapeHtml(plain)}</textarea></label>`;
}

function headingHtml(label, spec, actionHtml = "", {
  sectionKey = "",
  collapsed = false,
  subheading = false,
  collapsible = true,
  actionBeforeTitle = false
} = {}) {
  const tag = subheading ? "h3" : (spec?.tag ?? "h2");
  const nativeClasses = !subheading && spec?.className ? `${spec.className} ` : "";
  const toggle = collapsible && sectionKey
    ? `<button type="button" class="fblqa-bio-collapse" data-bio-action="toggle-section" data-bio-section-key="${escapeHtml(sectionKey)}" aria-expanded="${String(!collapsed)}" aria-label="${escapeHtml(t(collapsed ? "Bio.Expand" : "Bio.Collapse", collapsed ? "Развернуть" : "Свернуть"))}" title="${escapeHtml(t(collapsed ? "Bio.Expand" : "Bio.Collapse", collapsed ? "Развернуть" : "Свернуть"))}"><i class="fa-solid ${collapsed ? "fa-chevron-right" : "fa-chevron-down"}"></i></button>`
    : "";
  const before = actionBeforeTitle ? actionHtml : "";
  const after = actionBeforeTitle ? "" : actionHtml;
  return `<div class="fblqa-bio-heading-row ${subheading ? "is-subheading" : ""}">${toggle}${before}<${tag} class="${escapeHtml(nativeClasses)}fblqa-bio-title">${escapeHtml(label)}</${tag}>${after}</div>`;
}

function iconButton({ action, icon, label }) {
  return `<button type="button" class="fblqa-bio-heading-action" data-bio-action="${escapeHtml(action)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="fa-solid ${escapeHtml(icon)}"></i></button>`;
}

function captureNativePrideRoll(bioTab) {
  const selectors = [
    '[data-action="rollPride"]',
    '[data-action="roll-pride"]',
    '[data-roll="pride"]',
    ".roll-pride",
    ".pride-roll",
    ".pride .roll",
    '[name="system.bio.pride.value"] ~ button',
    '[name="system.bio.pride.value"] ~ a'
  ];
  for (const selector of selectors) {
    const element = bioTab.querySelector(selector);
    if (element instanceof HTMLElement) return element;
  }

  for (const element of bioTab.querySelectorAll("button, a, [role='button']")) {
    if (!(element instanceof HTMLElement)) continue;
    const text = `${element.textContent ?? ""} ${element.title ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
    const hasDice = Boolean(element.querySelector(".fa-dice, .fa-dice-d20, .fa-d6, [class*='dice']")) || /dice|куб|roll|брос/.test(text);
    const prideContext = /pride|гордост/.test(text) || /pride|гордост/.test(element.parentElement?.textContent?.toLowerCase?.() ?? "");
    if (hasDice && prideContext) return element;
  }
  return null;
}

function mountNativePrideRoll(bioTab, button) {
  const slot = bioTab.querySelector("[data-bio-pride-roll-slot]");
  if (!(slot instanceof HTMLElement) || !(button instanceof HTMLElement)) return;
  const label = t("Bio.PrideRoll", "Бросить Гордость");

  button.className = "fblqa-native-pride-roll-source";
  button.hidden = true;
  button.tabIndex = -1;
  button.setAttribute("aria-hidden", "true");

  const proxy = document.createElement("button");
  proxy.type = "button";
  proxy.className = "fblqa-pride-roll";
  proxy.title = label;
  proxy.setAttribute("aria-label", label);
  proxy.innerHTML = '<i class="fa-solid fa-dice-d20"></i>';
  proxy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.click();
  });

  slot.append(proxy, button);
}

function captureNativeHeadingSpec(bioTab) {
  const prideControl = bioTab.querySelector('[name="system.bio.pride.value"], [data-edit="system.bio.pride.value"], [data-field="pride"]');
  const scope = prideControl?.closest?.("section, article, fieldset, .form-group, .bio-field, div") ?? bioTab;
  const candidate = scope?.querySelector?.("h1, h2, h3, h4, legend, label") ?? bioTab.querySelector("h1, h2, h3, h4, legend");
  if (!(candidate instanceof HTMLElement)) return { tag: "h2", className: "" };
  const allowedTag = ["H1", "H2", "H3", "H4", "LEGEND"].includes(candidate.tagName) ? candidate.tagName.toLowerCase() : "h2";
  const className = [...candidate.classList]
    .filter((name) => !name.startsWith("fblqa-"))
    .join(" ");
  return { tag: allowedTag, className };
}

function bindSimpleControls(scope, actor, state, editable, saveState, twinScope = null) {
  for (const control of scope.querySelectorAll("[data-bio-path]:not(prose-mirror)")) {
    if (control.matches("textarea[data-bio-autosize]")) schedulePlainTextareaResize(control);
    const eventName = control.matches("select, input[type='checkbox'], input[type='number']") ? "change" : "input";
    control.addEventListener(eventName, () => {
      if (control.matches("textarea[data-bio-autosize]")) autoSizePlainTextarea(control);
      scheduleLanguageLayout(scope);
      if (!editable) return;
      const value = control.type === "checkbox" ? control.checked : control.value;
      setPath(state, control.dataset.bioPath, value);
      syncTwinControl(twinScope, control.dataset.bioPath, value, control);
      queueProfileSave(actor, state, saveState);
    });
  }
  setupLanguageLayout(scope);
}

function bindRichEditors(scope, actor, state, editable, saveState, twinScope = null) {
  for (const control of scope.querySelectorAll("[data-bio-rich-control]")) {
    const open = (event) => {
      if (!editable) return warnCannotModifyActor();
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      activateRichEditor({ scope, control, actor, state, saveState, twinScope });
    };
    control.querySelectorAll('[data-bio-action="edit-rich"]').forEach((trigger) => {
      trigger.addEventListener("click", open);
      trigger.addEventListener("keydown", open);
    });
  }
}

function activateRichEditor({ scope, control, actor, state, saveState, twinScope }) {
  if (!(control instanceof HTMLElement) || control.classList.contains("is-editing")) return;
  commitActiveRichEditor(scope);

  const path = control.dataset.bioPath;
  const name = control.dataset.bioName;
  if (!path || !name) return;
  const originalValue = String(control.dataset.bioValue ?? "");
  const displayHtml = richTextHasContent(originalValue) ? originalValue : "<p><br></p>";
  const preview = control.querySelector(".fblqa-rich-preview");
  const editButton = control.querySelector(".fblqa-rich-edit");

  const shell = document.createElement("div");
  shell.className = "fblqa-rich-editor-shell";
  const editor = document.createElement("prose-mirror");
  editor.setAttribute("name", name);
  editor.setAttribute("data-bio-path", path);
  editor.setAttribute("value", originalValue);
  editor.innerHTML = displayHtml;
  editor.style.setProperty("--fblqa-editor-height", `${estimateRichEditorHeight(originalValue)}px`);

  const actions = document.createElement("div");
  actions.className = "fblqa-rich-editor-actions";
  actions.innerHTML = `
    <button type="button" data-bio-action="save-rich"><i class="fa-solid fa-floppy-disk"></i><span>${escapeHtml(t("Bio.Save.Button", "Сохранить"))}</span></button>
    <button type="button" data-bio-action="cancel-rich"><i class="fa-solid fa-xmark"></i><span>${escapeHtml(t("Bio.Cancel", "Отмена"))}</span></button>`;

  shell.append(editor, actions);
  control.classList.add("is-editing");
  if (preview instanceof HTMLElement) preview.hidden = true;
  if (editButton instanceof HTMLElement) editButton.hidden = true;
  control.append(shell);

  const close = ({ save = false } = {}) => {
    if (save) {
      const value = sanitizeRichHtml(normalizeRichText(String(editor.value ?? editor.getAttribute("value") ?? originalValue)));
      setPath(state, path, value);
      control.dataset.bioValue = value;
      if (preview instanceof HTMLElement) preview.innerHTML = richTextHasContent(value) ? sanitizeRichHtml(value) : "<p><br></p>";
      syncTwinControl(twinScope, path, value, control);
      queueProfileSave(actor, state, saveState, 0);
    }
    shell.remove();
    control.classList.remove("is-editing");
    if (preview instanceof HTMLElement) preview.hidden = false;
    if (editButton instanceof HTMLElement) editButton.hidden = false;
    const active = ACTIVE_RICH_EDITORS.get(scope);
    if (active?.control === control) ACTIVE_RICH_EDITORS.delete(scope);
  };

  const record = { control, editor, commit: () => close({ save: true }), cancel: () => close({ save: false }) };
  ACTIVE_RICH_EDITORS.set(scope, record);

  actions.querySelector('[data-bio-action="save-rich"]')?.addEventListener("click", record.commit);
  actions.querySelector('[data-bio-action="cancel-rich"]')?.addEventListener("click", record.cancel);
  editor.addEventListener("save", record.commit, { once: true });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      record.cancel();
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      record.commit();
    }
  });
  editor.addEventListener("open", () => {
    requestAnimationFrame(() => editor.querySelector(".ProseMirror, [contenteditable='true']")?.focus?.());
  }, { once: true });
}

function commitActiveRichEditor(scope) {
  const active = ACTIVE_RICH_EDITORS.get(scope);
  active?.commit?.();
}

function estimateRichEditorHeight(value) {
  const plain = plainTextFromHtml(value);
  const explicitLines = Math.max(1, plain.split(/\r?\n/).length);
  const wrappedLines = Math.max(explicitLines, Math.ceil(plain.length / 92));
  return Math.max(112, Math.min(260, 76 + wrappedLines * 20));
}

function schedulePlainTextareaResize(textarea) {
  requestAnimationFrame(() => autoSizePlainTextarea(textarea));
  window.setTimeout(() => autoSizePlainTextarea(textarea), 60);
}

function autoSizePlainTextarea(textarea) {
  if (!(textarea instanceof HTMLElement)) return;
  const minimum = 22;
  textarea.style.setProperty("height", "auto", "important");
  textarea.style.setProperty("min-height", `${minimum}px`, "important");
  textarea.style.setProperty("overflow-y", "hidden", "important");
  textarea.style.setProperty("height", `${Math.max(minimum, textarea.scrollHeight || minimum)}px`, "important");
}

function setupLanguageLayout(scope) {
  const list = scope?.matches?.(".fblqa-language-list") ? scope : scope?.querySelector?.(".fblqa-language-list");
  if (!(list instanceof HTMLElement)) return;
  if (!LANGUAGE_LAYOUT_OBSERVERS.has(list)) {
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => scheduleLanguageLayout(list))
      : null;
    observer?.observe(list);
    LANGUAGE_LAYOUT_OBSERVERS.set(list, observer);
  }
  scheduleLanguageLayout(list);
}

function scheduleLanguageLayout(scope) {
  const list = scope?.matches?.(".fblqa-language-list") ? scope : scope?.querySelector?.(".fblqa-language-list");
  if (!(list instanceof HTMLElement)) return;
  const oldFrame = LANGUAGE_LAYOUT_FRAMES.get(list);
  if (oldFrame) cancelAnimationFrame(oldFrame);
  const frame = requestAnimationFrame(() => {
    LANGUAGE_LAYOUT_FRAMES.delete(list);
    applyLanguageLayout(list);
  });
  LANGUAGE_LAYOUT_FRAMES.set(list, frame);
}

function applyLanguageLayout(list) {
  const rows = [...list.querySelectorAll(":scope > .fblqa-language-row")];
  if (!rows.length || list.clientWidth <= 0) return;
  const available = list.clientWidth;
  const half = (available - 8) / 2;
  const needsWide = rows.map((row) => {
    const name = row.querySelector(".fblqa-language-name input");
    const level = row.querySelector(".fblqa-language-level select");
    const nameText = String(name?.value || name?.placeholder || "");
    const levelText = String(level?.selectedOptions?.[0]?.textContent || level?.value || "");
    const estimatedWidth = 132 + Math.min(220, [...nameText].length * 7.1) + Math.min(150, [...levelText].length * 7.4);
    return available < 560 || estimatedWidth > half;
  });

  for (const row of rows) row.classList.remove("is-wide");
  for (let index = 0; index < rows.length;) {
    if (needsWide[index]) {
      rows[index].classList.add("is-wide");
      index += 1;
      continue;
    }
    if (index + 1 < rows.length && !needsWide[index + 1]) {
      index += 2;
      continue;
    }
    rows[index].classList.add("is-wide");
    index += 1;
  }
}

function captureBiographyViewport(bioTab, actor) {
  const key = drawerKey(actor);
  const stored = BIO_SCROLL_POSITIONS.get(key) ?? { top: 0, left: 0 };
  const mounted = bioTab.dataset.fblqaBiographyMounted === "true";
  const active = bioTab.contains(document.activeElement) ? document.activeElement : null;
  const activeControl = active?.dataset?.bioPath ? active : active?.closest?.("[data-bio-path]");
  return {
    top: mounted ? bioTab.scrollTop : stored.top,
    left: mounted ? bioTab.scrollLeft : stored.left,
    activePath: activeControl?.dataset?.bioPath ?? "",
    selectionStart: Number.isInteger(active?.selectionStart) ? active.selectionStart : null,
    selectionEnd: Number.isInteger(active?.selectionEnd) ? active.selectionEnd : null
  };
}

function restoreBiographyViewport(bioTab, actor, viewport) {
  const key = drawerKey(actor);
  const target = viewport ?? BIO_SCROLL_POSITIONS.get(key) ?? { top: 0, left: 0 };
  let focusRestored = false;
  const restore = () => {
    if (!bioTab.isConnected) return;
    bioTab.scrollTop = Math.max(0, Number(target.top) || 0);
    bioTab.scrollLeft = Math.max(0, Number(target.left) || 0);
    BIO_SCROLL_POSITIONS.set(key, { top: bioTab.scrollTop, left: bioTab.scrollLeft });
    if (!focusRestored && target.activePath) {
      const control = bioTab.querySelector(`[data-bio-path="${cssEscape(target.activePath)}"]`);
      control?.focus?.({ preventScroll: true });
      if (Number.isInteger(target.selectionStart) && typeof control?.setSelectionRange === "function") {
        control.setSelectionRange(target.selectionStart, target.selectionEnd ?? target.selectionStart);
      }
      focusRestored = true;
    }
  };
  requestAnimationFrame(restore);
  window.setTimeout(restore, 60);
  window.setTimeout(restore, 240);
}

function setupBiographyViewportTracking(bioTab, actor) {
  BIO_VIEWPORT_TRACKERS.get(bioTab)?.();
  const key = drawerKey(actor);
  const remember = () => BIO_SCROLL_POSITIONS.set(key, { top: bioTab.scrollTop, left: bioTab.scrollLeft });
  bioTab.addEventListener("scroll", remember, { passive: true });
  for (const eventName of ["input", "change", "save", "focusin"]) bioTab.addEventListener(eventName, remember, true);
  remember();
  BIO_VIEWPORT_TRACKERS.set(bioTab, () => {
    bioTab.removeEventListener("scroll", remember);
    for (const eventName of ["input", "change", "save", "focusin"]) bioTab.removeEventListener(eventName, remember, true);
  });
}

function setupFloatingBiographyActions(bioTab) {
  const oldCleanup = FLOATING_ACTIONS.get(bioTab);
  oldCleanup?.();

  const actions = bioTab.querySelector("[data-bio-floating-actions]");
  if (!(actions instanceof HTMLElement)) return;
  bioTab.style.position = "relative";

  let frame = 0;
  const place = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!actions.isConnected) return;
      const inset = 5;
      const top = Math.max(inset, bioTab.scrollTop + bioTab.clientHeight - actions.offsetHeight - inset);
      actions.style.top = `${top}px`;
      actions.style.right = `${inset}px`;
    });
  };

  bioTab.addEventListener("scroll", place, { passive: true });
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  resizeObserver?.observe(bioTab);
  resizeObserver?.observe(actions);
  place();

  const cleanup = () => {
    if (frame) cancelAnimationFrame(frame);
    bioTab.removeEventListener("scroll", place);
    resizeObserver?.disconnect();
  };
  FLOATING_ACTIONS.set(bioTab, cleanup);
}

function syncTwinControl(scope, path, value, source) {
  if (!scope || !path) return;
  const twin = scope.querySelector(`[data-bio-path="${cssEscape(path)}"]`);
  if (!twin || twin === source) return;
  if (twin.type === "checkbox") twin.checked = Boolean(value);
  else if (twin.matches?.("[data-bio-rich-control]")) {
    const richValue = sanitizeRichHtml(normalizeRichText(String(value ?? "")));
    twin.dataset.bioValue = richValue;
    const preview = twin.querySelector(".fblqa-rich-preview");
    if (preview instanceof HTMLElement) preview.innerHTML = richTextHasContent(richValue) ? sanitizeRichHtml(richValue) : "<p><br></p>";
  } else if (twin.tagName?.toLowerCase() === "prose-mirror") {
    twin.value = String(value ?? "");
    twin.setAttribute("value", String(value ?? ""));
  } else twin.value = value;
}

function queueProfileSave(actor, state, status, delay = 350) {
  const key = drawerKey(actor);
  const existing = SAVE_TIMERS.get(key);
  if (existing) window.clearTimeout(existing);
  setSaveStatus(status, t("Bio.Save.Saving", "Сохранение…"), "is-saving");
  const timeout = window.setTimeout(() => {
    SAVE_TIMERS.delete(key);
    const chain = (SAVE_CHAINS.get(key) ?? Promise.resolve())
      .catch(() => false)
      .then(() => saveBiographyProfile(actor, state, { render: false }))
      .then((saved) => {
        if (saved) setSaveStatus(status, t("Bio.Save.Saved", "Сохранено"), "is-saved");
        return saved;
      })
      .catch((error) => {
        console.error(`${MODULE_ID} | biography save failed`, error);
        setSaveStatus(status, t("Bio.Save.Error", "Ошибка сохранения"), "is-error");
        return false;
      });
    SAVE_CHAINS.set(key, chain);
  }, delay);
  SAVE_TIMERS.set(key, timeout);
}

function setSaveStatus(element, text, className) {
  if (!element) return;
  element.textContent = text;
  element.className = `fblqa-bio-save-state ${className}`;
  if (className === "is-saved") window.setTimeout(() => {
    if (element.textContent === text) element.textContent = "";
  }, 1400);
}

async function copyRichText(value) {
  const html = sanitizeRichHtml(normalizeRichText(value));
  const plain = plainTextFromHtml(html);
  try {
    if (globalThis.game?.clipboard?.copyPlainText) {
      await game.clipboard.copyPlainText(plain);
      return true;
    }
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      const item = new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" })
      });
      await navigator.clipboard.write([item]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
  } catch (_error) {
    // Fall through to the DOM selection copy path.
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = plain;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = Boolean(document.execCommand?.("copy"));
  } finally {
    textarea.remove();
  }
  return copied;
}

function bindSectionToggles(scope, actor) {
  for (const button of scope.querySelectorAll('[data-bio-action="toggle-section"]')) {
    button.addEventListener("click", () => {
      const sectionKey = button.dataset.bioSectionKey;
      if (!sectionKey) return;
      const body = scope.querySelector(`[data-bio-section-body="${cssEscape(sectionKey)}"]`);
      if (!(body instanceof HTMLElement)) return;
      const expanded = body.hidden;
      const active = ACTIVE_RICH_EDITORS.get(scope);
      if (!expanded && active?.control && body.contains(active.control)) active.commit?.();
      body.hidden = !expanded;
      setSectionCollapsed(actor, sectionKey, !expanded);
      button.setAttribute("aria-expanded", String(expanded));
      const label = t(expanded ? "Bio.Collapse" : "Bio.Expand", expanded ? "Свернуть" : "Развернуть");
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = button.querySelector("i");
      if (icon) icon.className = `fa-solid ${expanded ? "fa-chevron-down" : "fa-chevron-right"}`;
    });
  }
}

function isSectionCollapsed(actor, sectionKey) {
  return collapsedSections(actor).has(String(sectionKey));
}

function setSectionCollapsed(actor, sectionKey, collapsed) {
  const sections = collapsedSections(actor);
  if (collapsed) sections.add(String(sectionKey));
  else sections.delete(String(sectionKey));
}

function collapsedSections(actor) {
  const key = drawerKey(actor);
  if (!COLLAPSED_SECTIONS.has(key)) COLLAPSED_SECTIONS.set(key, new Set());
  return COLLAPSED_SECTIONS.get(key);
}

function selectElementText(element) {
  if (!(element instanceof HTMLElement) || typeof window?.getSelection !== "function") return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function plainTextFromHtml(value) {
  if (typeof document !== "undefined") return stripHtml(String(value ?? "")).replace(/\s+/g, " ").trim();
  return String(value ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function normalizeLanguages(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => ({
    id: String(entry?.id ?? makeId(`lang-${index + 1}`)),
    languageId: String(entry?.languageId ?? ""),
    name: String(entry?.name ?? entry?.label ?? entry?.languageId ?? ""),
    level: LANGUAGE_LEVELS[entry?.level] ? entry.level : "basic",
    cost: Math.max(0, Number(entry?.cost ?? entry?.learningCost ?? 0) || 0),
    native: Boolean(entry?.native)
  }));
}

function normalizeRumors(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => typeof entry === "string"
    ? { id: makeId(`rumor-${index + 1}`), name: "", text: entry }
    : {
        id: String(entry?.id ?? makeId(`rumor-${index + 1}`)),
        name: String(entry?.name ?? entry?.characterName ?? entry?.source ?? ""),
        text: String(entry?.text ?? entry?.rumor ?? "")
      });
}

function normalizeBirthDate(value) {
  if (value && typeof value === "object") {
    return {
      day: Number(value.day) || 0,
      month: String(value.month ?? ""),
      year: Number(value.year) || 0,
      label: String(value.label ?? "")
    };
  }
  return { day: 0, month: "", year: 0, label: String(value ?? "") };
}

function birthDateLabel(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.label) return value.label;
  return [value.day || "", value.month || "", value.year || ""].filter(Boolean).join(" ");
}

function actorBioHtml(actor, key) {
  return String(actor?.system?.bio?.[key]?.value ?? "").trim();
}

function plainActorBio(actor, key) {
  const value = actorBioHtml(actor, key);
  if (!value) return "";
  if (typeof document !== "undefined") return stripHtml(value).replace(/\s+/g, " ").trim();
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeRichText(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/<[a-z][\s\S]*>/iu.test(text)) return text;
  return text.split(/\n{2,}/u).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
}

function richTextHasContent(value) {
  const html = String(value ?? "");
  if (!html.trim()) return false;
  if (typeof document !== "undefined") return stripHtml(html).replace(/\s+/g, " ").trim().length > 0;
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim().length > 0;
}

export function sanitizeBiographyRichHtml(value) {
  return sanitizeRichHtml(value);
}

function sanitizeRichHtml(value) {
  const html = String(value ?? "");
  if (!html) return "";

  const cleanHTML = globalThis.foundry?.utils?.cleanHTML;
  if (typeof cleanHTML === "function") {
    try {
      return String(cleanHTML(html) ?? "");
    } catch (error) {
      console.warn(`${MODULE_ID} | Foundry rich-text sanitizer failed; using the conservative fallback`, error);
    }
  }

  if (typeof document === "undefined") return sanitizeRichHtmlWithoutDom(html);

  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(
    "script, style, iframe, object, embed, link, meta, base, svg, math, form, input, button, select, textarea, option"
  )) element.remove();

  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (/^on/iu.test(name) || ["srcdoc", "style", "xmlns", "formaction", "action"].includes(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "src", "poster", "xlink:href"].includes(name) && !isSafeRichUrl(attribute.value, name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

function sanitizeBiographyProfile(profile) {
  const richPaths = [
    "pride", "darkSecret", "background", "family", "motivation", "partyConnections", "publicNote"
  ];
  for (const path of richPaths) profile[path] = sanitizeRichHtml(normalizeRichText(profile[path]));
  for (const [key] of QUESTION_FIELDS) profile.questions[key] = sanitizeRichHtml(normalizeRichText(profile.questions[key]));
  for (const key of ["face", "body", "clothing"]) profile.legacy[key] = sanitizeRichHtml(normalizeRichText(profile.legacy[key]));
  return profile;
}

function sanitizeRichHtmlWithoutDom(html) {
  return String(html)
    .replace(/<(script|style|iframe|object|embed|link|meta|base|svg|math|form)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<(script|style|iframe|object|embed|link|meta|base|svg|math|form|input|button|select|textarea|option)\b[^>]*\/?>/giu, "")
    .replace(/\s+(?:on[a-z]+|srcdoc|style|xmlns|formaction|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\s+(href|src|poster|xlink:href)\s*=\s*(["'])([\s\S]*?)\2/giu, (match, name, quote, url) => (
      isSafeRichUrl(url, String(name).toLowerCase()) ? match : ""
    ))
    .replace(/\s+(href|src|poster|xlink:href)\s*=\s*([^\s"'`=<>]+)/giu, (match, name, url) => (
      isSafeRichUrl(url, String(name).toLowerCase()) ? match : ""
    ));
}

function isSafeRichUrl(value, attributeName) {
  const raw = String(value ?? "").replace(/[\u0000-\u001F\u007F\s]+/gu, "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(raw)) return true;
  if (/^https?:/iu.test(raw)) return true;
  if (attributeName === "href" && /^mailto:/iu.test(raw)) return true;
  if (attributeName === "src" && /^data:image\/(?:png|gif|jpe?g|webp);base64,/iu.test(raw)) return true;
  return false;
}

function cleanupBiographyMount(bioTab) {
  BIO_VIEWPORT_TRACKERS.get(bioTab)?.();
  BIO_VIEWPORT_TRACKERS.delete(bioTab);
  FLOATING_ACTIONS.get(bioTab)?.();
  FLOATING_ACTIONS.delete(bioTab);

  for (const list of bioTab.querySelectorAll?.(".fblqa-language-list") ?? []) {
    const frame = LANGUAGE_LAYOUT_FRAMES.get(list);
    if (frame) cancelAnimationFrame(frame);
    LANGUAGE_LAYOUT_FRAMES.delete(list);
    LANGUAGE_LAYOUT_OBSERVERS.get(list)?.disconnect?.();
    LANGUAGE_LAYOUT_OBSERVERS.delete(list);
  }
}

function setPath(target, path, value) {
  const parts = String(path).split(".");
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (Array.isArray(current)) current = current[Number(part)];
    else {
      if (current[part] === undefined || current[part] === null) current[part] = /^\d+$/.test(next) ? [] : {};
      current = current[part];
    }
  }
  const final = parts.at(-1);
  if (Array.isArray(current)) current[Number(final)] = coercePathValue(path, value);
  else current[final] = coercePathValue(path, value);
}

function coercePathValue(path, value) {
  if (/\.cost$/u.test(path)) return Math.max(0, Number(value) || 0);
  if (/\.native$/u.test(path)) return Boolean(value);
  return String(value ?? "");
}

function drawerKey(actor) {
  return String(actor?.uuid ?? actor?.id ?? actor ?? "unknown");
}

function makeId(prefix = "entry") {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function t(key, fallback, data = {}) {
  return qaLocalize(key, fallback, data);
}
