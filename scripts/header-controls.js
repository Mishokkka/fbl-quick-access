import { findApplicationRoot } from "./sheet-adapter/forbidden-lands-v1.js";

const CHARGEN_SELECTORS = Object.freeze([
  ".chargen",
  ".character-generator",
  "[data-action='chargen']",
  "[data-action='characterGenerator']",
  "[data-action='openChargen']",
  "[data-control='chargen']",
  "[data-tool='chargen']"
]);

const CHARGEN_LABELS = new Set([
  "chargen",
  "character generator",
  "character generation",
  "генератор персонажа",
  "создание персонажа"
]);

export function removeChargenButton(root) {
  if (!(root instanceof HTMLElement)) return 0;

  const appRoot = findApplicationRoot(root) ?? root;
  const header = appRoot.matches?.(".window-header")
    ? appRoot
    : appRoot.querySelector?.(".window-header");

  const matches = new Set();

  // Exact selectors are safe across the application root. The broad text-label
  // heuristic is deliberately restricted to the actual window header so it
  // cannot remove similarly named controls from sheet content.
  for (const selector of CHARGEN_SELECTORS) {
    for (const element of appRoot.querySelectorAll?.(selector) ?? []) matches.add(element);
  }

  if (header instanceof HTMLElement) {
    for (const element of header.querySelectorAll?.("a, button, [role='button']") ?? []) {
      if (isChargenControl(element)) matches.add(element);
    }
  }

  for (const element of matches) element.remove();
  return matches.size;
}

function isChargenControl(element) {
  const values = [
    element.textContent,
    element.title,
    element.getAttribute?.("aria-label"),
    element.dataset?.action,
    element.dataset?.control,
    element.dataset?.tool
  ];

  return values.some((value) => CHARGEN_LABELS.has(normalizeLabel(value)));
}

function normalizeLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}
