import { readFile } from "node:fs/promises";

let revision = 0;

export async function exposeModule(path, names, { fresh = false } = {}) {
  const url = new URL(`../../${path}`, import.meta.url);
  const source = (await readFile(url, "utf8")).replace(/from\s+(["'])(\.[^"']+)\1/g,
    (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
  const exports = `\nexport { ${names.join(", ")} };\n`;
  const key = Buffer.from(source + exports).toString("base64");
  return import(`data:text/javascript;base64,${key}${fresh ? `#${++revision}` : ""}`);
}
