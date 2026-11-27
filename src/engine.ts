// TASK-014 (INS-013) / REQ-019 / API-008: the public entry for other software. It reads a decision table (the JSON this
// toolkit saves) and interprets it exactly as the editor's "interpretation" section does, using the same core functions.
// It knows nothing about any particular consumer: only conditions, actions and rules. It executes nothing.
import { assertValid, clone, decode, inspect, partitionOf, type Condition, type Scalar, type Table } from './core.ts';
export type { Table, Scalar } from './core.ts';
export const version: string = '0.3.1';
export type ConditionInfo = { id: string; name: string; type: Condition['type']; values: { id: string; label: string }[] };
export type ActionInfo = { id: string; name: string; kind: 'action' | 'result' };
// determined: the same for every input the given values leave open. none: no rule specifies the action there ("-").
// open: depends on conditions not given yet. conflict: rules specify different values for the same input.
export type ActionResult = ActionInfo & { status: 'determined' | 'none' | 'open' | 'conflict'; executed: boolean | null; value: Scalar | null; candidates: Scalar[]; rules: string[] };
export type Evaluation = { decided: boolean; complete: boolean; conflict: boolean; actions: ActionResult[]; needed: string[]; rules: { id: string; number: number; always: boolean }[]; ignored: string[] };
export type RawValue = boolean | string | number | null;

export function load(source: string | unknown): Table {
  if (typeof source === 'string') return decode(source);
  const t = clone(source) as Table; assertValid(t); return t;
}
export function conditions(table: Table): ConditionInfo[] { return table.conditions.map(c => ({ id: c.id, name: c.name, type: c.type, values: c.partitions.map(p => ({ id: p.id, label: p.label })) })); }
export function actions(table: Table): ActionInfo[] { return table.outputs.map(o => ({ id: o.id, name: o.name, kind: o.kind })); }
// A key names a condition by its id, or by its name when exactly one condition has that name.
function resolve(table: Table, input: Record<string, unknown>): { found: [Condition, unknown][]; ignored: string[] } {
  const found: [Condition, unknown][] = [], ignored: string[] = [], seen = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const byName = table.conditions.filter(c => c.name === key), c = table.conditions.find(c => c.id === key) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!c) { if (byName.length > 1) throw new Error(`「${key}」という名前の条件が複数あります。条件のIDで指定してください`); ignored.push(key); continue; }
    if (seen.has(c.id)) throw new Error(`条件「${c.name}」が2回指定されています`);
    seen.add(c.id); found.push([c, value]);
  }
  return { found, ignored };
}
// Raw values -> the ids of the condition entries that contain them. A number may be given as a number or, to keep
// every digit, as a decimal string; a date as YYYY-MM-DD; null means "no value". Keys that name no condition are skipped.
export function classify(table: Table, values: Record<string, RawValue | undefined>): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const [c, raw] of resolve(table, values).found) {
    let value = raw as RawValue;
    if (typeof value === 'number') { if (c.type !== 'number' || !Number.isFinite(value) || !/^-?\d+(\.\d+)?$/.test(String(value))) throw new Error(`条件「${c.name}」の値を数値として扱えません: ${String(value)}（桁の多い数値は文字列で渡してください）`); value = String(value); }
    if (value !== null && typeof value !== 'boolean' && typeof value !== 'string') throw new Error(`条件「${c.name}」の値の型が不正です`);
    const id = partitionOf(c, value);
    if (id === null) throw new Error(`条件「${c.name}」の値 ${value === null ? '（値なし）' : String(value)} は、定義された値のどれにも当てはまりません`);
    picks[c.id] = id;
  }
  return picks;
}
// The interpretation for the given condition entries. A condition may be left out; the result then says which actions
// are already decided and which conditions are still needed. An entry is named by its id, or by its label when unique.
export function evaluate(table: Table, picks: Record<string, string | undefined>): Evaluation {
  assertValid(table);
  const { found, ignored } = resolve(table, picks), chosen: Record<string, string> = {};
  for (const [c, value] of found) {
    const byLabel = c.partitions.filter(p => p.label === value), p = c.partitions.find(p => p.id === value) ?? (byLabel.length === 1 ? byLabel[0] : undefined);
    if (!p) throw new Error(byLabel.length > 1 ? `条件「${c.name}」に「${String(value)}」というラベルの値が複数あります。値のIDで指定してください` : `条件「${c.name}」に「${String(value)}」という値はありません`);
    chosen[c.id] = p.id;
  }
  const found2 = inspect(table, chosen), by = new Map(found2.outputs.map(o => [o.outputId, o]));
  const results: ActionResult[] = table.outputs.map(o => {
    const x = by.get(o.id), status = x?.status ?? 'none', set = (d: { state: string; value?: Scalar } | undefined) => d && d.state === 'set' ? d.value as Scalar : null;
    const candidates = (x?.candidates ?? []).map(c => set(c.directive)).filter((v): v is Scalar => v !== null && !(o.kind === 'action' && v !== true));
    return { id: o.id, name: o.name, kind: o.kind, status, executed: status === 'determined' ? true : status === 'none' ? false : null, value: status === 'determined' ? set(x!.directive) : null, candidates, rules: (x?.rules ?? []).map(i => table.rules[i].id) };
  });
  return { decided: results.every(r => r.status === 'determined' || r.status === 'none'), complete: table.conditions.every(c => chosen[c.id] !== undefined), conflict: results.some(r => r.status === 'conflict'),
    actions: results, needed: found2.relevant, rules: found2.rules.map(r => ({ id: r.ruleId, number: r.index + 1, always: r.always })), ignored };
}
