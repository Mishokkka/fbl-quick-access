import { qaLocalize } from "./i18n.js";
import { escapeHtml } from "./utils.js";

export function hasFoundryDialogApi() {
  return Boolean(globalThis.foundry?.applications?.api?.DialogV2 || globalThis.Dialog);
}

export function createFoundryDialog(data = {}, options = {}) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return globalThis.Dialog ? new globalThis.Dialog(data, options) : null;

  const normalized = normalizeDialogContent(data.content);
  const defaultAction = String(data.default ?? "");
  const position = {};
  if (options.width != null) position.width = options.width;
  if (options.height != null) position.height = options.height;

  const dialog = new DialogV2({
    classes: Array.isArray(options.classes) ? options.classes : [],
    position,
    window: {
      title: String(data.title ?? ""),
      resizable: options.resizable !== false
    },
    form: {
      closeOnSubmit: data.closeOnSubmit !== false
    },
    modal: Boolean(data.modal),
    content: normalized.content,
    buttons: Object.entries(data.buttons ?? {}).map(([action, button]) => ({
      action,
      label: String(button?.label ?? action),
      icon: normalizeDialogIcon(button?.icon),
      class: [button?.class, action].filter(Boolean).join(" "),
      style: button?.style,
      type: button?.type,
      disabled: Boolean(button?.disabled),
      default: action === defaultAction,
      callback: typeof button?.callback === "function"
        ? (event, renderedButton, renderedDialog) => button.callback(renderedDialog.element, event, renderedButton, renderedDialog)
        : undefined
    }))
  });

  dialog.addEventListener("render", () => {
    applyDialogFormMetadata(dialog.form, normalized.formMetadata);
    data.render?.(dialog.element);
  });
  dialog.addEventListener("close", () => data.close?.());
  return dialog;
}

function normalizeDialogContent(content) {
  const text = String(content ?? "");
  const documentRef = globalThis.document;
  if (!documentRef?.createElement) return { content: text, formMetadata: null };

  const template = documentRef.createElement("template");
  template.innerHTML = text.trim();
  const childElements = [...template.content.children];
  const hasOtherContent = [...template.content.childNodes]
    .some((node) => node.nodeType !== 1 && String(node.textContent ?? "").trim());
  const form = childElements.length === 1 && !hasOtherContent && childElements[0]?.tagName === "FORM"
    ? childElements[0]
    : null;

  if (!form) return { content: text, formMetadata: null };
  return {
    content: form.innerHTML,
    formMetadata: {
      className: form.className,
      id: form.id,
      dataset: { ...form.dataset }
    }
  };
}

function applyDialogFormMetadata(form, metadata) {
  if (!form || !metadata) return;
  for (const className of String(metadata.className ?? "").split(/\s+/).filter(Boolean)) {
    form.classList.add(className);
  }
  if (metadata.id && !form.id) form.id = metadata.id;
  for (const [key, value] of Object.entries(metadata.dataset ?? {})) form.dataset[key] = value;
}

function normalizeDialogIcon(icon) {
  const value = String(icon ?? "").trim();
  if (!value) return undefined;
  const match = value.match(/\bclass\s*=\s*["']([^"']+)["']/i);
  return match?.[1]?.trim() || value;
}

export async function confirmDangerAction({
  title = qaLocalize("Dialog.ConfirmTitle", "Подтверждение"),
  heading = qaLocalize("Dialog.ConfirmHeading", "Подтвердите действие"),
  message = "",
  messageHtml = null,
  warning = qaLocalize("Dialog.CannotBeUndone", "Это действие нельзя отменить."),
  confirmLabel = qaLocalize("Dialog.Confirm", "Подтвердить"),
  cancelLabel = qaLocalize("Dialog.Cancel", "Отмена"),
  icon = "fas fa-exclamation-triangle",
  width = 420
} = {}) {
  const safeMessage = messageHtml ?? escapeHtml(message);
  const content = `
    <div class="fblqa-delete-dialog-content">
      <div class="fblqa-delete-dialog-icon" aria-hidden="true"><i class="${escapeHtml(icon)}"></i></div>
      <div class="fblqa-delete-dialog-copy">
        <h2 class="fblqa-delete-dialog-heading">${escapeHtml(heading)}</h2>
        <p class="fblqa-delete-dialog-message">${safeMessage}</p>
        ${warning ? `<p class="fblqa-delete-dialog-warning">${escapeHtml(warning)}</p>` : ""}
      </div>
    </div>
  `;

  if (hasFoundryDialogApi()) {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      createFoundryDialog({
        title,
        content,
        buttons: {
          yes: {
            icon: '<i class="fas fa-check"></i>',
            label: confirmLabel,
            callback: () => finish(true)
          },
          no: {
            icon: '<i class="fas fa-times"></i>',
            label: cancelLabel,
            callback: () => finish(false)
          }
        },
        default: "no",
        render: (html) => {
          const HTMLElementClass = globalThis.HTMLElement;
          const element = HTMLElementClass && html instanceof HTMLElementClass ? html : html?.[0];
          element?.closest?.(".app")?.classList.add("fblqa-delete-dialog");
        },
        close: () => finish(false)
      }, {
        classes: ["fblqa-delete-dialog"],
        width,
        resizable: false
      })?.render(true);
    });
  }

  return window.confirm(`${title}\n${message}`);
}
