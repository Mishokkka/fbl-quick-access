import { FLAG_BIOGRAPHY_PROFILE, MODULE_ID } from "./constants.js";
import { canModifyActor, warnCannotModifyActor } from "./permissions.js";
import { findApplicationRoot, findNoteTab } from "./sheet-adapter/forbidden-lands-v1.js";
import { escapeHtml, stripHtml } from "./utils.js";
import { openReputationDialog } from "./reputation.js";

const PROFILE_VERSION = 1;
const QUESTION_FIELDS = Object.freeze([
  ["bestFriend", "Лучший друг или самый близкий человек"],
  ["favoriteFood", "Любимое блюдо и причина"],
  ["prejudices", "Предубеждения о расах и видах"],
  ["aristocracy", "Отношение к аристократии"],
  ["favoriteMemory", "Любимое воспоминание"],
  ["oneWish", "Одно желание"],
  ["greatestFear", "Самый большой страх"],
  ["notes", "Дополнительные ответы и заметки"]
]);
const LANGUAGE_LEVELS = Object.freeze({ basic: "Базовый", full: "Полный", academic: "Академический" });
const RUMOR_TRUTH = Object.freeze({ uncertain: "Не определено", true: "Правда", false: "Ложь" });
const DRAWERS = new Map();
const SAVE_TIMERS = new Map();
const SAVE_CHAINS = new Map();

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
  profile.pride ||= plainActorBio(actor, "pride");
  profile.darkSecret ||= plainActorBio(actor, "darkSecret");
  profile.publicNote ||= plainActorBio(actor, "note");
  return profile;
}

export async function saveBiographyProfile(actor, value, { render = false } = {}) {
  if (!actor?.update) return false;
  const profile = normalizeBiographyProfile(value);
  profile.identity.name = String(profile.identity.name || actor.name || "").trim();

  const update = {
    [`flags.${MODULE_ID}.${FLAG_BIOGRAPHY_PROFILE}`]: profile,
    "system.bio.kin.value": profile.identity.kin,
    "system.bio.profession.value": profile.identity.profession,
    "system.bio.pride.value": paragraphsHtml(profile.pride),
    "system.bio.darkSecret.value": paragraphsHtml(profile.darkSecret),
    "system.bio.note.value": paragraphsHtml(profile.publicNote)
  };
  if (profile.identity.name && profile.identity.name !== actor.name) update.name = profile.identity.name;
  await actor.update(update, { render });
  return true;
}

export function setupBiographyTab(app, actor, root) {
  const noteTab = findNoteTab(root);
  if (!(noteTab instanceof HTMLElement)) return null;
  noteTab.classList.add("fblqa-biography-tab");
  const editable = canModifyActor(actor);
  const state = getBiographyProfile(actor);

  const render = () => {
    noteTab.innerHTML = biographyHtml(actor, state, editable);
    bindBiographyInteractions({ app, actor, root, noteTab, state, editable, render });
  };
  render();
  return noteTab;
}

export function closeBiographyDrawer(actorOrId) {
  const key = typeof actorOrId === "string" ? actorOrId : drawerKey(actorOrId);
  const drawer = DRAWERS.get(key);
  if (!drawer) return;
  drawer.classList.remove("is-open");
  window.setTimeout(() => drawer.remove(), 180);
  DRAWERS.delete(key);
}

function profileFromActor(actor) {
  const imported = actor?.getFlag?.("air-islands-character-importer", "profile");
  const bio = imported?.biography ?? {};
  const identity = imported?.identity ?? {};
  const legacyFace = plainActorBio(actor, "face");
  const legacyBody = plainActorBio(actor, "body");
  const legacyClothing = plainActorBio(actor, "clothing");

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
    pride: bio.pride ?? plainActorBio(actor, "pride"),
    darkSecret: bio.darkSecret ?? plainActorBio(actor, "darkSecret"),
    appearance: bio.appearance || legacyFace,
    physical: bio.physical,
    background: bio.background,
    family: bio.family,
    motivation: bio.motivation,
    partyConnections: bio.partyConnections,
    publicNote: bio.publicNote ?? plainActorBio(actor, "note"),
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

function biographyHtml(actor, profile, editable) {
  const disabled = editable ? "" : " disabled";
  const questionFields = QUESTION_FIELDS.map(([key, label]) => fieldTextarea(`questions.${key}`, label, profile.questions[key], 3, disabled)).join("");
  const legacyVisible = Object.values(profile.legacy).some((value) => String(value).trim());

  return `
    <div class="fblqa-bio-shell ${editable ? "" : "is-readonly"}">
      <header class="fblqa-bio-header">
        <div>
          <span class="fblqa-bio-kicker">Личное дело</span>
          <h2>${escapeHtml(actor?.name ?? "Персонаж")}</h2>
        </div>
        <div class="fblqa-bio-header-actions">
          <button type="button" data-bio-action="reputation"><i class="fa-solid fa-star"></i> Репутация</button>
          <button type="button" class="fblqa-pilgrim-trigger" data-bio-action="pilgrim"><i class="fa-solid fa-id-card"></i> Карта пилигрима</button>
        </div>
      </header>

      <div class="fblqa-bio-columns">
        <div class="fblqa-bio-column">
          <section class="fblqa-bio-section fblqa-bio-section-accent">
            <h3>Характер</h3>
            ${fieldTextarea("concept", "Концепт", profile.concept, 3, disabled)}
            <div class="fblqa-bio-pair">
              ${fieldTextarea("pride", "Гордость", profile.pride, 4, disabled)}
              ${fieldTextarea("darkSecret", "Тёмный секрет", profile.darkSecret, 4, disabled)}
            </div>
          </section>

          <section class="fblqa-bio-section">
            <h3>Предыстория и семья</h3>
            ${fieldTextarea("background", "Предыстория", profile.background, 7, disabled)}
            ${fieldTextarea("family", "Семья", profile.family, 5, disabled)}
          </section>

          <section class="fblqa-bio-section">
            <h3>Место среди других</h3>
            ${fieldTextarea("motivation", "Мотивация к приключениям", profile.motivation, 4, disabled)}
            ${fieldTextarea("partyConnections", "Связь с группой", profile.partyConnections, 4, disabled)}
            ${fieldTextarea("publicNote", "Что о вас знают знакомые", profile.publicNote, 4, disabled)}
          </section>
        </div>

        <div class="fblqa-bio-column">
          <section class="fblqa-bio-section">
            <header class="fblqa-bio-section-head"><h3>Языки</h3>${editable ? '<button type="button" data-bio-action="add-language"><i class="fa-solid fa-plus"></i></button>' : ""}</header>
            <div class="fblqa-bio-list fblqa-language-list">
              ${profile.languages.length ? profile.languages.map((entry, index) => languageRow(entry, index, editable)).join("") : '<p class="fblqa-bio-empty">Языки не записаны.</p>'}
            </div>
          </section>

          <section class="fblqa-bio-section">
            <details class="fblqa-bio-details" open>
              <summary>Ответы на вопросы</summary>
              <div class="fblqa-question-grid">${questionFields}</div>
            </details>
          </section>

          <section class="fblqa-bio-section">
            <header class="fblqa-bio-section-head"><h3>Слухи</h3>${editable ? '<button type="button" data-bio-action="add-rumor"><i class="fa-solid fa-plus"></i></button>' : ""}</header>
            <div class="fblqa-bio-list fblqa-rumor-list">
              ${profile.rumors.length ? profile.rumors.map((entry, index) => rumorRow(entry, index, editable)).join("") : '<p class="fblqa-bio-empty">Слухи не записаны.</p>'}
            </div>
          </section>

          ${legacyVisible ? legacySection(profile.legacy) : ""}
        </div>
      </div>
      <span class="fblqa-bio-save-state" aria-live="polite"></span>
    </div>`;
}

function bindBiographyInteractions({ app, actor, root, noteTab, state, editable, render }) {
  const saveState = noteTab.querySelector(".fblqa-bio-save-state");
  for (const control of noteTab.querySelectorAll("[data-bio-path]")) {
    const eventName = control.matches("select, input[type='checkbox'], input[type='number']") ? "change" : "input";
    control.addEventListener(eventName, () => {
      if (!editable) return;
      setPath(state, control.dataset.bioPath, control.type === "checkbox" ? control.checked : control.value);
      queueProfileSave(actor, state, saveState);
    });
  }

  noteTab.querySelector('[data-bio-action="reputation"]')?.addEventListener("click", () => openReputationDialog(app, actor));
  noteTab.querySelector('[data-bio-action="pilgrim"]')?.addEventListener("click", () => openPilgrimCard(actor, root, state, editable, saveState, noteTab));

  noteTab.querySelector('[data-bio-action="add-language"]')?.addEventListener("click", () => {
    if (!editable) return warnCannotModifyActor();
    state.languages.push({ id: makeId("lang"), languageId: "", name: "", level: "basic", cost: 0, native: false });
    render();
    queueProfileSave(actor, state, saveState, 0);
  });
  for (const button of noteTab.querySelectorAll('[data-bio-action="remove-language"]')) {
    button.addEventListener("click", () => {
      if (!editable) return;
      state.languages.splice(Number(button.dataset.index), 1);
      render();
      queueProfileSave(actor, state, saveState, 0);
    });
  }

  noteTab.querySelector('[data-bio-action="add-rumor"]')?.addEventListener("click", () => {
    if (!editable) return warnCannotModifyActor();
    state.rumors.push({ id: makeId("rumor"), name: "", text: "", truth: "uncertain" });
    render();
    queueProfileSave(actor, state, saveState, 0);
  });
  for (const button of noteTab.querySelectorAll('[data-bio-action="remove-rumor"]')) {
    button.addEventListener("click", () => {
      if (!editable) return;
      state.rumors.splice(Number(button.dataset.index), 1);
      render();
      queueProfileSave(actor, state, saveState, 0);
    });
  }
}

function openPilgrimCard(actor, root, state, editable, saveState, noteTab) {
  closeBiographyDrawer(actor);
  const drawer = document.createElement("aside");
  drawer.className = "fblqa-pilgrim-drawer";
  drawer.dataset.actorId = actor.id;
  drawer.innerHTML = pilgrimCardHtml(actor, state, editable);
  document.body.append(drawer);
  DRAWERS.set(drawerKey(actor), drawer);
  positionPilgrimDrawer(drawer, findApplicationRoot(root) ?? root);
  requestAnimationFrame(() => drawer.classList.add("is-open"));

  drawer.querySelector('[data-bio-action="close-pilgrim"]')?.addEventListener("click", () => closeBiographyDrawer(actor));
  for (const control of drawer.querySelectorAll("[data-bio-path]")) {
    const eventName = control.matches("select, input[type='checkbox'], input[type='number']") ? "change" : "input";
    control.addEventListener(eventName, () => {
      if (!editable) return;
      setPath(state, control.dataset.bioPath, control.type === "checkbox" ? control.checked : control.value);
      const twin = noteTab.querySelector(`[data-bio-path="${cssEscape(control.dataset.bioPath)}"]`);
      if (twin && twin !== control) {
        if (twin.type === "checkbox") twin.checked = control.checked;
        else twin.value = control.value;
      }
      queueProfileSave(actor, state, saveState);
    });
  }
}

function pilgrimCardHtml(actor, profile, editable) {
  const disabled = editable ? "" : " disabled";
  const serial = `АО-${String(actor?.id ?? "000000").slice(-6).toUpperCase()}`;
  return `
    <div class="fblqa-pilgrim-pocket" aria-label="Карта пилигрима">
      <button type="button" class="fblqa-pilgrim-close" data-bio-action="close-pilgrim" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button>
      <div class="fblqa-pilgrim-card">
        <header>
          <div><span>Воздушные Острова</span><h2>Карта пилигрима</h2></div>
          <strong>${escapeHtml(serial)}</strong>
        </header>
        <div class="fblqa-pilgrim-identity">
          <img src="${escapeHtml(actor?.img ?? "icons/svg/mystery-man.svg")}" alt="Портрет">
          <div>
            ${fieldInput("identity.name", "Имя", profile.identity.name, disabled)}
            <div class="fblqa-pilgrim-pair">
              ${fieldInput("identity.kin", "Раса", profile.identity.kin, disabled)}
              ${fieldInput("identity.kinVariant", "Подраса", profile.identity.kinVariant, disabled)}
            </div>
            ${fieldInput("identity.issuingCountry", "Страна выдачи", profile.identity.issuingCountry, disabled)}
          </div>
        </div>
        ${fieldTextarea("physical.appearance", "Общее описание внешности", profile.physical.appearance, 4, disabled)}
        <div class="fblqa-pilgrim-details">
          ${fieldInput("physical.height", "Рост", profile.physical.height, disabled)}
          ${fieldInput("physical.weight", "Вес", profile.physical.weight, disabled)}
          ${fieldInput("physical.skin", "Кожа", profile.physical.skin, disabled)}
          ${fieldInput("physical.eyes", "Глаза", profile.physical.eyes, disabled)}
          ${fieldInput("physical.hair", "Волосы", profile.physical.hair, disabled)}
          ${fieldInput("physical.distinguishingMarks", "Особые приметы", profile.physical.distinguishingMarks, disabled)}
        </div>
        <footer><span>${escapeHtml(birthDateLabel(profile.identity.birthDate) || "Дата рождения не указана")}</span><span>Действительна во всех портах</span></footer>
      </div>
    </div>`;
}

function positionPilgrimDrawer(drawer, application) {
  const rect = application?.getBoundingClientRect?.() ?? { left: 20, right: window.innerWidth - 20, top: 40, bottom: window.innerHeight - 20 };
  const width = Math.min(390, Math.max(300, window.innerWidth - 24));
  const gap = 10;
  let left = rect.right + gap;
  let side = "right";
  if (left + width > window.innerWidth - 8) {
    left = rect.left - width - gap;
    side = "left";
  }
  if (left < 8) {
    left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width - 14));
    side = "overlay";
  }
  drawer.dataset.side = side;
  drawer.style.width = `${width}px`;
  drawer.style.left = `${left}px`;
  drawer.style.top = `${Math.max(12, Math.min(rect.top + 38, window.innerHeight - 520))}px`;
  drawer.style.maxHeight = `${Math.max(360, window.innerHeight - 24)}px`;
}

function languageRow(entry, index, editable) {
  const disabled = editable ? "" : " disabled";
  return `<div class="fblqa-language-row">
    <input type="text" data-bio-path="languages.${index}.name" value="${escapeHtml(entry.name)}" placeholder="Язык"${disabled}>
    <select data-bio-path="languages.${index}.level"${disabled}>${Object.entries(LANGUAGE_LEVELS).map(([value, label]) => `<option value="${value}"${entry.level === value ? " selected" : ""}>${label}</option>`).join("")}</select>
    <label class="fblqa-cost-field"><span>Цена</span><input type="number" min="0" step="1" data-bio-path="languages.${index}.cost" value="${escapeHtml(entry.cost)}"${disabled}></label>
    <label class="fblqa-native-field"><input type="checkbox" data-bio-path="languages.${index}.native"${entry.native ? " checked" : ""}${disabled}> Родной</label>
    ${editable ? `<button type="button" data-bio-action="remove-language" data-index="${index}" aria-label="Удалить язык"><i class="fa-solid fa-xmark"></i></button>` : ""}
  </div>`;
}

function rumorRow(entry, index, editable) {
  const disabled = editable ? "" : " disabled";
  return `<div class="fblqa-rumor-row">
    <input type="text" data-bio-path="rumors.${index}.name" value="${escapeHtml(entry.name)}" placeholder="Имя персонажа"${disabled}>
    <textarea rows="2" data-bio-path="rumors.${index}.text" placeholder="Текст слуха"${disabled}>${escapeHtml(entry.text)}</textarea>
    <select data-bio-path="rumors.${index}.truth"${disabled}>${Object.entries(RUMOR_TRUTH).map(([value, label]) => `<option value="${value}"${entry.truth === value ? " selected" : ""}>${label}</option>`).join("")}</select>
    ${editable ? `<button type="button" data-bio-action="remove-rumor" data-index="${index}" aria-label="Удалить слух"><i class="fa-solid fa-xmark"></i></button>` : ""}
  </div>`;
}

function legacySection(legacy) {
  const entries = [["Face", legacy.face], ["Body", legacy.body], ["Clothing", legacy.clothing]].filter(([, value]) => String(value).trim());
  return `<section class="fblqa-bio-section fblqa-legacy-section"><details><summary>Архив старой вкладки BIO</summary>${entries.map(([label, value]) => `<article><strong>${label}</strong><p>${escapeHtml(value)}</p></article>`).join("")}</details></section>`;
}

function fieldTextarea(path, label, value, rows, disabled) {
  return `<label class="fblqa-bio-field"><span>${escapeHtml(label)}</span><textarea rows="${rows}" data-bio-path="${escapeHtml(path)}"${disabled}>${escapeHtml(value)}</textarea></label>`;
}

function fieldInput(path, label, value, disabled) {
  return `<label class="fblqa-bio-field"><span>${escapeHtml(label)}</span><input type="text" data-bio-path="${escapeHtml(path)}" value="${escapeHtml(value)}"${disabled}></label>`;
}

function queueProfileSave(actor, state, status, delay = 350) {
  const key = drawerKey(actor);
  const existing = SAVE_TIMERS.get(key);
  if (existing) window.clearTimeout(existing);
  setSaveStatus(status, "Сохранение…", "is-saving");
  const timeout = window.setTimeout(() => {
    SAVE_TIMERS.delete(key);
    const chain = (SAVE_CHAINS.get(key) ?? Promise.resolve())
      .catch(() => false)
      .then(() => saveBiographyProfile(actor, state, { render: false }))
      .then((saved) => {
        if (saved) setSaveStatus(status, "Сохранено", "is-saved");
        return saved;
      })
      .catch((error) => {
        console.error(`${MODULE_ID} | biography save failed`, error);
        setSaveStatus(status, "Ошибка сохранения", "is-error");
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
    ? { id: makeId(`rumor-${index + 1}`), name: "", text: entry, truth: "uncertain" }
    : {
        id: String(entry?.id ?? makeId(`rumor-${index + 1}`)),
        name: String(entry?.name ?? entry?.characterName ?? entry?.source ?? ""),
        text: String(entry?.text ?? entry?.rumor ?? ""),
        truth: RUMOR_TRUTH[entry?.truth] ? entry.truth : "uncertain"
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

function plainActorBio(actor, key) {
  const value = actor?.system?.bio?.[key]?.value ?? "";
  if (!value) return "";
  if (typeof document !== "undefined") return stripHtml(String(value)).replace(/\s+/g, " ").trim();
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function paragraphsHtml(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.split(/\n{2,}/u).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
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
