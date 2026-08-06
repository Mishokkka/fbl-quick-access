import test from "node:test";
import assert from "node:assert/strict";

const dialogs = await import("../scripts/dialogs.js");

test("dialog adapter prefers Foundry v13 DialogV2 and maps legacy button callbacks", async () => {
  const previousFoundry = globalThis.foundry;
  const previousDialog = globalThis.Dialog;
  const previousDocument = globalThis.document;
  let receivedConfig = null;
  let callbackRoot = null;

  class FakeDialogV2 {
    constructor(config) {
      receivedConfig = config;
      this.element = { id: "dialog-root" };
      this.form = null;
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    render(force) {
      assert.equal(force, true);
      this.listeners.get("render")?.();
      return Promise.resolve(this);
    }
  }

  globalThis.document = undefined;
  globalThis.Dialog = class LegacyDialog {
    constructor() {
      throw new Error("ApplicationV1 Dialog fallback must not be used when DialogV2 exists");
    }
  };
  globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };

  try {
    const dialog = dialogs.createFoundryDialog({
      title: "V13 dialog",
      content: "<p>Body</p>",
      default: "apply",
      buttons: {
        apply: {
          icon: '<i class="fas fa-check"></i>',
          label: "Apply",
          callback: (root) => {
            callbackRoot = root;
            return "done";
          }
        }
      }
    }, {
      classes: ["fblqa-test-dialog"],
      width: 480,
      height: "auto",
      resizable: false
    });

    assert.ok(dialog instanceof FakeDialogV2);
    assert.deepEqual(receivedConfig.classes, ["fblqa-test-dialog"]);
    assert.deepEqual(receivedConfig.position, { width: 480, height: "auto" });
    assert.deepEqual(receivedConfig.window, { title: "V13 dialog", resizable: false });
    assert.equal(receivedConfig.buttons[0].action, "apply");
    assert.equal(receivedConfig.buttons[0].default, true);
    assert.equal(receivedConfig.buttons[0].icon, "fas fa-check");
    assert.equal(receivedConfig.buttons[0].callback(null, null, dialog), "done");
    assert.equal(callbackRoot, dialog.element);
    await dialog.render(true);
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.Dialog = previousDialog;
    globalThis.document = previousDocument;
  }
});
