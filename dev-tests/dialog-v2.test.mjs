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

test("dialog adapter reapplies outer form class, id, and dataset in DialogV2", async () => {
  const previousFoundry = globalThis.foundry;
  const previousDialog = globalThis.Dialog;
  const previousDocument = globalThis.document;

  class FakeClassList {
    constructor(owner) { this.owner = owner; }
    add(...names) {
      const values = new Set(String(this.owner.className ?? "").split(/\s+/).filter(Boolean));
      names.forEach((name) => values.add(name));
      this.owner.className = [...values].join(" ");
    }
    contains(name) { return String(this.owner.className ?? "").split(/\s+/).includes(name); }
  }

  class FakeElement {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.className = "";
      this.id = "";
      this.dataset = {};
      this.innerHTML = "";
      this.classList = new FakeClassList(this);
    }
  }

  class FakeTemplate {
    constructor() {
      this.content = { children: [], childNodes: [] };
    }
    set innerHTML(value) {
      const text = String(value ?? "").trim();
      const match = text.match(/^<form\b([^>]*)>([\s\S]*)<\/form>$/i);
      if (!match) return;
      const form = new FakeElement("form");
      form.innerHTML = match[2];
      form.className = match[1].match(/\bclass=["']([^"']*)["']/i)?.[1] ?? "";
      form.id = match[1].match(/\bid=["']([^"']*)["']/i)?.[1] ?? "";
      for (const [, key, value] of match[1].matchAll(/\bdata-([a-z0-9-]+)=["']([^"']*)["']/gi)) {
        form.dataset[key.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = value;
      }
      this.content.children = [form];
      this.content.childNodes = [form];
    }
  }

  class FakeDialogV2 {
    constructor(config) {
      this.config = config;
      this.element = new FakeElement("dialog");
      this.form = new FakeElement("form");
      this.listeners = new Map();
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    async render() { this.listeners.get("render")?.(); return this; }
  }

  globalThis.document = {
    createElement(tagName) {
      if (String(tagName).toLowerCase() === "template") return new FakeTemplate();
      return new FakeElement(tagName);
    }
  };
  globalThis.Dialog = undefined;
  globalThis.foundry = { applications: { api: { DialogV2: FakeDialogV2 } } };

  try {
    const dialog = dialogs.createFoundryDialog({
      title: "Rest",
      content: '<form id="rest-form" class="fblqa-rest-form extra" data-mode="long"><p>Body</p></form>',
      buttons: { close: { label: "Close" } }
    });
    await dialog.render(true);

    assert.equal(dialog.form.classList.contains("fblqa-rest-form"), true);
    assert.equal(dialog.form.classList.contains("extra"), true);
    assert.equal(dialog.form.id, "rest-form");
    assert.equal(dialog.form.dataset.mode, "long");
    assert.equal(dialog.config.content, "<p>Body</p>");
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.Dialog = previousDialog;
    globalThis.document = previousDocument;
  }
});
