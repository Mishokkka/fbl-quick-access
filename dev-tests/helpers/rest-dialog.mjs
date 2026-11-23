export function captureRestDialogs(controls = {}) {
  const dialogs = [];

  class Element {
    querySelector() { return null; }
  }

  class Form extends Element {
    matches(selector) { return selector === "form"; }
    querySelector(selector) {
      const name = selector.match(/name="([^"]+)"/)?.[1];
      if (name === "restType") return controls.restType ?? { value: "long" };
      return controls[name] ?? null;
    }
  }

  class DialogV2 {
    constructor(config) {
      this.config = config;
      this.element = new Element();
      this.listeners = new Map();
      this.closed = false;
      dialogs.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    async render() { return this; }
    async close() {
      this.closed = true;
      this.listeners.get("close")?.();
      return this;
    }
    submit(action = "apply") {
      const button = this.config.buttons.find(entry => entry.action === action);
      return button.callback({}, { form: new Form() }, this);
    }
  }

  globalThis.HTMLElement = Element;
  globalThis.foundry = { applications: { api: { DialogV2 } } };
  return dialogs;
}
