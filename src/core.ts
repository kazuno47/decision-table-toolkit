// TASK-001, TASK-002 / REQ-001..013 / DOM-001..009 / DR-010,011 / API-001..005.
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
export type Candidate = { id: string; base: string; before: string[]; replacement: Rule; checked: number; proof: 'enumeration' | 'structural' };
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
        if (p.kind === 'values') { if (['number', 'date'].includes(c.type)) error(c.id, '数値・日付は範囲区分で定義してください'); unique(p.values.map(stable), p.id); if (p.values.some(v => !validValue(c.type, v))) error(p.id, '条件の型と値が一致しません'); }
        if (p.kind === 'range') { if (!['number', 'date'].includes(c.type)) error(p.id, 'この型では範囲を指定できません'); else if (rangeEmpty(c.type, p.range)) error(p.id, '逆転した範囲または空の範囲です'); }
      } catch (e) { error(p.id, String((e as Error).message)); }
    }
    for (let i = 0; i < c.partitions.length; i++) for (let j = i + 1; j < c.partitions.length; j++) {
      try { if (partitionsOverlap(c.type, c.partitions[i], c.partitions[j])) error(c.id, `区分が重複しています: ${c.partitions[i].label} / ${c.partitions[j].label}`); } catch { /* already diagnosed */ }
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
        if (!c || s.partitionIds.some(id => !c.partitions.some(p => p.id === id))) error(r.id, '未知の条件・区分への参照です');
      }
    }
    if (r.directives.length !== table.outputs.length) error(r.id, '全出力を指定してください');
    r.directives.forEach((d, i) => {
      const o = table.outputs[i];
      if (!o || d.outputId !== o.id) error(r.id, '出力の参照または順序が不正です');
      else if (d.state === 'set' && !validValue(o.kind === 'action' ? 'boolean' : o.type, d.value, o.kind === 'result' ? o.values : undefined)) error(r.id, `出力「${o.name}」の型または値が不正です`);
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
  if (count(t) > BigInt(limit)) throw new Error(`${count(t)}組み合わせは計算予算${limit}件を超えるため全件の列挙はできません。規則を1行ずつ記述してください（検証・統合・展開は列挙なしで利用できます）`);
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
    if (d.state === 'set' && o?.kind === 'result' && o.type === 'number' && typeof d.value === 'string') {
      let [value, scale] = decimal(d.value); while (scale > 0 && value % 10n === 0n) { value /= 10n; scale--; }
      return { ...d, value: `${value}:${scale}` };
    }
    return d;
  });
}
export function traceKey(t: Table, atom: Atom): string { return stable(trace(t, atom).map(ds => normalizedDirectives(t, ds))); }
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
  for (let i = 0; i < cells.length; i++) if (traceKey(a, cells[i]) !== traceKey(b, cells[i])) return { equal: false, checked: i + 1, reason: '動作・結果の値、順序、回数が異なります' };
  return { equal: true, checked: cells.length };
}
export function replaceCandidate(t: Table, c: Candidate): Table {
  const first = t.rules.findIndex(r => r.id === c.before[0]);
  return { ...clone(t), rules: t.rules.flatMap((r, i) => i === first ? [clone(c.replacement)] : c.before.includes(r.id) ? [] : [clone(r)]) };
}
export function proposeMerges(t: Table): Candidate[] {
  assertValid(t); if (count(t) > BigInt(LIMIT)) return proposeStructural(t);
  const groups = new Map<string, Rule[]>(); let cubes: Cube[][] | null = null;
  for (const r of t.rules) {
    if (!r.directives.length || r.directives.some(d => d.state === 'unset')) continue;
    const k = stable(normalizedDirectives(t, r.directives)); groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const result: Candidate[] = []; let remainingBudget = 5_000_000;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const anyOf: Clause[] = [], seen = new Set<string>();
    for (const r of group) for (const c of r.anyOf) { const k = stable(c); if (!seen.has(k)) { anyOf.push(clone(c)); seen.add(k); } }
    const c: Candidate = { id: uid('candidate'), base: stable(t), before: group.map(r => r.id), replacement: { id: group[0].id, anyOf, directives: clone(group[0].directives) }, checked: 0, proof: 'enumeration' };
    const b = replaceCandidate(t, c); const cost = Number(count(t)) * (t.rules.length + b.rules.length + 1);
    cubes ??= t.rules.map(r => ruleCubes(t, r));
    const indexes = group.map(r => t.rules.indexOf(r));
    // DEF-006: when enumeration does not fit its budget, use the DR-011 proof instead of dropping the group.
    const structural = () => { const chosen = mergeable(cubes!, indexes); if (chosen.length > 1) result.push(buildCandidate(t, chosen.map(i => t.rules[i]), 'structural')); };
    if (cost > remainingBudget) { structural(); continue; }
    remainingBudget -= cost;
    const check = verifyEquivalent(t, b, Math.min(2_000_000, remainingBudget + cost));
    if (check.equal) { c.checked = check.checked; result.push(c); continue; }
    if (check.checked === 0) { structural(); continue; }
    // The whole group is not mergeable; offer the subset that DR-011 allows, still confirmed by enumeration here.
    const chosen = mergeable(cubes, indexes);
    if (chosen.length < 2) continue;
    const subset = buildCandidate(t, chosen.map(i => t.rules[i]), 'enumeration'), proof = verifyEquivalent(t, replaceCandidate(t, subset));
    if (proof.equal) { subset.checked = proof.checked; result.push(subset); } else if (proof.checked === 0) result.push({ ...subset, proof: 'structural' });
  }
  return result;
}
export function applyCandidate(t: Table, c: Candidate): Table {
  if (stable(t) !== c.base) throw new Error('表が変更されたため候補は失効しました。再計算してください');
  const b = replaceCandidate(t, c);
  if (c.proof === 'structural') { if (!verifyStructural(t, c)) throw new Error('等価性を確認できません: 規則の重なりと順序から証明できません'); assertValid(b); return b; }
  const proof = verifyEquivalent(t, b);
  if (!proof.equal) throw new Error(`等価性を確認できません: ${proof.reason}`);
  return b;
}
export function diagnose(t: Table): Diagnostic[] {
  const result = validate(t); if (result.length) return result;
  for (const r of t.rules) if (r.directives.some(d => d.state === 'unset')) result.push({ level: 'warning', target: r.id, message: '未設定の出力があります' });
  try {
    // TASK-002 / REQ-008: coverage is computed on partition-set products, never by enumerating the input space.
    const total = count(t);
    if (total > 0n) {
      const cov = coverage(t);
      if (!cov.complete) result.push({ level: 'warning', target: 'rules', message: '網羅性は計算予算を超えたため判定できていません（問題なしとは判定していません）' });
      else if (cov.uncovered) {
        result.push({ level: 'warning', target: 'rules', message: `${cov.uncovered}組み合わせに規則がありません（宣言した値域内）` });
        cov.chunks.slice(0, 20).forEach(chunk => result.push({ level: 'warning', target: '未網羅', message: `${describeChunk(t, chunk)}（${chunk.size}組み合わせ）` }));
        if (cov.chunks.length > 20) result.push({ level: 'warning', target: '未網羅', message: `ほか${cov.chunks.length - 20}個のかたまりがあります。規則を追加して再検証してください` });
      }
      const weight = t.rules.reduce((n, r) => n + r.anyOf.length * t.conditions.length, 0);
      if (total <= BigInt(LIMIT) && Number(total) * weight <= 2_000_000) {
        const multiple = atoms(t).filter(a => t.rules.filter(r => matches(r, a)).length > 1).length;
        if (multiple) result.push({ level: 'info', target: 'rules', message: `${multiple}組み合わせが多重適合。全件を上から順に適用します。異なる結果は上書きしません` });
      } else {
        const over = overlappingRules(t);
        if (over.pairs) result.push({ level: 'info', target: 'rules', message: `${over.pairs}組${over.complete ? '' : '以上'}の規則が同じ入力に重なって多重適合します（例: ${over.examples.map(([a, b]) => `#${a + 1}と#${b + 1}`).join('、')}）。全件を上から順に適用します。異なる結果は上書きしません` });
        if (!over.complete) result.push({ level: 'warning', target: 'rules', message: '多重適合の確認は計算予算で打ち切りました' });
      }
    }
    const keys = new Set<string>(); for (const r of t.rules) { const k = stable({ anyOf: r.anyOf, directives: r.directives }); if (keys.has(k)) result.push({ level: 'warning', target: r.id, message: '同じ条件と出力の規則が重複しています。回数が意味を持つため自動削除しません' }); keys.add(k); }
  } catch (e) { result.push({ level: 'warning', target: 'rules', message: (e as Error).message }); }
  return result;
}
export function patternCount(t: Table): number {
  const cells = atoms(t); if (cells.length * t.rules.length > 2_000_000) throw new Error('結果パターン数は計算予算のため未算出');
  return new Set(cells.map(a => traceKey(t, a))).size;
}
// Conservative result migration; never infer business validity or changed interval membership.
export function regeneratePreserving(old: Table, next: Table): { table: Table; affected: number } {
  assertValid(old); assertValid(next); const fresh = generate({ ...next, rules: [] });
  const common = old.conditions.filter(c => next.conditions.some(n => n.id === c.id));
  const changed = common.some(c => stable({ type: c.type, partitions: c.partitions }) !== stable({ type: next.conditions.find(n => n.id === c.id)!.type, partitions: next.conditions.find(n => n.id === c.id)!.partitions }));
  if (changed) return { table: fresh, affected: fresh.rules.length };
  const shared = common.map(c => c.id); const key = (a: Atom) => stable(shared.map(id => a[id]));
  const buckets = new Map<string, Directive[][] | null>();
  for (const a of atoms(old)) { const k = key(a), value = trace(old, a); if (!buckets.has(k)) buckets.set(k, clone(value)); else if (stable(buckets.get(k)) !== stable(value)) buckets.set(k, null); }
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
  if (Math.min(cells.length, displayLimit) * weight > 2_000_000) throw new Error('展開対応の表示計算予算を超えます。規則を整理してください');
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
// REQ-008: inputs matched by no rule, as disjoint chunks. complete=false means "not determined", never "covered".
// budget bounds the number of chunks held at once, workBudget the total number of chunk operations (DEF-005).
export function coverage(t: Table, budget = 200_000, workBudget = 2_000_000): { complete: boolean; uncovered: bigint; chunks: Chunk[] } {
  if (!t.conditions.length) return { complete: true, uncovered: 0n, chunks: [] };
  const unknown = { complete: false, uncovered: 0n, chunks: [] as Chunk[] };
  let rest: Cube[] = [t.conditions.map(fullMask)], work = 0, compactAt = 4096;
  for (const r of t.rules) for (const clause of r.anyOf) {
    if (!rest.length) break;
    const b = clauseCube(t, clause), next: Cube[] = [];
    for (const a of rest) for (const piece of subtractCube(a, b)) next.push(piece);
    work += rest.length; if (work > workBudget) return unknown;
    // Compact only after the list has doubled since the last compaction, so compaction cannot run per clause.
    if (next.length > compactAt) { work += next.length * t.conditions.length; rest = compactCubes(next, 2); compactAt = Math.max(4096, rest.length * 2); } else rest = next;
    if (rest.length > budget || work > workBudget) return unknown;
  }
  const uncovered = rest.reduce((n, c) => n + cubeSize(c), 0n);
  const chunks = compactCubes(rest, rest.length > 20_000 ? 1 : 8).map(c => ({ size: cubeSize(c), selections: t.conditions.flatMap((cond, i) => c[i] === fullMask(cond) ? [] : [{ conditionId: cond.id, partitionIds: cond.partitions.filter((_, j) => (c[i] >> BigInt(j)) & 1n).map(p => p.id) }]) }));
  chunks.sort((x, y) => x.size < y.size ? 1 : x.size > y.size ? -1 : 0);
  return { complete: true, uncovered, chunks };
}
export function describeChunk(t: Pick<Table, 'conditions'>, chunk: Chunk): string {
  if (!chunk.selections.length) return 'すべての組み合わせ';
  return chunk.selections.map(s => { const c = t.conditions.find(c => c.id === s.conditionId)!; return `${c.name}=${s.partitionIds.map(id => c.partitions.find(p => p.id === id)!.label).join('・')}`; }).join(' / ') + (chunk.selections.length < t.conditions.length ? ' / 他の条件はすべて' : '');
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
// DR-011. group = ascending rule indexes with identical directives; the merged rule takes the first position.
// A later rule g may join only if (a) no already chosen rule can match the same input (match count stays 1) and
// (b) no other rule between the first position and g can match the same input as g (order of effects is kept).
function mergeable(cubes: Cube[][], group: number[]): number[] {
  const first = group[0], chosen = [first];
  for (const g of group.slice(1)) {
    if (chosen.some(x => !rulesDisjoint(cubes[x], cubes[g]))) continue;
    let blocked = false;
    for (let x = first + 1; x < g && !blocked; x++) if (!chosen.includes(x) && !rulesDisjoint(cubes[x], cubes[g])) blocked = true;
    if (!blocked) chosen.push(g);
  }
  return chosen;
}
function buildCandidate(t: Table, rules: Rule[], proof: Candidate['proof']): Candidate {
  const anyOf: Clause[] = [], seen = new Set<string>();
  for (const r of rules) for (const c of r.anyOf) { const k = stable(c); if (!seen.has(k)) { anyOf.push(clone(c)); seen.add(k); } }
  return { id: uid('candidate'), base: stable(t), before: rules.map(r => r.id), replacement: { id: rules[0].id, anyOf, directives: clone(rules[0].directives) }, checked: 0, proof };
}
// REQ-011 beyond the enumeration budget: candidates proven from rule overlap and order alone.
export function proposeStructural(t: Table): Candidate[] {
  assertValid(t); const groups = new Map<string, number[]>();
  t.rules.forEach((r, i) => { if (!r.directives.length || r.directives.some(d => d.state === 'unset')) return; const k = stable(normalizedDirectives(t, r.directives)); groups.set(k, [...(groups.get(k) ?? []), i]); });
  const cubes = t.rules.map(r => ruleCubes(t, r)), result: Candidate[] = [];
  for (const group of groups.values()) { if (group.length < 2) continue; const chosen = mergeable(cubes, group); if (chosen.length > 1) result.push(buildCandidate(t, chosen.map(i => t.rules[i]), 'structural')); }
  return result;
}
export function verifyStructural(t: Table, c: Candidate): boolean {
  const idx = c.before.map(id => t.rules.findIndex(r => r.id === id));
  if (idx.length < 2 || idx.some(i => i < 0) || idx.some((v, i) => i > 0 && v <= idx[i - 1])) return false;
  const rules = idx.map(i => t.rules[i]), key = stable(normalizedDirectives(t, rules[0].directives));
  if (rules.some(r => !r.directives.length || r.directives.some(d => d.state === 'unset') || stable(normalizedDirectives(t, r.directives)) !== key)) return false;
  if (stable(buildCandidate(t, rules, 'structural').replacement) !== stable(c.replacement)) return false;
  return mergeable(t.rules.map(r => ruleCubes(t, r)), idx).length === idx.length;
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
