/**
 * Finds template values left in wrangler.jsonc: anything containing
 * REPLACE_ME and example.com hostnames. Comments are ignored, so the
 * template's instructions do not count.
 */
export interface Placeholder {
  path: string;
  value: string;
}

const PLACEHOLDER = /REPLACE_ME|(^|[^a-z0-9-])example\.com(?![a-z0-9-])/i;

export function findPlaceholders(jsonc: string): Placeholder[] {
  const parsed: unknown = JSON.parse(stripJsonc(jsonc));
  const found: Placeholder[] = [];
  walk(parsed, '$', found);
  return found;
}

function walk(node: unknown, path: string, found: Placeholder[]): void {
  if (typeof node === 'string') {
    if (PLACEHOLDER.test(node)) found.push({ path, value: node });
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`, found);
  }
}

/** Removes // and block comments and trailing commas, leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      // Strings and comments are already consumed, so a comma before a
      // closing bracket here is always a JSONC trailing comma.
      if (ch === '}' || ch === ']') out = out.replace(/,(\s*)$/, '$1');
      out += ch;
      i++;
    }
  }
  return out;
}
