export function renderModuleTemplate(path, data) {
  const handlebars = globalThis.foundry?.applications?.handlebars;
  if (typeof handlebars?.renderTemplate === "function") return handlebars.renderTemplate(path, data);
  return globalThis.renderTemplate(path, data);
}
