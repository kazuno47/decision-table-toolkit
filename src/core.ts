// TASK-001 / REQ-001..013 / DOM-001..009 / API-001..005.
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
export type Table = { schemaVersion: '1.0'; id: string; title: string; conditions: Condition[]; outputs: Output[]; rules: Rule[] };
export type Atom = Record<string, string>;
export type Diagnostic = { level: 'error' | 'warning' | 'info'; target: string; message: string };
export type Candidate = { id: string; base: string; before: string[]; replacement: Rule; checked: number };
export const LIMIT = 10000;
export const uid = (prefix = 'id') => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
export const clone = <T>(v: T): T => structuredClone(v);
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const emptyTable = (): Table => ({ schemaVersion: '1.0', id: uid('table'), title: '新しい決定表', conditions: [], outputs: [], rules: [] });
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
      if (clause.selections.length !== table.conditions.length) error(r.id, '各条件を1回ずつ指定してください');
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
  if (count(t) > BigInt(limit)) throw new Error(`${count(t)}組み合わせは計算予算${limit}件を超えます。条件区分を見直してください`);
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
  assertValid(t); atoms(t); const groups = new Map<string, Rule[]>();
  for (const r of t.rules) {
    if (!r.directives.length || r.directives.some(d => d.state === 'unset')) continue;
    const k = stable(normalizedDirectives(t, r.directives)); groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const result: Candidate[] = []; let remainingBudget = 5_000_000;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const anyOf: Clause[] = [], seen = new Set<string>();
    for (const r of group) for (const c of r.anyOf) { const k = stable(c); if (!seen.has(k)) { anyOf.push(clone(c)); seen.add(k); } }
    const c: Candidate = { id: uid('candidate'), base: stable(t), before: group.map(r => r.id), replacement: { id: group[0].id, anyOf, directives: clone(group[0].directives) }, checked: 0 };
    const b = replaceCandidate(t, c); const cost = Number(count(t)) * (t.rules.length + b.rules.length + 1);
    if (cost > remainingBudget) break;
    remainingBudget -= cost;
    const check = verifyEquivalent(t, b, Math.min(2_000_000, remainingBudget + cost));
    if (check.equal) { c.checked = check.checked; result.push(c); }
  }
  return result;
}
export function applyCandidate(t: Table, c: Candidate): Table {
  if (stable(t) !== c.base) throw new Error('表が変更されたため候補は失効しました。再計算してください');
  const b = replaceCandidate(t, c), proof = verifyEquivalent(t, b);
  if (!proof.equal) throw new Error(`等価性を確認できません: ${proof.reason}`);
  return b;
}
export function diagnose(t: Table): Diagnostic[] {
  const result = validate(t); if (result.length) return result;
  for (const r of t.rules) if (r.directives.some(d => d.state === 'unset')) result.push({ level: 'warning', target: r.id, message: '未設定の出力があります' });
  try {
    const cells = atoms(t); const weight = t.rules.reduce((n, r) => n + r.anyOf.length * t.conditions.length, 0);
    if (cells.length * weight > 2_000_000) throw new Error('診断の計算予算を超えるため網羅性を判定していません');
    const uncovered = cells.filter(a => !t.rules.some(r => matches(r, a))).length;
    const multiple = cells.filter(a => t.rules.filter(r => matches(r, a)).length > 1).length;
    if (uncovered) result.push({ level: 'warning', target: 'rules', message: `${uncovered}組み合わせに規則がありません（宣言した値域内）` });
    if (multiple) result.push({ level: 'info', target: 'rules', message: `${multiple}組み合わせが多重適合。全件を上から順に適用します。異なる結果は上書きしません` });
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
  assertValid(t); const cells = atoms(t);
  const weight = t.rules.reduce((n, r) => n + r.anyOf.reduce((n, c) => n + c.selections.reduce((n, s) => n + s.partitionIds.length, 0), 0), 0);
  if (Math.min(cells.length, displayLimit) * weight > 2_000_000) throw new Error('展開対応の表示計算予算を超えます。規則を整理してください');
  return cells.slice(0, displayLimit).map(atom => ({ atom, matches: t.rules.filter(r => matches(r, atom)).map(r => ({ ruleId: r.id, directives: clone(r.directives) })) }));
}
