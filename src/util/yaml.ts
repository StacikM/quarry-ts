/** A bounded data-only YAML subset. No tags, aliases, merge keys or object construction. */
export function parseYaml(
  text: string,
  limits: { maxBytes?: number; maxDepth?: number; maxNodes?: number } = {},
): unknown {
  if (Buffer.byteLength(text) > (limits.maxBytes ?? 4 * 1024 * 1024))
    throw new Error("YAML line 1: document exceeds size limit");
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let at = 0,
    nodes = 0,
    origin = 0;
  const fail = (message: string, line = origin): never => {
    throw new Error(`YAML line ${line + 1}: ${message}`);
  };
  const touch = (depth: number) => {
    if (depth > (limits.maxDepth ?? 40)) fail("nesting limit exceeded");
    if (++nodes > (limits.maxNodes ?? 100_000)) fail("node limit exceeded");
  };
  const clean = (line: string): string => {
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === '"' && c === "\\") {
        i++;
        continue;
      }
      if (quote === "'" && c === "'" && line[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = "";
      } else if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,]/.test(line[i - 1]))) quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
    }
    return line.trimEnd();
  };
  const indent = (i: number): number => {
    if (/^ *\t/.test(lines[i])) fail("tabs in indentation are unsupported", i);
    return /^ */.exec(lines[i])![0].length;
  };
  const peek = (): string => clean(lines[at] ?? "").trim();
  const skip = () => {
    while (at < lines.length && peek() === "") at++;
  };
  // Split only outside quotes/flow collections. Colons in URLs/commands stay text.
  const split = (value: string, delimiter: string, mapping = false): number[] => {
    const positions: number[] = [];
    let quote = "",
      level = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (quote === '"' && c === "\\") {
        i++;
        continue;
      }
      if (quote === "'" && c === "'" && value[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,]/.test(value[i - 1]))) {
        quote = c;
        continue;
      }
      if (c === "[" || c === "{") level++;
      if (c === "]" || c === "}") level--;
      if (c === delimiter && level === 0 && (!mapping || i === value.length - 1 || /\s/.test(value[i + 1])))
        positions.push(i);
    }
    if (quote || level !== 0) fail("unclosed quote or flow collection");
    return positions;
  };
  const keyOf = (key: unknown): string => {
    if (typeof key !== "string" && typeof key !== "number") fail("map keys must be strings or numbers");
    const name = String(key);
    if (["__proto__", "prototype", "constructor", "<<"].includes(name))
      fail(`unsafe/unsupported key ${name}`);
    return name;
  };
  const put = (map: Record<string, unknown>, key: string, value: unknown) => {
    if (Object.hasOwn(map, key)) fail(`duplicate map key ${key}`);
    Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  };
  const scalar = (source: string, depth: number): unknown => {
    touch(depth);
    const value = source.trim();
    if (/^[!&*]/.test(value)) fail("YAML tags, anchors and aliases are unsupported");
    if (value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== "string") fail("expected quoted text");
        return parsed;
      } catch {
        fail("invalid double-quoted string (use JSON-style escapes)");
      }
    }
    if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) fail("invalid single-quoted string");
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith("[") || value.startsWith("{")) {
      const array = value[0] === "[";
      if (!value.endsWith(array ? "]" : "}")) fail("unclosed flow collection");
      const body = value.slice(1, -1).trim(),
        result: any = array ? [] : {};
      if (!body) return result;
      const cuts = [-1, ...split(body, ","), body.length];
      for (let i = 1; i < cuts.length; i++) {
        const part = body.slice(cuts[i - 1] + 1, cuts[i]).trim();
        if (!part) continue;
        if (array) result.push(scalar(part, depth + 1));
        else {
          const pos = split(part, ":")[0];
          if (pos === undefined) fail("expected colon in flow map");
          put(result, keyOf(scalar(part.slice(0, pos), depth + 1)), scalar(part.slice(pos + 1), depth + 1));
        }
      }
      return result;
    }
    if (/^(null|~)$/i.test(value) || value === "") return null;
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      const number = Number(value);
      if (!Number.isFinite(number)) fail("non-finite number");
      return number;
    }
    if (/^[-.]{3}$/.test(value) || /^%/.test(value))
      fail("multiple documents and directives are unsupported");
    return value;
  };
  const blockText = (parent: number, marker: string): string => {
    const start = at;
    let end = at;
    while (end < lines.length && (lines[end].trim() === "" || indent(end) > parent)) end++;
    const nonblank = lines.slice(start, end).map((s, i) => (s.trim() ? indent(start + i) : Infinity));
    const amount = Math.min(...nonblank);
    const chunks = lines
      .slice(start, end)
      .map((s) => (s.trim() === "" ? "" : s.slice(Number.isFinite(amount) ? amount : 0)));
    at = end;
    let result = chunks.join("\n");
    if (marker[0] === ">") result = result.replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    if (marker.includes("+")) return result + (chunks.length ? "\n" : "");
    result = result.replace(/\n*$/, "");
    return marker.includes("-") ? result : result + "\n";
  };
  const entry = (map: Record<string, unknown>, content: string, parent: number, depth: number) => {
    const pos = split(content, ":", true)[0];
    if (pos === undefined) fail("expected key: value");
    const key = keyOf(scalar(content.slice(0, pos), depth + 1)),
      rest = content.slice(pos + 1).trim();
    if (/^[|>][+-]?$/.test(rest)) put(map, key, blockText(parent, rest));
    else if (rest) put(map, key, scalar(rest, depth + 1));
    else {
      skip();
      put(
        map,
        key,
        at < lines.length && (indent(at) > parent || (indent(at) === parent && /^-(?:\s|$)/.test(peek())))
          ? node(indent(at), depth + 1)
          : null,
      );
    }
  };
  const node = (level: number, depth: number): any => {
    touch(depth);
    skip();
    const array = /^-(?:\s|$)/.test(peek());
    const result: any = array ? [] : {};
    while (at < lines.length) {
      skip();
      if (at >= lines.length || indent(at) < level) break;
      if (indent(at) > level) fail("unexpected indentation");
      origin = at;
      const content = peek(),
        isItem = /^-(?:\s|$)/.test(content);
      if (array !== isItem) {
        if (array) break;
        fail("cannot mix list and map entries");
      }
      at++;
      if (!array) entry(result, content, level, depth);
      else {
        const rest = content.slice(1).trim();
        if (!rest) {
          skip();
          result.push(at < lines.length && indent(at) > level ? node(indent(at), depth + 1) : null);
        } else if (split(rest, ":", true).length) {
          const map: Record<string, unknown> = {};
          entry(map, rest, level + 2, depth + 1);
          skip();
          if (at < lines.length && indent(at) > level) {
            const continuation = node(indent(at), depth + 1);
            if (Array.isArray(continuation)) fail("expected list-item map continuation");
            for (const [key, value] of Object.entries(continuation)) put(map, key, value);
          }
          result.push(map);
        } else result.push(scalar(rest, depth + 1));
      }
    }
    return result;
  };
  skip();
  if (peek() === "---") {
    at++;
    skip();
  }
  if (at >= lines.length) return {};
  const result = node(indent(at), 0);
  skip();
  if (at < lines.length) fail("unexpected trailing content");
  return result;
}
