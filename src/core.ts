// TASK-001..014 / REQ-001..013, REQ-019. Wording follows JIS X 0125 (decision tables) where the standard has a term. / DOM-001..009 / DR-010,011 / API-001..005.
import { checkShape } from './schema.ts';
export type DataType = 'boolean' | 'enum' | 'number' | 'string' | 'date';
export type Scalar = boolean | string;
export type Bound = { lower: string | null; upper: string | null; lowerInclusive: boolean; upperInclusive: boolean };
export type Partition = { id: string; label: string; kind: 'values'; values: Scalar[] } | { id: string; label: string; kind: 'range'; range: Bound } | { id: string; label: string; kind: 'missing' };
export type Condition = { id: string; name: string; type: DataType; partitions: Partition[] };
export type Output = { id: string; name: string; kind: 'action' } | { id: string; name: string; kind: 'result'; type: DataType; values?: string[] };
export type Directive = { outputId: string; state: 'unset' } | { outputId: string; state: 'set'; value: Scalar };
export type Clause = { selections: { conditionId: string; partitionIds: string[] }[] };
export type Rule = { id: string; anyOf: Clause[]; directives: Directive[] };
export type Table = { schemaVersion: '1.0' | '1.1'; id: string; title: string; conditions: Condition[]; outputs: Output[]; rules: Rule[] };
export type Atom = Record<string, string>;
export type Diagnostic = { level: 'error' | 'warning' | 'info'; target: string; message: string };
export type Candidate = { id: string; base: string; before: string[]; replacement: Rule; checked: number; proof: 'enumeration' | 'structural'; anchor?: string };
export const LIMIT = 10000;
export const uid = (prefix = 'id') => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
export const clone = <T>(v: T): T => structuredClone(v);
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const emptyTable = (): Table => ({ schemaVersion: '1.1', id: uid('table'), title: '新しい決定表', conditions: [], outputs: [], rules: [] });
function decimal(s: string): [bigint, number] {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s) || s.length > 128) throw new Error(`数値の形式が不正です: ${s}`);
  const [whole, fraction = ''] = s.split('.');
  return [BigInt(whole + fraction), fraction.length];
}
export function compareDecimal(a: string, b: string): number {
  const [x, xs] = decimal(a), [y, ys] = decimal(b), scale = Math.max(xs, ys);
  const left = x * 10n ** BigInt(scale - xs), right = y * 10n ** BigInt(scale - ys);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function day(s: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`日付は YYYY-MM-DD: ${s}`);
  const [y, m, d] = s.split('-').map(Number), leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > months[m - 1]) throw new Error(`実在しない日付です: ${s}`);
  const prev = y - 1;
  return prev * 365 + Math.floor(prev / 4) - Math.floor(prev / 100) + Math.floor(prev / 400) + months.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
}
function validValue(type: DataType, value: Scalar, choices?: string[]): boolean {
  if (type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  if (type === 'enum') return !choices || choices.includes(value);
  try { if (type === 'number') decimal(value); if (type === 'date') day(value); return true; } catch { return false; }
}
function interval(type: DataType, r: Bound): { low: string | number | null; high: string | number | null; li: boolean; hi: boolean } {
  if (type === 'date') return { low: r.lower === null ? day('0001-01-01') : day(r.lower) + (r.lowerInclusive ? 0 : 1), high: r.upper === null ? day('9999-12-31') : day(r.upper) - (r.upperInclusive ? 0 : 1), li: true, hi: true };
  if (r.lower !== null) decimal(r.lower); if (r.upper !== null) decimal(r.upper);
  return { low: r.lower, high: r.upper, li: r.lowerInclusive, hi: r.upperInclusive };
}
const cmp = (a: string | number, b: string | number) => typeof a === 'number' ? Math.sign(a - (b as number)) : compareDecimal(a, b as string);
function rangeEmpty(type: DataType, r: Bound) {
  const i = interval(type, r); if (i.low === null || i.high === null) return false;
  const c = cmp(i.low, i.high); return c > 0 || (c === 0 && !(i.li && i.hi));
}
export function partitionsOverlap(type: DataType, a: Partition, b: Partition): boolean {
  if (a.kind === 'missing' || b.kind === 'missing') return a.kind === b.kind;
  if (a.kind === 'values' && b.kind === 'values') return a.values.some(x => b.values.includes(x));
  if (a.kind !== 'range' || b.kind !== 'range') return false;
  const x = interval(type, a.range), y = interval(type, b.range);
  if (x.high !== null && y.low !== null) { const c = cmp(x.high, y.low); if (c < 0 || (c === 0 && !(x.hi && y.li))) return false; }
  if (y.high !== null && x.low !== null) { const c = cmp(y.high, x.low); if (c < 0 || (c === 0 && !(y.hi && x.li))) return false; }
  return true;
}
export function validate(table: Table): Diagnostic[] {
  const shape = checkShape(table); if (shape.length) return shape.map(message => ({ level: 'error', target: '$', message }));
  const ds: Diagnostic[] = [], error = (target: string, message: string) => ds.push({ level: 'error', target, message });
  const unique = (ids: string[], target: string) => { if (new Set(ids).size !== ids.length) error(target, 'ID/候補の重複があります'); };
  unique(table.conditions.map(c => c.id), 'conditions'); unique(table.outputs.map(o => o.id), 'outputs'); unique(table.rules.map(r => r.id), 'rules');
  for (const c of table.conditions) {
    unique(c.partitions.map(p => p.id), c.id);
    for (const p of c.partitions) {
      try {
        if (p.kind === 'values') { if (['number', 'date'].includes(c.type)) error(c.id, '数値・日付の値は範囲で定義してください'); unique(p.values.map(stable), p.id); if (p.values.some(v => !validValue(c.type, v))) error(p.id, '条件の型と値が一致しません'); }
        if (p.kind === 'range') { if (!['number', 'date'].includes(c.type)) error(p.id, 'この型では範囲を指定できません'); else if (rangeEmpty(c.type, p.range)) error(p.id, '逆転した範囲または空の範囲です'); }
      } catch (e) { error(p.id, String((e as Error).message)); }
    }
    for (let i = 0; i < c.partitions.length; i++) for (let j = i + 1; j < c.partitions.length; j++) {
      try { if (partitionsOverlap(c.type, c.partitions[i], c.partitions[j])) error(c.id, `条件の値が重複しています: ${c.partitions[i].label} / ${c.partitions[j].label}`); } catch { /* already diagnosed */ }
    }
  }
  for (const o of table.outputs) if (o.kind === 'result' && o.type === 'enum') unique(o.values ?? [], o.id);
  if (table.rules.length && !table.conditions.length) error('conditions', '規則には条件定義が必要です');
  for (const r of table.rules) {
    for (const clause of r.anyOf) {
      unique(clause.selections.map(s => s.conditionId), r.id);
      // DAT-004: only schema 1.1 may omit a condition (omitted = every partition, including ones added later).
      if (table.schemaVersion === '1.0' && clause.selections.length !== table.conditions.length) error(r.id, '各条件を1回ずつ指定してください（条件の省略はスキーマ1.1のみ）');
      for (const s of clause.selections) {
        const c = table.conditions.find(c => c.id === s.conditionId); unique(s.partitionIds, r.id);
        if (!c || s.partitionIds.some(id => !c.partitions.some(p => p.id === id))) error(r.id, '未知の条件・値への参照です');
      }
    }
    if (r.directives.length !== table.outputs.length) error(r.id, 'すべての動作について動作指定が必要です');
    r.directives.forEach((d, i) => {
      const o = table.outputs[i];
      if (!o || d.outputId !== o.id) error(r.id, '動作の参照または順序が不正です');
      else if (d.state === 'set' && !validValue(o.kind === 'action' ? 'boolean' : o.type, d.value, o.kind === 'result' ? o.values : undefined)) error(r.id, `動作「${o.name}」の型または値が不正です`);
    });
  }
  return ds;
}
export function assertValid(t: Table): void { const errors = validate(t); if (errors.length) throw new Error(errors.slice(0, 8).map(e => `${e.target}: ${e.message}`).join('\n')); }
export function decode(text: string): Table {
  if (new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error('JSONは10MiB以下にしてください');
  const t = JSON.parse(text) as Table; assertValid(t); return t;
}
export function encode(t: Table): string { assertValid(t); return JSON.stringify(JSON.parse(stable(t)), null, 2) + '\n'; }
export function count(t: Pick<Table, 'conditions'>): bigint { return t.conditions.length ? t.conditions.reduce((n, c) => n * BigInt(c.partitions.length), 1n) : 0n; }
export function atoms(t: Pick<Table, 'conditions'>, limit = LIMIT): Atom[] {
  if (count(t) > BigInt(limit)) throw new Error(`条件指定の全組合せ${count(t)}件は計算予算${limit}件を超えるため列挙できません。規則を1行ずつ記述してください（検証・簡単化・解釈は列挙なしで利用できます）`);
  if (!t.conditions.length) return [];
  let cells: Atom[] = [{}];
  for (const c of t.conditions) cells = cells.flatMap(a => c.partitions.map(p => ({ ...a, [c.id]: p.id })));
  return cells;
}
export function matches(rule: Rule, atom: Atom): boolean { return rule.anyOf.some(c => c.selections.every(s => s.partitionIds.includes(atom[s.conditionId]))); }
export function trace(table: Table, atom: Atom): Directive[][] { return table.rules.filter(r => matches(r, atom)).map(r => r.directives); }
function normalizedDirectives(t: Table, ds: Directive[]): unknown[] {
  return ds.map((d, i) => {
    const o = t.outputs[i];
    // TASK-008 / JIS X 0125 3.3: for a limited-entry action, "not executed" is the entry "-" whether stored as false or unset.
    if (o?.kind === 'action' && d.state === 'set' && d.value !== true) return { outputId: d.outputId, state: 'unset' };
    if (d.state === 'set' && o?.kind === 'result' && o.type === 'number' && typeof d.value === 'string') {
      let [value, scale] = decimal(d.value); while (scale > 0 && value % 10n === 0n) { value /= 10n; scale--; }
      return { ...d, value: `${value}:${scale}` };
    }
    return d;
  });
}
// TASK-007, TASK-008 / INS-006, DEC-028, DEC-029: rules are combined per action. A rule specifies only the actions it
// concerns; the entry "-" (unset, or false for an X/- action) contributes nothing. An X/- action is executed when
// some satisfied rule marks it X. The result of an input is, for every output, the set of distinct
// values set by the rules that match. One value = decided, several = contradiction, none = undecided.
// Rule order and the number of matching rules carry no meaning.
function valueKey(t: Table, r: Rule, o: number): string | null {
  const d = normalizedDirectives(t, r.directives)[o] as { state?: string; value?: unknown } | undefined;
  return !d || d.state !== 'set' ? null : stable(d.value); // null = the entry "-"
}
export function resultOf(t: Table, atom: Atom): string[][] {
  const sets = t.outputs.map(() => new Set<string>());
  for (const r of t.rules) if (matches(r, atom)) t.outputs.forEach((_, o) => { const k = valueKey(t, r, o); if (k !== null) sets[o].add(k); });
  return sets.map(x => [...x].sort());
}
export function traceKey(t: Table, atom: Atom): string { return stable(resultOf(t, atom)); }
function distinctOutcomes(t: Table, list: Directive[][]): Directive[][] { const seen = new Set<string>(); return list.filter(ds => { const k = stable(normalizedDirectives(t, ds)); if (seen.has(k)) return false; seen.add(k); return true; }); }
export function generate(t: Table): Table {
  assertValid(t); const cells = atoms(t); if (!cells.length) throw new Error('条件を追加してください');
  return { ...clone(t), rules: cells.map(a => ({ id: uid('r'), anyOf: [{ selections: t.conditions.map(c => ({ conditionId: c.id, partitionIds: [a[c.id]] })) }], directives: t.outputs.map(o => ({ outputId: o.id, state: 'unset' as const })) })) };
}
export function verifyEquivalent(a: Table, b: Table, budget = 2_000_000): { equal: boolean; checked: number; reason?: string } {
  assertValid(a); assertValid(b);
  if (stable(a.conditions) !== stable(b.conditions) || stable(a.outputs) !== stable(b.outputs)) return { equal: false, checked: 0, reason: '定義が異なります' };
  const cells = atoms(a);
  const weight = (t: Table) => t.rules.reduce((n, r) => n + r.anyOf.reduce((n, c) => n + c.selections.reduce((n, s) => n + s.partitionIds.length, 0), 0), 0);
  if (cells.length * (weight(a) + weight(b) + 1) > budget) return { equal: false, checked: 0, reason: '証明の計算予算を超えます' };
  for (let i = 0; i < cells.length; i++) if (traceKey(a, cells[i]) !== traceKey(b, cells[i])) return { equal: false, checked: i + 1, reason: '条件の組合せに対する動作が異なります' };
  return { equal: true, checked: cells.length };
}
export function replaceCandidate(t: Table, c: Candidate): Table {
  // TASK-003: the merged rule takes the anchor rule's position (the first rule when no anchor is given).
  const at = t.rules.findIndex(r => r.id === (c.anchor ?? c.before[0]));
  const rules = t.rules.flatMap((r, i) => i === at ? [clone(c.replacement)] : c.before.includes(r.id) ? [] : [clone(r)]);
  // DAT-004: a replacement that omits a condition ("all") needs schema 1.1.
  const omits = c.replacement.anyOf.some(clause => clause.selections.length < t.conditions.length);
  return { ...clone(t), schemaVersion: omits ? '1.1' : t.schemaVersion, rules };
}
// REQ-011. Every candidate is first proven from rule overlap and order (DR-011) and clause set equality.
// Tables within the enumeration budget are additionally compared input by input.
export function proposeMerges(t: Table): Candidate[] {
  assertValid(t); const proposed = proposeStructural(t);
  if (count(t) > BigInt(LIMIT)) return proposed;
  const result: Candidate[] = []; let remainingBudget = 5_000_000;
  for (const c of proposed) {
    const b = replaceCandidate(t, c), cost = Number(count(t)) * (t.rules.length + b.rules.length + 1);
    if (cost > remainingBudget) { result.push(c); continue; }
    remainingBudget -= cost;
    const check = verifyEquivalent(t, b, Math.min(2_000_000, remainingBudget + cost));
    if (check.equal) result.push({ ...c, proof: 'enumeration', checked: check.checked });
    else if (check.checked === 0 && check.reason === '証明の計算予算を超えます') result.push(c);
    // any other mismatch drops the candidate: the two proofs must agree (fail closed).
  }
  return result;
}
export function applyCandidate(t: Table, c: Candidate): Table {
  if (stable(t) !== c.base) throw new Error('表が変更されたため候補は失効しました。再計算してください');
  if (!verifyStructural(t, c)) throw new Error('等価性を確認できません: 規則の重なりと順序から証明できません');
  const b = replaceCandidate(t, c);
  if (c.proof === 'enumeration') { const proof = verifyEquivalent(t, b); if (!proof.equal) throw new Error(`等価性を確認できません: ${proof.reason}`); }
  assertValid(b); return b;
}
export function diagnose(t: Table): Diagnostic[] {
  const result = validate(t); if (result.length) return result;
  for (const r of t.rules) if (t.outputs.length && idle(t, r)) result.push({ level: 'warning', target: r.id, message: 'この規則は動作を何も指定していません（動作指定がすべて「−」です）' });
  try {
    // TASK-002 / REQ-008: coverage is computed on partition-set products, never by enumerating the input space.
    const total = count(t);
    if (total > 0n) {
      const cov = coverage(t);
      if (!cov.complete) result.push({ level: 'warning', target: 'rules', message: '完備性は計算予算を超えたため判定できていません（完備しているとは判定していません）' });
      else if (cov.uncovered) {
        result.push({ level: 'warning', target: 'rules', message: `完備していません：条件指定の${cov.uncovered}組合せを満足する規則がありません（定義した値の範囲内）` });
        cov.chunks.slice(0, 20).forEach(chunk => result.push({ level: 'warning', target: '完備性', message: `${describeChunk(t, chunk)}（${chunk.size}組合せ）` }));
        if (cov.chunks.length > 20) result.push({ level: 'warning', target: '完備性', message: `ほか${cov.chunks.length - 20}個のかたまりがあります。規則を追加して再検証してください` });
      }
      // TASK-004, TASK-007 / REQ-008: rules that can match the same input must not set different values for an output.
      const clash = contradictions(t);
      if (clash.pairs) {
        result.push({ level: 'error', target: 'rules', message: `${clash.pairs}組${clash.complete ? '' : '以上'}の規則で動作指定が一致しません。同じ条件の組合せで満足される規則が、同じ動作に異なる値を指定しているため、単適合決定表になりません` });
        clash.examples.forEach(e => result.push({ level: 'error', target: '不一致', message: `規則 #${e.rules[0] + 1} と #${e.rules[1] + 1}：${describeChunk(t, e.chunk)}（${e.chunk.size}組合せ${e.more ? 'ほか' : ''}）で動作「${e.outputs.map(o => t.outputs[o].name).join('」「')}」の指定が異なります` }));
        if (clash.pairs > clash.examples.length) result.push({ level: 'error', target: '不一致', message: `ほか${clash.pairs - clash.examples.length}組あります。規則を直して再検証してください` });
      }
      if (clash.same) result.push({ level: 'info', target: 'rules', message: `${clash.same}組${clash.complete ? '' : '以上'}の規則が同じ指定で重なっています。「簡単化」で結合できます` });
      if (!clash.complete) result.push({ level: 'warning', target: 'rules', message: '動作指定の不一致の確認は計算予算で打ち切りました（残りは判定できていません）' });
    }
    const keys = new Set<string>(); for (const r of t.rules) { const k = stable({ anyOf: r.anyOf, directives: r.directives }); if (keys.has(k)) result.push({ level: 'warning', target: r.id, message: '同じ条件指定と動作指定の規則が重複しています。「簡単化」で1つに結合できます' }); keys.add(k); }
  } catch (e) { result.push({ level: 'warning', target: 'rules', message: (e as Error).message }); }
  return result;
}
// Number of distinct combined results, computed without enumerating inputs (inputs with no rule count as one pattern).
export function patternCount(t: Table): number {
  const found = patterns(t); if (!found) throw new Error('単適合に展開した規則数は計算予算のため未算出');
  return found.length;
}
// Conservative result migration; never infer business validity or changed interval membership.
export function regeneratePreserving(old: Table, next: Table): { table: Table; affected: number } {
  assertValid(old); assertValid(next); const fresh = generate({ ...next, rules: [] });
  const common = old.conditions.filter(c => next.conditions.some(n => n.id === c.id));
  const changed = common.some(c => stable({ type: c.type, partitions: c.partitions }) !== stable({ type: next.conditions.find(n => n.id === c.id)!.type, partitions: next.conditions.find(n => n.id === c.id)!.partitions }));
  if (changed) return { table: fresh, affected: fresh.rules.length };
  const shared = common.map(c => c.id); const key = (a: Atom) => stable(shared.map(id => a[id]));
  const buckets = new Map<string, Directive[][] | null>();
  for (const a of atoms(old)) { const k = key(a), value = distinctOutcomes(old, trace(old, a)); if (!buckets.has(k)) buckets.set(k, clone(value)); else if (stable(buckets.get(k)) !== stable(value)) buckets.set(k, null); }
  let affected = 0; const rules: Rule[] = [];
  for (const base of fresh.rules) {
    const a = Object.fromEntries(base.anyOf[0].selections.map(s => [s.conditionId, s.partitionIds[0]]));
    const values = buckets.get(key(a));
    if (!values || !values.length) { rules.push(base); affected++; continue; }
    for (const ds of values) rules.push({ ...clone(base), id: uid('r'), directives: next.outputs.map(o => { const d = ds.find(d => d.outputId === o.id); const previous = old.outputs.find(x => x.id === o.id); const compatible = previous && stable({ ...previous, name: '' }) === stable({ ...o, name: '' }); return d && compatible ? clone(d) : { outputId: o.id, state: 'unset' }; }) });
  }
  const result = { ...fresh, rules }; assertValid(result); return { table: result, affected };
}

// REQ-012: retain the mapping from each original input atom to matched rules and ordered outcomes.
export function expandRows(t: Table, displayLimit = 1000): { atom: Atom; matches: { ruleId: string; directives: Directive[] }[] }[] {
  assertValid(t); const cells = atomsHead(t, displayLimit);
  const weight = t.rules.reduce((n, r) => n + r.anyOf.reduce((n, c) => n + c.selections.reduce((n, s) => n + s.partitionIds.length, 0), 0), 0);
  if (Math.min(cells.length, displayLimit) * weight > 2_000_000) throw new Error('全組合せの表示は計算予算を超えます。規則を簡単化してください');
  return cells.slice(0, displayLimit).map(atom => ({ atom, matches: t.rules.filter(r => matches(r, atom)).map(r => ({ ruleId: r.id, directives: clone(r.directives) })) }));
}

// ---------------------------------------------------------------------------------------------
// TASK-002 / INS-001, CHG-001..003 / REQ-001,008,011,012,013 / DR-010,011 / API-002..005.
// A clause is the product of one partition set per condition, held as one bit mask per condition.
// An omitted condition is the full mask, so later partitions are included automatically (DEC-025).
export type Cube = bigint[];
export type Chunk = { selections: { conditionId: string; partitionIds: string[] }[]; size: bigint };
const fullMask = (c: Condition) => (1n << BigInt(c.partitions.length)) - 1n;
function bits(m: bigint): number { let n = 0; for (; m; m >>= 1n) if (m & 1n) n++; return n; }
const cubeSize = (c: Cube) => c.reduce((n, m) => n * BigInt(bits(m)), 1n);
const cubesDisjoint = (a: Cube, b: Cube) => a.some((m, i) => (m & b[i]) === 0n);
export function clauseCube(t: Pick<Table, 'conditions'>, clause: Clause): Cube {
  return t.conditions.map(c => {
    const s = clause.selections.find(s => s.conditionId === c.id); if (!s) return fullMask(c);
    let m = 0n; for (const id of s.partitionIds) { const i = c.partitions.findIndex(p => p.id === id); if (i >= 0) m |= 1n << BigInt(i); }
    return m;
  });
}
const ruleCubes = (t: Pick<Table, 'conditions'>, r: Rule): Cube[] => r.anyOf.map(c => clauseCube(t, c));
const rulesDisjoint = (a: Cube[], b: Cube[]) => a.every(x => b.every(y => cubesDisjoint(x, y)));
// a minus b as pairwise-disjoint products.
function subtractCube(a: Cube, b: Cube): Cube[] {
  if (cubesDisjoint(a, b)) return [a];
  const out: Cube[] = [], cur = a.slice();
  for (let i = 0; i < a.length; i++) { const rest = cur[i] & ~b[i]; if (rest) { const p = cur.slice(); p[i] = rest; out.push(p); } cur[i] &= b[i]; }
  return out;
}
// Join products that differ in exactly one condition. Keeps the union and the pairwise disjointness.
function compactCubes(cubes: Cube[], passes = 8): Cube[] {
  let list = cubes;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let d = 0; d < (list[0]?.length ?? 0); d++) {
      const groups = new Map<string, Cube>();
      for (const c of list) { const key = c.map((m, i) => i === d ? '' : m.toString(36)).join(','), g = groups.get(key); if (g) { g[d] |= c[d]; changed = true; } else groups.set(key, c.slice()); }
      list = [...groups.values()];
    }
    if (!changed) break;
  }
  return list;
}
function cubeChunk(t: Pick<Table, 'conditions'>, c: Cube): Chunk {
  return { size: cubeSize(c), selections: t.conditions.flatMap((cond, i) => c[i] === fullMask(cond) ? [] : [{ conditionId: cond.id, partitionIds: cond.partitions.filter((_, j) => (c[i] >> BigInt(j)) & 1n).map(p => p.id) }]) };
}
// REQ-008: inputs matched by no rule, as disjoint chunks. complete=false means "not determined", never "covered".
// budget bounds the number of chunks held at once, workBudget the total number of chunk operations (DEF-005).
export function coverage(t: Table, budget = 200_000, workBudget = 2_000_000, only?: (r: Rule) => boolean): { complete: boolean; uncovered: bigint; chunks: Chunk[] } {
  if (!t.conditions.length) return { complete: true, uncovered: 0n, chunks: [] };
  const unknown = { complete: false, uncovered: 0n, chunks: [] as Chunk[] };
  let rest: Cube[] = [t.conditions.map(fullMask)], work = 0, compactAt = 4096;
  for (const r of t.rules) if (!only || only(r)) for (const clause of r.anyOf) {
    if (!rest.length) break;
    const b = clauseCube(t, clause), next: Cube[] = [];
    for (const a of rest) for (const piece of subtractCube(a, b)) next.push(piece);
    work += rest.length; if (work > workBudget) return unknown;
    // Compact only after the list has doubled since the last compaction, so compaction cannot run per clause.
    if (next.length > compactAt) { work += next.length * t.conditions.length; rest = compactCubes(next, 2); compactAt = Math.max(4096, rest.length * 2); } else rest = next;
    if (rest.length > budget || work > workBudget) return unknown;
  }
  const uncovered = rest.reduce((n, c) => n + cubeSize(c), 0n);
  const chunks = compactCubes(rest, rest.length > 20_000 ? 1 : 8).map(c => cubeChunk(t, c));
  chunks.sort((x, y) => x.size < y.size ? 1 : x.size > y.size ? -1 : 0);
  return { complete: true, uncovered, chunks };
}
export function describeChunk(t: Pick<Table, 'conditions'>, chunk: Chunk): string {
  if (!chunk.selections.length) return 'すべての組合せ';
  return chunk.selections.map(s => { const c = t.conditions.find(c => c.id === s.conditionId)!; return `${c.name}=${s.partitionIds.map(id => c.partitions.find(p => p.id === id)!.label).join('・')}`; }).join(' / ') + (chunk.selections.length < t.conditions.length ? ' / 他の条件は−' : '');
}
// Rule pairs (0-based indexes) that can match the same input.
export function overlappingRules(t: Table, budget = 2_000_000): { pairs: number; examples: [number, number][]; complete: boolean } {
  const cubes = t.rules.map(r => ruleCubes(t, r)), examples: [number, number][] = []; let pairs = 0, work = 0;
  for (let i = 0; i < cubes.length; i++) for (let j = i + 1; j < cubes.length; j++) {
    work += cubes[i].length * cubes[j].length; if (work > budget) return { pairs, examples, complete: false };
    if (!rulesDisjoint(cubes[i], cubes[j])) { pairs++; if (examples.length < 5) examples.push([i, j]); }
  }
  return { pairs, examples, complete: true };
}
const cubeInside = (a: Cube, b: Cube) => a.every((m, i) => (m & ~b[i]) === 0n);
function cubeClause(t: Pick<Table, 'conditions'>, cube: Cube): Clause {
  return { selections: t.conditions.flatMap((c, i) => cube[i] === fullMask(c) ? [] : [{ conditionId: c.id, partitionIds: c.partitions.filter((_, j) => (cube[i] >> BigInt(j)) & 1n).map(p => p.id) }]) };
}
// TASK-003 / REQ-011: rewrite the OR blocks of one rule without changing the inputs it matches.
// Blocks contained in another are dropped, blocks that differ in one condition are joined, and a condition
// whose every partition is selected becomes "all" (omitted). A rule matches once however many blocks match.
export function simplifyClauses(t: Pick<Table, 'conditions'>, anyOf: Clause[]): Clause[] {
  let cubes = anyOf.map(c => clauseCube(t, c));
  for (let round = 0; round < 8; round++) {
    const kept = cubes.filter((a, i) => !cubes.some((b, j) => j !== i && cubeInside(a, b) && (!cubeInside(b, a) || j < i)));
    const next = compactCubes(kept);
    if (next.length === cubes.length) { cubes = next; break; }
    cubes = next;
  }
  return cubes.map(c => cubeClause(t, c));
}
// Do two clause lists match exactly the same inputs? Unknown (work budget) counts as "no".
function sameCover(a: Cube[], b: Cube[], budget = 500_000): boolean {
  let work = 0;
  const inside = (xs: Cube[], ys: Cube[]) => xs.every(x => { let rest: Cube[] = [x]; for (const y of ys) { work += rest.length; if (work > budget) return false; rest = rest.flatMap(r => subtractCube(r, y)); if (!rest.length) return true; } return rest.length === 0; });
  return inside(a, b) && inside(b, a);
}
function buildCandidate(t: Table, rules: Rule[], proof: Candidate['proof'], anchor: Rule = rules[0]): Candidate {
  return { id: uid('candidate'), base: stable(t), before: rules.map(r => r.id), replacement: { id: anchor.id, anyOf: simplifyClauses(t, rules.flatMap(r => r.anyOf)), directives: clone(anchor.directives) }, checked: 0, proof, anchor: anchor.id };
}
// TASK-007: rules merge when their whole specification is identical, including which outputs they leave undecided.
// A rule that decides nothing is not a merge target.
const idle = (t: Table, r: Rule) => (normalizedDirectives(t, r.directives) as { state: string }[]).every(d => d.state === 'unset');
const mergeKey = (t: Table, r: Rule): string | null => !r.directives.length || idle(t, r) ? null : stable(normalizedDirectives(t, r.directives));
function directiveGroups(t: Table): number[][] {
  const groups = new Map<string, number[]>();
  t.rules.forEach((r, i) => { const k = mergeKey(t, r); if (k !== null) groups.set(k, [...(groups.get(k) ?? []), i]); });
  return [...groups.values()];
}
// REQ-011 / DR-011 (TASK-004): with one result per input, rules with the same outputs can always be merged:
// an input matched by any of them gets that same result before and after, whatever else matches it.
// The proof is that the merged clauses match exactly the inputs of the source rules (sameCover).
// Rules whose OR blocks can be tidied on their own are offered as single-rule candidates.
export function proposeStructural(t: Table): Candidate[] {
  assertValid(t); const result: Candidate[] = [], used = new Set<number>();
  for (const group of directiveGroups(t)) { if (group.length < 2) continue; result.push(buildCandidate(t, group.map(i => t.rules[i]), 'structural')); group.forEach(i => used.add(i)); }
  // TASK-005: a rule is also tidied when a condition lists every partition one by one; it becomes "all".
  const weight = (anyOf: Clause[]) => anyOf.reduce((n, c) => n + 1000 + c.selections.length, 0);
  t.rules.forEach((r, i) => { if (used.has(i)) return; if (weight(simplifyClauses(t, r.anyOf)) < weight(r.anyOf)) result.push(buildCandidate(t, [r], 'structural')); });
  return result.sort((a, b) => b.before.length - a.before.length);
}
export function verifyStructural(t: Table, c: Candidate): boolean {
  const idx = c.before.map(id => t.rules.findIndex(r => r.id === id));
  if (!idx.length || idx.some(i => i < 0) || idx.some((v, i) => i > 0 && v <= idx[i - 1])) return false;
  const anchor = t.rules.findIndex(r => r.id === (c.anchor ?? c.before[0])); if (!idx.includes(anchor) || c.replacement.id !== t.rules[anchor].id) return false;
  const rules = idx.map(i => t.rules[i]);
  if (stable(c.replacement.directives) !== stable(t.rules[anchor].directives)) return false;
  if (rules.length > 1) { const key = mergeKey(t, rules[0]); if (key === null || rules.some(r => mergeKey(t, r) !== key)) return false; }
  try { assertValid(replaceCandidate(t, c)); } catch { return false; }
  if (!c.replacement.anyOf.length || !sameCover(rules.flatMap(r => ruleCubes(t, r)), ruleCubes(t, c.replacement))) return false;
  return true;
}
// TASK-003: apply candidates repeatedly until none is left. Each step is re-verified by applyCandidate.
// DEF-011 (issue #13): the work is bounded by maxSteps; complete = false says candidates were still left when it stopped.
export function compressAll(t: Table, maxSteps = 500): { table: Table; steps: number; complete: boolean } {
  let table = t, steps = 0, complete = false;
  for (; steps < maxSteps; steps++) { const [next] = proposeStructural(table); if (!next) { complete = true; break; } table = applyCandidate(table, next); }
  return { table, steps, complete: complete || proposeStructural(table).length === 0 };
}
// TASK-004, TASK-007 / REQ-008: rule pairs (0-based) that can match the same input. They contradict when both set
// some output to different values (outputs = those output indexes). same = pairs with an identical specification.
// chunk is one region where the pair meets; more = there are further regions.
export function contradictions(t: Table, limit = 20, budget = 2_000_000): { pairs: number; same: number; examples: { rules: [number, number]; outputs: number[]; chunk: Chunk; more: boolean }[]; complete: boolean } {
  const cubes = t.rules.map(r => ruleCubes(t, r)), keys = t.rules.map(r => t.outputs.map((_, o) => valueKey(t, r, o))), whole = t.rules.map(r => mergeKey(t, r));
  const examples: { rules: [number, number]; outputs: number[]; chunk: Chunk; more: boolean }[] = []; let pairs = 0, same = 0, work = 0;
  for (let i = 0; i < cubes.length; i++) for (let j = i + 1; j < cubes.length; j++) {
    work += cubes[i].length * cubes[j].length; if (work > budget) return { pairs, same, examples, complete: false };
    let first: Cube | null = null, regions = 0;
    for (const x of cubes[i]) for (const y of cubes[j]) if (!cubesDisjoint(x, y)) { regions++; first ??= x.map((m, k) => m & y[k]); }
    if (!first) continue;
    const outputs = t.outputs.flatMap((_, o) => keys[i][o] !== null && keys[j][o] !== null && keys[i][o] !== keys[j][o] ? [o] : []);
    if (outputs.length) { pairs++; if (examples.length < limit) examples.push({ rules: [i, j], outputs, chunk: cubeChunk(t, first), more: regions > 1 }); }
    else if (whole[i] !== null && whole[i] === whole[j]) same++;
  }
  return { pairs, same, examples, complete: true };
}
// TASK-007: split the input space (or one range of it) into pieces that share the same combined result.
type Piece = { cube: Cube; sets: string[][] }; // sets = one value set per action, plus a last slot that is non-empty once some rule is satisfied
function partition(t: Table, region: Cube | null = null, budget = 200_000, workBudget = 3_000_000): Piece[] | null {
  if (!t.conditions.length) return [];
  let pieces: Piece[] = [{ cube: region ?? t.conditions.map(fullMask), sets: [...t.outputs.map((): string[] => []), []] }], work = 0, compactAt = 4096;
  const regroup = (list: Piece[]) => {
    const groups = new Map<string, { sets: string[][]; cubes: Cube[] }>();
    for (const x of list) { const k = stable(x.sets), g = groups.get(k); if (g) g.cubes.push(x.cube); else groups.set(k, { sets: x.sets, cubes: [x.cube] }); }
    return [...groups.values()].flatMap(g => compactCubes(g.cubes, 2).map(cube => ({ cube, sets: g.sets })));
  };
  for (const r of t.rules) {
    const keys = t.outputs.map((_, o) => valueKey(t, r, o)); // a rule with only "-" entries still makes its inputs satisfied
    let outside = pieces; const inside: Piece[] = [];
    for (const c of ruleCubes(t, r)) {
      const next: Piece[] = [];
      for (const x of outside) {
        work++; if (cubesDisjoint(x.cube, c)) { next.push(x); continue; }
        inside.push({ cube: x.cube.map((m, k) => m & c[k]), sets: x.sets }); for (const q of subtractCube(x.cube, c)) next.push({ cube: q, sets: x.sets });
      }
      outside = next; if (work > workBudget) return null;
    }
    for (const x of inside) x.sets = x.sets.map((set, o) => o === t.outputs.length ? ['1'] : keys[o] === null || set.includes(keys[o]!) ? set : [...set, keys[o]!].sort());
    pieces = outside.concat(inside);
    if (pieces.length > compactAt) { work += pieces.length * t.conditions.length; pieces = regroup(pieces); compactAt = Math.max(4096, pieces.length * 2); }
    if (pieces.length > budget || work > workBudget) return null;
  }
  return pieces;
}
// TASK-007 / REQ-012: the combined result patterns of the table. Each pattern says, per output, the value it gets
// (values.length 1), that it is undecided (0) or contradictory (2+), with the inputs that produce it.
// satisfied = some rule is satisfied for these inputs (false: the table is not complete there).
export type Pattern = { size: bigint; satisfied: boolean; outputs: { values: Scalar[] }[]; chunks: Chunk[]; chunkCount: number };
export function patterns(t: Table, chunkLimit = 6, workBudget = 3_000_000): Pattern[] | null {
  const pieces = partition(t, null, 200_000, workBudget); if (!pieces) return null;
  const scalar = t.outputs.map(() => new Map<string, Scalar>());
  for (const r of t.rules) t.outputs.forEach((_, o) => { const k = valueKey(t, r, o), d = r.directives[o]; if (k !== null && d.state === 'set' && !scalar[o].has(k)) scalar[o].set(k, d.value); });
  const groups = new Map<string, { sets: string[][]; cubes: Cube[] }>();
  for (const x of pieces) { const k = stable(x.sets), g = groups.get(k); if (g) g.cubes.push(x.cube); else groups.set(k, { sets: x.sets, cubes: [x.cube] }); }
  const result = [...groups.values()].map(g => {
    const cubes = compactCubes(g.cubes, g.cubes.length > 20_000 ? 1 : 8), chunks = cubes.map(c => cubeChunk(t, c)).sort((a, b) => a.size < b.size ? 1 : a.size > b.size ? -1 : 0);
    return { size: chunks.reduce((n, c) => n + c.size, 0n), satisfied: g.sets[t.outputs.length].length > 0, outputs: g.sets.slice(0, t.outputs.length).map((set, o) => ({ values: set.map(k => scalar[o].get(k)!) })), chunks: chunks.slice(0, chunkLimit), chunkCount: chunks.length };
  });
  return result.sort((a, b) => a.size < b.size ? 1 : a.size > b.size ? -1 : 0);
}
// First n input combinations in the same order as atoms(), without materialising the whole product.
export function atomsHead(t: Pick<Table, 'conditions'>, n: number): Atom[] {
  const total = count(t); if (total === 0n || n <= 0) return [];
  const size = total < BigInt(n) ? Number(total) : n, idx = t.conditions.map(() => 0), out: Atom[] = [];
  for (let k = 0; k < size; k++) {
    out.push(Object.fromEntries(t.conditions.map((c, i) => [c.id, c.partitions[idx[i]].id])));
    for (let i = idx.length - 1; i >= 0; i--) { if (++idx[i] < t.conditions[i].partitions.length) break; idx[i] = 0; }
  }
  return out;
}
// REQ-012: which rules apply to one chosen input, in order.
export function lookup(t: Table, atom: Atom): { index: number; ruleId: string; directives: Directive[] }[] {
  return t.rules.flatMap((r, index) => matches(r, atom) ? [{ index, ruleId: r.id, directives: clone(r.directives) }] : []);
}
// REQ-001: a rule written by hand starts as "every condition = all" with unset outputs.
export function addRule(t: Table): Table {
  if (!t.conditions.length) throw new Error('先に条件を追加してください');
  const next = clone(t); next.schemaVersion = '1.1';
  next.rules.push({ id: uid('r'), anyOf: [{ selections: [] }], directives: next.outputs.map(o => ({ outputId: o.id, state: 'unset' as const })) });
  assertValid(next); return next;
}
// REQ-013: carry written rules over a definition change instead of regenerating the product.
// dropped: no clause left / widened: a selected condition was removed / narrowed: selected partitions were removed.
export function migrateRules(old: Table, next: Table): { table: Table; dropped: number; widened: number; narrowed: number } {
  let dropped = 0, widened = 0, narrowed = 0, omitted = false; const rules: Rule[] = [];
  for (const r of old.rules) {
    let wide = false, narrow = false; const anyOf: Clause[] = [];
    for (const clause of r.anyOf) {
      const selections: Clause['selections'] = []; let empty = false;
      for (const s of clause.selections) {
        const c = next.conditions.find(c => c.id === s.conditionId); if (!c) { wide = true; continue; }
        const ids = s.partitionIds.filter(id => c.partitions.some(p => p.id === id)); if (ids.length !== s.partitionIds.length) narrow = true;
        if (!ids.length) { empty = true; break; }
        selections.push({ conditionId: s.conditionId, partitionIds: ids });
      }
      if (empty) continue;
      if (selections.length < next.conditions.length) omitted = true;
      anyOf.push({ selections });
    }
    if (!anyOf.length) { dropped++; continue; }
    if (wide) widened++; else if (narrow) narrowed++;
    rules.push({ ...clone(r), anyOf });
  }
  const table: Table = { ...clone(next), schemaVersion: omitted || old.schemaVersion === '1.1' || next.schemaVersion === '1.1' ? '1.1' : '1.0', rules };
  assertValid(table); return { table, dropped, widened, narrowed };
}
// TASK-002, TASK-006, TASK-007 / REQ-012 / API-003 inspect: the result for chosen partitions; unchosen conditions stay open.
// Each output is judged on its own: determined (one value for every input of the range), open (depends on unchosen
// conditions, or part of the range has no rule deciding it), conflict, or none (no rule in the range decides it).
export type OutputCheck = { outputId: string; status: 'determined' | 'open' | 'conflict' | 'none'; directive?: Directive; rules: number[]; candidates: { directive: Directive; rules: number[] }[] };
export function inspect(t: Table, picks: Record<string, string>): { total: bigint; exact: boolean; rules: { index: number; ruleId: string; directives: Directive[]; always: boolean }[]; uncovered: bigint | null; conflict: boolean; determined: boolean; relevant: string[]; outputs: OutputCheck[] } {
  assertValid(t);
  if (!t.conditions.length) return { total: 0n, exact: false, rules: [], uncovered: 0n, conflict: false, determined: false, relevant: [], outputs: [] };
  const region: Cube = t.conditions.map(c => { const i = c.partitions.findIndex(p => p.id === picks[c.id]); return i < 0 ? fullMask(c) : 1n << BigInt(i); });
  const rules: { index: number; ruleId: string; directives: Directive[]; always: boolean }[] = [], inRange: { index: number; cubes: Cube[]; keys: (string | null)[] }[] = [];
  const minus = (cubes: Cube[]): Cube[] | null => { let left: Cube[] = [region], work = 0; for (const c of cubes) { work += left.length; left = left.flatMap(a => subtractCube(a, c)); if (left.length > 50_000 || work > 1_000_000) return null; if (!left.length) break; } return left; };
  for (let index = 0; index < t.rules.length; index++) {
    const r = t.rules[index], cubes = ruleCubes(t, r).filter(c => !cubesDisjoint(c, region)).map(c => c.map((m, k) => m & region[k])); if (!cubes.length) continue;
    const left = minus(cubes);
    rules.push({ index, ruleId: r.id, directives: clone(r.directives), always: left !== null && left.length === 0 });
    inRange.push({ index, cubes, keys: t.outputs.map((_, o) => valueKey(t, r, o)) });
  }
  const none = minus(inRange.flatMap(x => x.cubes)), uncovered = none ? none.reduce((n, c) => n + cubeSize(c), 0n) : null;
  const openConditions = new Set<number>();
  const outputs: OutputCheck[] = t.outputs.map((o, at) => {
    const setters = inRange.filter(x => x.keys[at] !== null), groups = new Map<string, { directive: Directive; rules: number[] }>();
    for (const x of setters) { const g = groups.get(x.keys[at]!) ?? { directive: clone(t.rules[x.index].directives[at]), rules: [] }; g.rules.push(x.index); groups.set(x.keys[at]!, g); }
    const candidates = [...groups.values()], all = setters.map(x => x.index);
    if (!setters.length) return { outputId: o.id, status: 'none' as const, rules: all, candidates };
    let clash = false;
    for (let i = 0; i < setters.length && !clash; i++) for (let j = i + 1; j < setters.length && !clash; j++) if (setters[i].keys[at] !== setters[j].keys[at] && !rulesDisjoint(setters[i].cubes, setters[j].cubes)) clash = true;
    if (clash) return { outputId: o.id, status: 'conflict' as const, rules: all, candidates };
    const left = candidates.length === 1 ? minus(setters.flatMap(x => x.cubes)) : null;
    if (candidates.length === 1 && left !== null && left.length === 0) return { outputId: o.id, status: 'determined' as const, directive: candidates[0].directive, rules: all, candidates };
    t.conditions.forEach((c, k) => { if (!c.partitions.some(p => p.id === picks[c.id]) && setters.some(x => x.cubes.some(cube => cube[k] !== fullMask(c)))) openConditions.add(k); });
    return { outputId: o.id, status: 'open' as const, rules: all, candidates };
  });
  return { total: cubeSize(region), exact: t.conditions.every(c => c.partitions.some(p => p.id === picks[c.id])), rules, uncovered, conflict: outputs.some(x => x.status === 'conflict'),
    determined: rules.length > 0 && outputs.length > 0 && outputs.every(x => x.status === 'determined' || x.status === 'none'), relevant: t.conditions.filter((_, k) => openConditions.has(k)).map(c => c.id), outputs };
}
// ---------------------------------------------------------------------------------------------
// TASK-012 (INS-012) / JIS X 0125 Annex 1, 2 "separating a table": a table too large for one sheet is split into
// several tables. An action depends only on the rules that specify it, and those rules only on the conditions they
// mention, so the single-hit table of a set of actions can be derived from that part alone.
export function separate(t: Table, outputs: number[]): Table {
  const keep = new Set(outputs), rules = t.rules.filter(r => outputs.some(o => valueKey(t, r, o) !== null));
  const used = new Set(rules.flatMap(r => r.anyOf.flatMap(c => c.selections.map(x => x.conditionId))));
  return { ...clone(t), schemaVersion: '1.1', conditions: clone(t.conditions.filter(c => used.has(c.id))), outputs: clone(t.outputs.filter((_, i) => keep.has(i))),
    rules: rules.map(r => ({ id: r.id, anyOf: clone(r.anyOf), directives: clone(r.directives.filter((_, i) => keep.has(i))) })) };
}
// Actions that some rule specifies together belong to one table; actions no rule specifies are left out.
export function actionGroups(t: Table): number[][] {
  const parent = t.outputs.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i])), specified = new Set<number>();
  for (const r of t.rules) { const set = t.outputs.flatMap((_, o) => valueKey(t, r, o) !== null ? [o] : []); set.forEach(o => { specified.add(o); parent[find(o)] = find(set[0]); }); }
  const groups = new Map<number, number[]>(); [...specified].sort((a, b) => a - b).forEach(o => { const k = find(o); groups.set(k, [...(groups.get(k) ?? []), o]); });
  return [...groups.values()];
}
// The decision table(s) to show: one combined table when it stays within maxColumns rules, otherwise the tables
// separated by related actions, and by single action where a group is still too large. found = null: not computable.
// DEF-010 (issue #12): actions specified only by rules without any condition entry. Every such rule is always satisfied,
// so the table has one rule (column) and no condition row; different values for one action are a discrepancy as elsewhere.
export function unconditional(t: Table): Pattern {
  const outputs = t.outputs.map((_, o) => { const seen = new Map<string, Scalar>(); for (const r of t.rules) { const k = valueKey(t, r, o), d = r.directives[o]; if (k !== null && d.state === 'set' && !seen.has(k)) seen.set(k, d.value); } return { values: [...seen.keys()].sort().map(k => seen.get(k)!) }; });
  return { size: 1n, satisfied: t.rules.length > 0, outputs, chunks: [{ selections: [], size: 1n }], chunkCount: 1 };
}
export type DecisionPart = { outputs: number[]; table: Table; found: Pattern[] | null; columns: number };
export function decisionTables(t: Table, maxColumns = 200): { combined: boolean; parts: DecisionPart[] } {
  const size = (found: Pattern[] | null) => found ? found.reduce((n, x) => n + x.chunkCount, 0) : Infinity;
  // Trying one table is only worth real work when the input space is small; on a huge space give up quickly and separate.
  const whole = patterns(t, 1000, count(t) <= 100_000n ? 400_000 : 30_000), all = t.outputs.map((_, i) => i);
  if (whole && size(whole) <= maxColumns) return { combined: true, parts: [{ outputs: all, table: t, found: whole, columns: size(whole) }] };
  const parts: DecisionPart[] = [];
  const add = (outputs: number[]) => { const table = separate(t, outputs), found = table.conditions.length ? patterns(table, 1000) : [unconditional(table)]; parts.push({ outputs, table, found, columns: size(found) }); return found !== null && size(found) <= maxColumns; };
  for (const group of actionGroups(t)) { if (add(group) || group.length === 1) continue; parts.pop(); group.forEach(o => add([o])); }
  return { combined: false, parts };
}
// ---------------------------------------------------------------------------------------------
// TASK-014 (INS-013) / REQ-019: the condition entry (partition) that contains a raw value, or null when none does.
// null as a value means "no value" and fits only a 'missing' entry. Bounds and decimals are compared exactly as in validate.
export function partitionOf(c: Condition, value: Scalar | null): string | null {
  if (value !== null && !validValue(c.type, value)) throw new Error(`条件「${c.name}」の型（${c.type}）に合わない値です: ${String(value)}`);
  for (const p of c.partitions) {
    if (p.kind === 'missing') { if (value === null) return p.id; continue; }
    if (value === null) continue;
    if (p.kind === 'values') { if (p.values.includes(value)) return p.id; continue; }
    if (typeof value !== 'string' || (c.type !== 'number' && c.type !== 'date')) continue;
    const i = interval(c.type, p.range), v = c.type === 'date' ? day(value) : value;
    const low = i.low === null ? 1 : cmp(v, i.low), high = i.high === null ? -1 : cmp(v, i.high);
    if ((low > 0 || (low === 0 && i.li)) && (high < 0 || (high === 0 && i.hi))) return p.id;
  }
  return null;
}
// ---------------------------------------------------------------------------------------------
// DEF-009 (issue #11): editing a condition keeps what it does not change. One line of the editor is one condition entry;
// an entry holding several candidates is written as a JSON array, so opening and saving a table leaves entries as they were.
export function choiceLines(c: Pick<Condition, 'partitions'>): string {
  return c.partitions.flatMap(p => p.kind !== 'values' ? [] : [p.values.length === 1 ? (typeof p.values[0] === 'string' ? JSON.stringify(p.values[0]) : String(p.values[0])) : JSON.stringify(p.values)]).join('\n');
}
export function parseChoiceLines(text: string): { label: string; values: string[] }[] {
  return text.split(/\r?\n/).filter(s => s.length > 0).map(s => {
    let v: unknown = s;
    if (s.startsWith('"')) { v = JSON.parse(s); if (typeof v !== 'string') throw new Error('文字列を指定してください'); }
    else if (s.startsWith('[')) { try { const list: unknown = JSON.parse(s); if (Array.isArray(list) && list.length > 0 && list.every(x => typeof x === 'string')) v = list; } catch { /* not a list: the line is one literal value */ } }
    const values = Array.isArray(v) ? v as string[] : [v as string];
    return { label: values.map(x => x === '' ? '（空文字）' : x).join('・'), values };
  });
}
// An entry with the same content as before keeps its id (rules keep referring to it) and, unless the editor lets the
// user rename it (ranges), its label.
export function retainPartitions(original: Pick<Condition, 'partitions'>, partitions: Partition[]): Partition[] {
  const content = (p: Partition) => stable({ ...p, id: '', label: '' }), used = new Set<string>();
  return partitions.map(p => { const prior = original.partitions.find(old => !used.has(old.id) && content(old) === content(p)); if (!prior) return p; used.add(prior.id); return { ...p, id: prior.id, label: p.kind === 'range' ? p.label : prior.label }; });
}
// DEF-012 (issue #14): when an action's definition changes, an action entry that is still valid is kept.
// It is kept only within the same form and type; for an enum the value must still be among the candidates.
export function carryDirective(before: Output | undefined, after: Output, d: Directive | undefined): Directive {
  const unset: Directive = { outputId: after.id, state: 'unset' };
  if (!before || !d || d.state !== 'set' || before.kind !== after.kind) return unset;
  if (after.kind === 'action') return typeof d.value === 'boolean' ? { outputId: after.id, state: 'set', value: d.value } : unset;
  if (before.kind !== 'result' || before.type !== after.type || !validValue(after.type, d.value, after.values)) return unset;
  return { outputId: after.id, state: 'set', value: d.value };
}
