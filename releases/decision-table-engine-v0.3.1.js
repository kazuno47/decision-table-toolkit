// Decision Table Toolkit - engine v0.3.1
// https://github.com/kazuno47/decision-table-toolkit  (types: decision-table-engine.d.ts)
// src/schema.ts
var text = (maxLength = 1024) => ({ type: "string", maxLength });
var id = { type: "string", minLength: 1, maxLength: 128 };
var array = (items, minItems = 0) => ({ type: "array", items, minItems, maxItems: 1e4 });
var object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
var scalar = { oneOf: [{ type: "boolean" }, text()] };
var nullable = { oneOf: [text(128), { type: "null" }] };
var range = object({ lower: nullable, upper: nullable, lowerInclusive: { type: "boolean" }, upperInclusive: { type: "boolean" } });
var partition = { oneOf: [
  object({ id, label: text(), kind: { const: "values" }, values: array(scalar, 1) }),
  object({ id, label: text(), kind: { const: "range" }, range }),
  object({ id, label: text(), kind: { const: "missing" } })
] };
var condition = object({ id, name: text(), type: { enum: ["boolean", "enum", "number", "string", "date"] }, partitions: array(partition, 1) });
var resultTypes = ["boolean", "number", "string", "date"];
var output = { oneOf: [
  object({ id, name: text(), kind: { const: "action" } }),
  object({ id, name: text(), kind: { const: "result" }, type: { enum: resultTypes } }),
  object({ id, name: text(), kind: { const: "result" }, type: { const: "enum" }, values: array(text(), 1) })
] };
var directive = { oneOf: [object({ outputId: id, state: { const: "unset" } }), object({ outputId: id, state: { const: "set" }, value: scalar })] };
var selection = object({ conditionId: id, partitionIds: array(id, 1) });
var clause = object({ selections: array(selection) });
var rule = object({ id, anyOf: array(clause, 1), directives: array(directive) });
var documentSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Decision Table Toolkit 1.0 / 1.1 (schemaVersion 1.0 additionally requires every condition exactly once in each clause; the application enforces this)",
  ...object({ schemaVersion: { enum: ["1.0", "1.1"] }, id, title: text(256), conditions: array(condition), outputs: array(output), rules: array(rule) })
};
function checkShape(value, schema = documentSchema, path = "$", depth = 0) {
  if (depth > 24) return [`${path}: \u5165\u308C\u5B50\u304C\u6DF1\u3059\u304E\u307E\u3059`];
  if (schema.oneOf) return schema.oneOf.filter((s) => checkShape(value, s, path, depth + 1).length === 0).length === 1 ? [] : [`${path}: \u30C7\u30FC\u30BF\u5F62\u5F0F\u304C\u4E00\u81F4\u3057\u306A\u3044\u304B\u3001\u672A\u77E5\u30D5\u30A3\u30FC\u30EB\u30C9\u304C\u3042\u308A\u307E\u3059`];
  if ("const" in schema && value !== schema.const) return [`${path}: \u672A\u5BFE\u5FDC\u306E\u5024 ${String(value)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: \u672A\u5BFE\u5FDC\u306E\u5024 ${String(value)}`];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && type !== schema.type) return [`${path}: ${schema.type} \u304C\u5FC5\u8981\u3067\u3059`];
  if (type === "string") {
    const s = value;
    if (s.length < (schema.minLength ?? 0) || s.length > (schema.maxLength ?? 1e5)) return [`${path}: \u6587\u5B57\u6570\u304C\u7BC4\u56F2\u5916\u3067\u3059`];
  }
  if (schema.type === "array") {
    const a = value;
    if (a.length < (schema.minItems ?? 0) || a.length > (schema.maxItems ?? 1e4)) return [`${path}: \u8981\u7D20\u6570\u304C\u7BC4\u56F2\u5916\u3067\u3059`];
    return a.flatMap((v, i) => checkShape(v, schema.items, `${path}[${i}]`, depth + 1));
  }
  if (schema.type === "object") {
    const o = value, props = schema.properties ?? {};
    const errors = (schema.required ?? []).filter((k) => !Object.hasOwn(o, k)).map((k) => `${path}.${k}: \u5FC5\u9808\u3067\u3059`);
    for (const k of Object.keys(o)) {
      if (!Object.hasOwn(props, k)) errors.push(`${path}.${k}: \u672A\u77E5\u306E\u30D5\u30A3\u30FC\u30EB\u30C9\u3067\u3059`);
      else errors.push(...checkShape(o[k], props[k], `${path}.${k}`, depth + 1));
    }
    return errors;
  }
  return [];
}

// src/core.ts
var clone = (v) => structuredClone(v);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function decimal(s) {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s) || s.length > 128) throw new Error(`\u6570\u5024\u306E\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059: ${s}`);
  const [whole, fraction = ""] = s.split(".");
  return [BigInt(whole + fraction), fraction.length];
}
function compareDecimal(a, b) {
  const [x, xs] = decimal(a), [y, ys] = decimal(b), scale = Math.max(xs, ys);
  const left = x * 10n ** BigInt(scale - xs), right = y * 10n ** BigInt(scale - ys);
  return left < right ? -1 : left > right ? 1 : 0;
}
function day(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`\u65E5\u4ED8\u306F YYYY-MM-DD: ${s}`);
  const [y, m, d] = s.split("-").map(Number), leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > months[m - 1]) throw new Error(`\u5B9F\u5728\u3057\u306A\u3044\u65E5\u4ED8\u3067\u3059: ${s}`);
  const prev = y - 1;
  return prev * 365 + Math.floor(prev / 4) - Math.floor(prev / 100) + Math.floor(prev / 400) + months.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
}
function validValue(type, value, choices) {
  if (type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (type === "enum") return !choices || choices.includes(value);
  try {
    if (type === "number") decimal(value);
    if (type === "date") day(value);
    return true;
  } catch {
    return false;
  }
}
function interval(type, r) {
  if (type === "date") return { low: r.lower === null ? day("0001-01-01") : day(r.lower) + (r.lowerInclusive ? 0 : 1), high: r.upper === null ? day("9999-12-31") : day(r.upper) - (r.upperInclusive ? 0 : 1), li: true, hi: true };
  if (r.lower !== null) decimal(r.lower);
  if (r.upper !== null) decimal(r.upper);
  return { low: r.lower, high: r.upper, li: r.lowerInclusive, hi: r.upperInclusive };
}
var cmp = (a, b) => typeof a === "number" ? Math.sign(a - b) : compareDecimal(a, b);
function rangeEmpty(type, r) {
  const i = interval(type, r);
  if (i.low === null || i.high === null) return false;
  const c = cmp(i.low, i.high);
  return c > 0 || c === 0 && !(i.li && i.hi);
}
function partitionsOverlap(type, a, b) {
  if (a.kind === "missing" || b.kind === "missing") return a.kind === b.kind;
  if (a.kind === "values" && b.kind === "values") return a.values.some((x2) => b.values.includes(x2));
  if (a.kind !== "range" || b.kind !== "range") return false;
  const x = interval(type, a.range), y = interval(type, b.range);
  if (x.high !== null && y.low !== null) {
    const c = cmp(x.high, y.low);
    if (c < 0 || c === 0 && !(x.hi && y.li)) return false;
  }
  if (y.high !== null && x.low !== null) {
    const c = cmp(y.high, x.low);
    if (c < 0 || c === 0 && !(y.hi && x.li)) return false;
  }
  return true;
}
function validate(table) {
  const shape = checkShape(table);
  if (shape.length) return shape.map((message) => ({ level: "error", target: "$", message }));
  const ds = [], error = (target, message) => ds.push({ level: "error", target, message });
  const unique = (ids, target) => {
    if (new Set(ids).size !== ids.length) error(target, "ID/\u5019\u88DC\u306E\u91CD\u8907\u304C\u3042\u308A\u307E\u3059");
  };
  unique(table.conditions.map((c) => c.id), "conditions");
  unique(table.outputs.map((o) => o.id), "outputs");
  unique(table.rules.map((r) => r.id), "rules");
  for (const c of table.conditions) {
    unique(c.partitions.map((p) => p.id), c.id);
    for (const p of c.partitions) {
      try {
        if (p.kind === "values") {
          if (["number", "date"].includes(c.type)) error(c.id, "\u6570\u5024\u30FB\u65E5\u4ED8\u306E\u5024\u306F\u7BC4\u56F2\u3067\u5B9A\u7FA9\u3057\u3066\u304F\u3060\u3055\u3044");
          unique(p.values.map(stable), p.id);
          if (p.values.some((v) => !validValue(c.type, v))) error(p.id, "\u6761\u4EF6\u306E\u578B\u3068\u5024\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
        }
        if (p.kind === "range") {
          if (!["number", "date"].includes(c.type)) error(p.id, "\u3053\u306E\u578B\u3067\u306F\u7BC4\u56F2\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
          else if (rangeEmpty(c.type, p.range)) error(p.id, "\u9006\u8EE2\u3057\u305F\u7BC4\u56F2\u307E\u305F\u306F\u7A7A\u306E\u7BC4\u56F2\u3067\u3059");
        }
      } catch (e) {
        error(p.id, String(e.message));
      }
    }
    for (let i = 0; i < c.partitions.length; i++) for (let j = i + 1; j < c.partitions.length; j++) {
      try {
        if (partitionsOverlap(c.type, c.partitions[i], c.partitions[j])) error(c.id, `\u6761\u4EF6\u306E\u5024\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${c.partitions[i].label} / ${c.partitions[j].label}`);
      } catch {
      }
    }
  }
  for (const o of table.outputs) if (o.kind === "result" && o.type === "enum") unique(o.values ?? [], o.id);
  if (table.rules.length && !table.conditions.length) error("conditions", "\u898F\u5247\u306B\u306F\u6761\u4EF6\u5B9A\u7FA9\u304C\u5FC5\u8981\u3067\u3059");
  for (const r of table.rules) {
    for (const clause2 of r.anyOf) {
      unique(clause2.selections.map((s) => s.conditionId), r.id);
      if (table.schemaVersion === "1.0" && clause2.selections.length !== table.conditions.length) error(r.id, "\u5404\u6761\u4EF6\u30921\u56DE\u305A\u3064\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\uFF08\u6761\u4EF6\u306E\u7701\u7565\u306F\u30B9\u30AD\u30FC\u30DE1.1\u306E\u307F\uFF09");
      for (const s of clause2.selections) {
        const c = table.conditions.find((c2) => c2.id === s.conditionId);
        unique(s.partitionIds, r.id);
        if (!c || s.partitionIds.some((id2) => !c.partitions.some((p) => p.id === id2))) error(r.id, "\u672A\u77E5\u306E\u6761\u4EF6\u30FB\u5024\u3078\u306E\u53C2\u7167\u3067\u3059");
      }
    }
    if (r.directives.length !== table.outputs.length) error(r.id, "\u3059\u3079\u3066\u306E\u52D5\u4F5C\u306B\u3064\u3044\u3066\u52D5\u4F5C\u6307\u5B9A\u304C\u5FC5\u8981\u3067\u3059");
    r.directives.forEach((d, i) => {
      const o = table.outputs[i];
      if (!o || d.outputId !== o.id) error(r.id, "\u52D5\u4F5C\u306E\u53C2\u7167\u307E\u305F\u306F\u9806\u5E8F\u304C\u4E0D\u6B63\u3067\u3059");
      else if (d.state === "set" && !validValue(o.kind === "action" ? "boolean" : o.type, d.value, o.kind === "result" ? o.values : void 0)) error(r.id, `\u52D5\u4F5C\u300C${o.name}\u300D\u306E\u578B\u307E\u305F\u306F\u5024\u304C\u4E0D\u6B63\u3067\u3059`);
    });
  }
  return ds;
}
function assertValid(t) {
  const errors = validate(t);
  if (errors.length) throw new Error(errors.slice(0, 8).map((e) => `${e.target}: ${e.message}`).join("\n"));
}
function decode(text2) {
  if (new TextEncoder().encode(text2).byteLength > 10 * 1024 * 1024) throw new Error("JSON\u306F10MiB\u4EE5\u4E0B\u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  const t = JSON.parse(text2);
  assertValid(t);
  return t;
}
function normalizedDirectives(t, ds) {
  return ds.map((d, i) => {
    const o = t.outputs[i];
    if (o?.kind === "action" && d.state === "set" && d.value !== true) return { outputId: d.outputId, state: "unset" };
    if (d.state === "set" && o?.kind === "result" && o.type === "number" && typeof d.value === "string") {
      let [value, scale] = decimal(d.value);
      while (scale > 0 && value % 10n === 0n) {
        value /= 10n;
        scale--;
      }
      return { ...d, value: `${value}:${scale}` };
    }
    return d;
  });
}
function valueKey(t, r, o) {
  const d = normalizedDirectives(t, r.directives)[o];
  return !d || d.state !== "set" ? null : stable(d.value);
}
var fullMask = (c) => (1n << BigInt(c.partitions.length)) - 1n;
function bits(m) {
  let n = 0;
  for (; m; m >>= 1n) if (m & 1n) n++;
  return n;
}
var cubeSize = (c) => c.reduce((n, m) => n * BigInt(bits(m)), 1n);
var cubesDisjoint = (a, b) => a.some((m, i) => (m & b[i]) === 0n);
function clauseCube(t, clause2) {
  return t.conditions.map((c) => {
    const s = clause2.selections.find((s2) => s2.conditionId === c.id);
    if (!s) return fullMask(c);
    let m = 0n;
    for (const id2 of s.partitionIds) {
      const i = c.partitions.findIndex((p) => p.id === id2);
      if (i >= 0) m |= 1n << BigInt(i);
    }
    return m;
  });
}
var ruleCubes = (t, r) => r.anyOf.map((c) => clauseCube(t, c));
var rulesDisjoint = (a, b) => a.every((x) => b.every((y) => cubesDisjoint(x, y)));
function subtractCube(a, b) {
  if (cubesDisjoint(a, b)) return [a];
  const out = [], cur = a.slice();
  for (let i = 0; i < a.length; i++) {
    const rest = cur[i] & ~b[i];
    if (rest) {
      const p = cur.slice();
      p[i] = rest;
      out.push(p);
    }
    cur[i] &= b[i];
  }
  return out;
}
function inspect(t, picks) {
  assertValid(t);
  if (!t.conditions.length) return { total: 0n, exact: false, rules: [], uncovered: 0n, conflict: false, determined: false, relevant: [], outputs: [] };
  const region = t.conditions.map((c) => {
    const i = c.partitions.findIndex((p) => p.id === picks[c.id]);
    return i < 0 ? fullMask(c) : 1n << BigInt(i);
  });
  const rules = [], inRange = [];
  const minus = (cubes) => {
    let left = [region], work = 0;
    for (const c of cubes) {
      work += left.length;
      left = left.flatMap((a) => subtractCube(a, c));
      if (left.length > 5e4 || work > 1e6) return null;
      if (!left.length) break;
    }
    return left;
  };
  for (let index = 0; index < t.rules.length; index++) {
    const r = t.rules[index], cubes = ruleCubes(t, r).filter((c) => !cubesDisjoint(c, region)).map((c) => c.map((m, k) => m & region[k]));
    if (!cubes.length) continue;
    const left = minus(cubes);
    rules.push({ index, ruleId: r.id, directives: clone(r.directives), always: left !== null && left.length === 0 });
    inRange.push({ index, cubes, keys: t.outputs.map((_, o) => valueKey(t, r, o)) });
  }
  const none = minus(inRange.flatMap((x) => x.cubes)), uncovered = none ? none.reduce((n, c) => n + cubeSize(c), 0n) : null;
  const openConditions = /* @__PURE__ */ new Set();
  const outputs = t.outputs.map((o, at) => {
    const setters = inRange.filter((x) => x.keys[at] !== null), groups = /* @__PURE__ */ new Map();
    for (const x of setters) {
      const g = groups.get(x.keys[at]) ?? { directive: clone(t.rules[x.index].directives[at]), rules: [] };
      g.rules.push(x.index);
      groups.set(x.keys[at], g);
    }
    const candidates = [...groups.values()], all = setters.map((x) => x.index);
    if (!setters.length) return { outputId: o.id, status: "none", rules: all, candidates };
    let clash = false;
    for (let i = 0; i < setters.length && !clash; i++) for (let j = i + 1; j < setters.length && !clash; j++) if (setters[i].keys[at] !== setters[j].keys[at] && !rulesDisjoint(setters[i].cubes, setters[j].cubes)) clash = true;
    if (clash) return { outputId: o.id, status: "conflict", rules: all, candidates };
    const left = candidates.length === 1 ? minus(setters.flatMap((x) => x.cubes)) : null;
    if (candidates.length === 1 && left !== null && left.length === 0) return { outputId: o.id, status: "determined", directive: candidates[0].directive, rules: all, candidates };
    t.conditions.forEach((c, k) => {
      if (!c.partitions.some((p) => p.id === picks[c.id]) && setters.some((x) => x.cubes.some((cube) => cube[k] !== fullMask(c)))) openConditions.add(k);
    });
    return { outputId: o.id, status: "open", rules: all, candidates };
  });
  return {
    total: cubeSize(region),
    exact: t.conditions.every((c) => c.partitions.some((p) => p.id === picks[c.id])),
    rules,
    uncovered,
    conflict: outputs.some((x) => x.status === "conflict"),
    determined: rules.length > 0 && outputs.length > 0 && outputs.every((x) => x.status === "determined" || x.status === "none"),
    relevant: t.conditions.filter((_, k) => openConditions.has(k)).map((c) => c.id),
    outputs
  };
}
function partitionOf(c, value) {
  if (value !== null && !validValue(c.type, value)) throw new Error(`\u6761\u4EF6\u300C${c.name}\u300D\u306E\u578B\uFF08${c.type}\uFF09\u306B\u5408\u308F\u306A\u3044\u5024\u3067\u3059: ${String(value)}`);
  for (const p of c.partitions) {
    if (p.kind === "missing") {
      if (value === null) return p.id;
      continue;
    }
    if (value === null) continue;
    if (p.kind === "values") {
      if (p.values.includes(value)) return p.id;
      continue;
    }
    if (typeof value !== "string" || c.type !== "number" && c.type !== "date") continue;
    const i = interval(c.type, p.range), v = c.type === "date" ? day(value) : value;
    const low = i.low === null ? 1 : cmp(v, i.low), high = i.high === null ? -1 : cmp(v, i.high);
    if ((low > 0 || low === 0 && i.li) && (high < 0 || high === 0 && i.hi)) return p.id;
  }
  return null;
}

// src/engine.ts
var version = "0.3.1";
function load(source) {
  if (typeof source === "string") return decode(source);
  const t = clone(source);
  assertValid(t);
  return t;
}
function conditions(table) {
  return table.conditions.map((c) => ({ id: c.id, name: c.name, type: c.type, values: c.partitions.map((p) => ({ id: p.id, label: p.label })) }));
}
function actions(table) {
  return table.outputs.map((o) => ({ id: o.id, name: o.name, kind: o.kind }));
}
function resolve(table, input) {
  const found = [], ignored = [], seen = /* @__PURE__ */ new Set();
  for (const [key, value] of Object.entries(input)) {
    if (value === void 0) continue;
    const byName = table.conditions.filter((c2) => c2.name === key), c = table.conditions.find((c2) => c2.id === key) ?? (byName.length === 1 ? byName[0] : void 0);
    if (!c) {
      if (byName.length > 1) throw new Error(`\u300C${key}\u300D\u3068\u3044\u3046\u540D\u524D\u306E\u6761\u4EF6\u304C\u8907\u6570\u3042\u308A\u307E\u3059\u3002\u6761\u4EF6\u306EID\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
      ignored.push(key);
      continue;
    }
    if (seen.has(c.id)) throw new Error(`\u6761\u4EF6\u300C${c.name}\u300D\u304C2\u56DE\u6307\u5B9A\u3055\u308C\u3066\u3044\u307E\u3059`);
    seen.add(c.id);
    found.push([c, value]);
  }
  return { found, ignored };
}
function classify(table, values) {
  const picks = {};
  for (const [c, raw] of resolve(table, values).found) {
    let value = raw;
    if (typeof value === "number") {
      if (c.type !== "number" || !Number.isFinite(value) || !/^-?\d+(\.\d+)?$/.test(String(value))) throw new Error(`\u6761\u4EF6\u300C${c.name}\u300D\u306E\u5024\u3092\u6570\u5024\u3068\u3057\u3066\u6271\u3048\u307E\u305B\u3093: ${String(value)}\uFF08\u6841\u306E\u591A\u3044\u6570\u5024\u306F\u6587\u5B57\u5217\u3067\u6E21\u3057\u3066\u304F\u3060\u3055\u3044\uFF09`);
      value = String(value);
    }
    if (value !== null && typeof value !== "boolean" && typeof value !== "string") throw new Error(`\u6761\u4EF6\u300C${c.name}\u300D\u306E\u5024\u306E\u578B\u304C\u4E0D\u6B63\u3067\u3059`);
    const id2 = partitionOf(c, value);
    if (id2 === null) throw new Error(`\u6761\u4EF6\u300C${c.name}\u300D\u306E\u5024 ${value === null ? "\uFF08\u5024\u306A\u3057\uFF09" : String(value)} \u306F\u3001\u5B9A\u7FA9\u3055\u308C\u305F\u5024\u306E\u3069\u308C\u306B\u3082\u5F53\u3066\u306F\u307E\u308A\u307E\u305B\u3093`);
    picks[c.id] = id2;
  }
  return picks;
}
function evaluate(table, picks) {
  assertValid(table);
  const { found, ignored } = resolve(table, picks), chosen = {};
  for (const [c, value] of found) {
    const byLabel = c.partitions.filter((p2) => p2.label === value), p = c.partitions.find((p2) => p2.id === value) ?? (byLabel.length === 1 ? byLabel[0] : void 0);
    if (!p) throw new Error(byLabel.length > 1 ? `\u6761\u4EF6\u300C${c.name}\u300D\u306B\u300C${String(value)}\u300D\u3068\u3044\u3046\u30E9\u30D9\u30EB\u306E\u5024\u304C\u8907\u6570\u3042\u308A\u307E\u3059\u3002\u5024\u306EID\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044` : `\u6761\u4EF6\u300C${c.name}\u300D\u306B\u300C${String(value)}\u300D\u3068\u3044\u3046\u5024\u306F\u3042\u308A\u307E\u305B\u3093`);
    chosen[c.id] = p.id;
  }
  const found2 = inspect(table, chosen), by = new Map(found2.outputs.map((o) => [o.outputId, o]));
  const results = table.outputs.map((o) => {
    const x = by.get(o.id), status = x?.status ?? "none", set = (d) => d && d.state === "set" ? d.value : null;
    const candidates = (x?.candidates ?? []).map((c) => set(c.directive)).filter((v) => v !== null && !(o.kind === "action" && v !== true));
    return { id: o.id, name: o.name, kind: o.kind, status, executed: status === "determined" ? true : status === "none" ? false : null, value: status === "determined" ? set(x.directive) : null, candidates, rules: (x?.rules ?? []).map((i) => table.rules[i].id) };
  });
  return {
    decided: results.every((r) => r.status === "determined" || r.status === "none"),
    complete: table.conditions.every((c) => chosen[c.id] !== void 0),
    conflict: results.some((r) => r.status === "conflict"),
    actions: results,
    needed: found2.relevant,
    rules: found2.rules.map((r) => ({ id: r.ruleId, number: r.index + 1, always: r.always })),
    ignored
  };
}
export {
  actions,
  classify,
  conditions,
  evaluate,
  load,
  version
};
