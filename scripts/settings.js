import { MODULE_ID, SETTINGS } from "./constants.js";
import { qaLocalize } from "./i18n.js";

const DEFAULT_PILGRIM_FONT = "Georgia";

export function registerCoreSettings() {
  game.settings.register(MODULE_ID, SETTINGS.PLAYERS_CAN_RESET_SHORT_REST, {
    name: qaLocalize("Settings.PlayersCanResetShortRest.Name", "Players can reset the Short Rest limit"),
    hint: qaLocalize("Settings.PlayersCanResetShortRest.Hint", "Allow character owners to manually clear the once-per-Quarter-Day Short Rest recovery limit. GMs can always reset it."),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.POST_NO_CHANGE_REST_CARDS, {
    name: qaLocalize("Settings.PostNoChangeRestCards.Name", "Post no-change Rest cards"),
    hint: qaLocalize("Settings.PostNoChangeRestCards.Hint", "Post a chat card when Rest completes without changing the character sheet."),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.PILGRIM_CARD_FONT, {
    name: qaLocalize("Settings.PilgrimCardFont.Name", "Pilgrim Card font"),
    hint: qaLocalize("Settings.PilgrimCardFont.Hint", "Choose the font used inside Pilgrim Cards from the fonts available in Foundry VTT."),
    scope: "world",
    config: true,
    type: String,
    choices: getFoundryFontChoices(),
    default: DEFAULT_PILGRIM_FONT,
    onChange: (font) => applyPilgrimFontToOpenCards(font)
  });
}

export function canResetShortRestLimit(actor = null) {
  if (game.user?.isGM) return true;
  if (!actor?.isOwner) return false;
  return Boolean(game.settings.get(MODULE_ID, SETTINGS.PLAYERS_CAN_RESET_SHORT_REST));
}

export function shouldPostNoChangeRestCards() {
  return Boolean(game.settings.get(MODULE_ID, SETTINGS.POST_NO_CHANGE_REST_CARDS));
}

export function getPilgrimCardFontFamily() {
  let configured = DEFAULT_PILGRIM_FONT;
  try {
    configured = String(game.settings.get(MODULE_ID, SETTINGS.PILGRIM_CARD_FONT) || DEFAULT_PILGRIM_FONT);
  } catch (_error) {
    // Settings may be queried before registration during tests or early init.
  }
  return resolveFoundryFontFamily(configured);
}

export function getFoundryFontChoices() {
  const choices = new Map([[DEFAULT_PILGRIM_FONT, DEFAULT_PILGRIM_FONT]]);
  const add = (value, label = value) => {
    const family = cleanFontFamily(value);
    if (!family) return;
    const display = cleanFontFamily(label) || family;
    choices.set(family, display);
  };

  for (const [family, label] of availableFontChoiceEntries()) add(family, label);

  const definitions = globalThis.CONFIG?.fontDefinitions;
  if (definitions instanceof Map) {
    for (const [key, definition] of definitions.entries()) add(definition?.family ?? key, definition?.label ?? definition?.name ?? key);
  } else if (definitions && typeof definitions === "object") {
    for (const [key, definition] of Object.entries(definitions)) add(definition?.family ?? key, definition?.label ?? definition?.name ?? key);
  }
  add(globalThis.CONFIG?.defaultFontFamily);

  try {
    const worldFonts = globalThis.game?.settings?.get?.("core", "fonts");
    if (worldFonts instanceof Map) {
      for (const [key, definition] of worldFonts.entries()) add(definition?.family ?? key, definition?.label ?? definition?.name ?? key);
    } else if (Array.isArray(worldFonts)) {
      for (const entry of worldFonts) add(entry?.family ?? entry?.name ?? entry, entry?.label ?? entry?.name ?? entry?.family ?? entry);
    } else if (worldFonts && typeof worldFonts === "object") {
      for (const [key, definition] of Object.entries(worldFonts)) add(definition?.family ?? key, definition?.label ?? definition?.name ?? key);
    }
  } catch (_error) {
    // The core font setting may not be available yet during init.
  }

  try {
    for (const face of globalThis.document?.fonts ?? []) add(face?.family);
  } catch (_error) {
    // Some browser FontFaceSet implementations are not iterable.
  }

  const configured = rawConfiguredPilgrimFont();
  add(resolveFoundryFontFamily(configured), configured);
  for (const fallback of ["Signika", "Modesto Condensed", "Times New Roman"]) add(fallback);

  return Object.fromEntries([...choices.entries()].sort(([familyA, labelA], [familyB, labelB]) =>
    String(labelA || familyA).localeCompare(String(labelB || familyB))));
}

export function refreshPilgrimFontChoices(htmlOrElement = null) {
  const choices = getFoundryFontChoices();
  const settingKey = `${MODULE_ID}.${SETTINGS.PILGRIM_CARD_FONT}`;
  const setting = globalThis.game?.settings?.settings?.get?.(settingKey);
  try {
    if (setting) setting.choices = choices;
  } catch (_error) {
    // The live Settings DOM is still refreshed below if the config is immutable.
  }

  const root = htmlOrElement?.[0] ?? htmlOrElement?.element ?? htmlOrElement;
  const select = root?.querySelector?.(`select[name="${settingKey}"]`);
  if (!select || select.tagName?.toLowerCase() !== "select") return choices;
  const selected = resolveFoundryFontFamily(String(select.value || getPilgrimCardFontFamily()));
  select.replaceChildren(...Object.entries(choices).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    return option;
  }));
  if (!choices[selected]) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = selected;
    option.selected = true;
    select.append(option);
  }
  return choices;
}

/** Apply the selected family to every text-bearing part of a Pilgrim Card. */
export function applyPilgrimCardFont(root, font = getPilgrimCardFontFamily()) {
  if (!(root instanceof HTMLElement)) return "";
  const family = resolveFoundryFontFamily(font);
  const stack = cssFontStack(family);
  root.style.setProperty("--fblqa-pilgrim-font", stack);

  const targets = root.matches?.(".fblqa-pilgrim-card")
    ? [root]
    : [...root.querySelectorAll?.(".fblqa-pilgrim-card") ?? []];
  for (const card of targets) {
    card.style.setProperty("font-family", stack, "important");
    for (const element of card.querySelectorAll([
      "input",
      "textarea",
      "select",
      "option",
      "label",
      "span",
      "footer",
      ".fblqa-bio-field",
      ".fblqa-bio-field > span",
      "prose-mirror",
      "prose-mirror .editor-content",
      "prose-mirror .ProseMirror",
      "prose-mirror [contenteditable='true']"
    ].join(","))) {
      if (element.closest("i, .fa, .fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands")) continue;
      element.style.setProperty("font-family", stack, "important");
    }
  }

  // Foundry registers custom faces lazily. Explicitly requesting the family
  // makes the browser load it before the user starts editing the card.
  try {
    const request = globalThis.document?.fonts?.load?.(`16px ${quoteFontFamily(family)}`);
    request?.then?.(() => {
      for (const card of targets) card.style.setProperty("font-family", stack, "important");
    }).catch?.(() => {});
  } catch (_error) {
    // The selected family still falls back cleanly if FontFaceSet is absent.
  }
  return family;
}

export function resolveFoundryFontFamily(value) {
  const requested = cleanFontFamily(value) || DEFAULT_PILGRIM_FONT;
  const entries = availableFontChoiceEntries();
  const exact = entries.find(([family]) => cleanFontFamily(family) === requested);
  if (exact) return cleanFontFamily(exact[0]);
  const byLabel = entries.find(([, label]) => cleanFontFamily(label) === requested);
  if (byLabel) return cleanFontFamily(byLabel[0]);
  return requested;
}

function availableFontChoiceEntries() {
  const entries = new Map();
  const add = (family, label = family) => {
    const cleanFamily = cleanFontFamily(family);
    if (cleanFamily) entries.set(cleanFamily, String(label ?? cleanFamily).trim() || cleanFamily);
  };

  const fontConfigClasses = [
    globalThis.foundry?.applications?.settings?.menus?.FontConfig,
    globalThis.foundry?.applications?.settings?.FontConfig,
    globalThis.FontConfig
  ].filter(Boolean);
  for (const FontConfigClass of fontConfigClasses) {
    try {
      const choices = FontConfigClass.getAvailableFontChoices?.() ?? {};
      if (choices instanceof Map) {
        for (const [family, label] of choices.entries()) add(family, label);
      } else {
        for (const [family, label] of Object.entries(choices)) add(family, label);
      }
      for (const entry of FontConfigClass.getAvailableFonts?.() ?? []) {
        add(entry?.family ?? entry?.name ?? entry, entry?.label ?? entry?.name ?? entry?.family ?? entry);
      }
    } catch (_error) {
      // Continue with CONFIG and world-setting fallbacks.
    }
  }
  return [...entries.entries()];
}

function applyPilgrimFontToOpenCards(font) {
  if (typeof document === "undefined") return;
  for (const drawer of document.querySelectorAll(".fblqa-pilgrim-drawer")) applyPilgrimCardFont(drawer, font);
}

function rawConfiguredPilgrimFont() {
  try {
    return String(globalThis.game?.settings?.get?.(MODULE_ID, SETTINGS.PILGRIM_CARD_FONT) || DEFAULT_PILGRIM_FONT);
  } catch (_error) {
    return DEFAULT_PILGRIM_FONT;
  }
}

function cleanFontFamily(value) {
  return String(value ?? "").replace(/^['"]|['"]$/g, "").trim();
}

function quoteFontFamily(value) {
  const safe = cleanFontFamily(value).replace(/["\\]/g, "");
  return `"${safe}"`;
}

function cssFontStack(font) {
  const family = cleanFontFamily(font) || DEFAULT_PILGRIM_FONT;
  return `${quoteFontFamily(family)}, Georgia, "Times New Roman", serif`;
}
