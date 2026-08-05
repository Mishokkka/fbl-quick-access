import { qaLocalize } from "./i18n.js";
import { escapeHtml } from "./utils.js";

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

  if (globalThis.Dialog) {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      new Dialog({
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
          const element = html instanceof HTMLElement ? html : html?.[0];
          element?.closest?.(".app")?.classList.add("fblqa-delete-dialog");
        },
        close: () => finish(false)
      }, {
        classes: ["fblqa-delete-dialog"],
        width,
        resizable: false
      }).render(true);
    });
  }

  return window.confirm(`${title}\n${message}`);
}
