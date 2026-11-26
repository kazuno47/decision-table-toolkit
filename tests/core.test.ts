import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, generate, clone, decode, encode, compareDecimal, day, validate, count, atoms, proposeMerges, applyCandidate, verifyEquivalent, trace, patternCount, diagnose, regeneratePreserving, expandRows, type Table, type Condition } from '../src/core.ts';
import { checkShape, documentSchema } from '../src/schema.ts';
function fixture(n = 2): Table {
  const t = emptyTable(); t.conditions = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `C${i}`, type: 'boolean', partitions: [{ id: `c${i}t`, label: 'true', kind: 'values', values: [true] }, { id: `c${i}f`, label: 'false', kind: 'values', values: [false] }] }));
  t.outputs = [{ id: 'o', name: '結果', kind: 'result', type: 'number' }]; return generate(t);
}
const setAll = (t: Table, value = '1') => { t.rules.forEach(r => { r.directives = [{ outputId: 'o', state: 'set', value }]; }); return t; };
test('exact decimal ordering handles values beyond IEEE754 and negative fractions', () => {
  assert.equal(compareDecimal('9007199254740993.01', '9007199254740993.001'), 1);
  assert.equal(compareDecimal('-0.05', '-0.005'), -1); assert.equal(compareDecimal('1.00', '1'), 0); assert.equal(compareDecimal('-0', '0.000'), 0);
  for (const value of ['NaN', 'Infinity', '1e3', '', '01']) assert.throws(() => compareDecimal(value, '0'));
});
test('date validation uses calendar days, not timezone or epoch validity', () => {
  assert.ok(day('0001-01-01') < day('1960-01-01')); assert.equal(day('2024-03-01') - day('2024-02-28'), 2);
  for (const s of ['2023-02-29', '1900-02-29', '0000-01-01', '2026-13-01', '2026-01-00', '-1', '2026-1-1']) assert.throws(() => day(s));
  assert.doesNotThrow(() => day('2000-02-29'));
});
test('3 booleans generate exactly 8 distinct combinations; values stay unset', () => {
  const t = fixture(3); assert.equal(count(t), 8n); assert.equal(t.rules.length, 8); assert.equal(new Set(atoms(t).map(JSON.stringify)).size, 8);
  assert.ok(t.rules.every(r => r.directives[0].state === 'unset'));
});
test('10 by 10 generates 100, not a presumed pattern limit of 30', () => {
  const t = emptyTable(); t.conditions = [0, 1].map(i => ({ id: `c${i}`, name: '値', type: 'enum', partitions: Array.from({ length: 10 }, (_, j) => ({ id: `p${i}-${j}`, label: String(j), kind: 'values', values: [String(j)] })) }));
  assert.equal(generate(t).rules.length, 100);
});
test('generation budgets reject instead of silently truncating', () => { assert.throws(() => atoms(fixture(2), 3), /計算予算/); });
test('strict JSON rejects unknown root/nested fields, future versions, bad refs and wrong output types', () => {
  const t = fixture(); assert.equal(checkShape(t).length, 0);
  const bads = [ { ...t, future: true }, { ...t, schemaVersion: '2.0' }, { ...t, conditions: [{ ...t.conditions[0], extra: 1 }] } ];
  for (const bad of bads) assert.throws(() => decode(JSON.stringify(bad)));
  const ref = clone(t); ref.rules[0].anyOf[0].selections[0].partitionIds = ['unknown']; assert.throws(() => decode(JSON.stringify(ref)), /未知/);
  const wrong = clone(t); wrong.rules[0].directives[0] = { outputId: 'o', state: 'set', value: false }; assert.throws(() => encode(wrong), /型/);
});
test('unknown properties on union branches and malicious keys are never ignored', () => {
  const t = fixture(1); const bad = JSON.parse(JSON.stringify(t)); bad.rules[0].directives[0].value = 'hidden'; assert.throws(() => decode(JSON.stringify(bad)));
  const raw = JSON.stringify(t).replace('"schemaVersion":"1.0"', '"schemaVersion":"1.0","__proto__":{"polluted":true}'); assert.throws(() => decode(raw)); assert.equal(({} as any).polluted, undefined);
});
test('JSON roundtrip preserves unset, false, zero and empty string distinctions', () => {
  const t = fixture(1); t.outputs = [{ id: 'b', name: 'bool', kind: 'result', type: 'boolean' }, { id: 'n', name: 'num', kind: 'result', type: 'number' }, { id: 's', name: 'str', kind: 'result', type: 'string' }, { id: 'u', name: 'unset', kind: 'action' }];
  t.rules.forEach(r => { r.directives = [{ outputId: 'b', state: 'set', value: false }, { outputId: 'n', state: 'set', value: '0' }, { outputId: 's', state: 'set', value: '' }, { outputId: 'u', state: 'unset' }]; });
  assert.deepEqual(decode(encode(t)), t); assert.ok(diagnose(t).some(d => d.message.includes('未設定')));
});
function rangeCondition(type: 'number' | 'date', ranges: { lower: string | null; upper: string | null; lowerInclusive: boolean; upperInclusive: boolean }[]): Condition {
  return { id: 'c', name: 'range', type, partitions: ranges.map((range, i) => ({ id: `p${i}`, label: String(i), kind: 'range', range })) };
}
test('numeric interval edges and overlaps use exact decimal comparisons', () => {
  const t = emptyTable(); t.conditions = [rangeCondition('number', [{ lower: null, upper: '0.1', lowerInclusive: false, upperInclusive: false }, { lower: '0.10', upper: null, lowerInclusive: true, upperInclusive: false }])];
  assert.deepEqual(validate(t), []);
  (t.conditions[0].partitions[0] as any).range.upperInclusive = true; assert.ok(validate(t).some(d => d.message.includes('重複')));
});
test('date ranges reject empty discrete intervals and backwards bounds', () => {
  const t = emptyTable(); t.conditions = [rangeCondition('date', [{ lower: '2026-01-01', upper: '2026-01-02', lowerInclusive: false, upperInclusive: false }])];
  assert.ok(validate(t).some(d => d.message.includes('空')));
  t.conditions = [rangeCondition('date', [{ lower: '2026-02-03', upper: '2026-01-01', lowerInclusive: true, upperInclusive: true }])]; assert.ok(validate(t).length);
});
test('explicit missing is a separate finite partition; duplicate missing is rejected', () => {
  const t = fixture(1); t.rules = []; t.conditions[0].partitions.push({ id: 'missing', label: '未定義', kind: 'missing' });
  assert.equal(generate(t).rules.length, 3); t.conditions[0].partitions.push({ id: 'missing2', label: '未定義2', kind: 'missing' }); assert.ok(validate(t).some(d => d.message.includes('重複')));
});
test('same output on disjoint inputs merges and preserves the entire trace', () => {
  const t = setAll(fixture(2)); assert.equal(patternCount(t), 1); const cs = proposeMerges(t); assert.equal(cs.length, 1); assert.equal(cs[0].checked, 4);
  const merged = applyCandidate(t, cs[0]); assert.equal(merged.rules.length, 1); assert.equal(merged.rules[0].anyOf.length, 4); assert.equal(verifyEquivalent(t, merged).equal, true);
});
test('diagonal inputs retain OR structure without broadening into a rectangle', () => {
  const t = fixture(2); t.rules.forEach((r, i) => { r.directives = [{ outputId: 'o', state: 'set', value: [0, 3].includes(i) ? '1' : '2' }]; });
  const c = proposeMerges(t).find(c => c.before.includes(t.rules[0].id))!; assert.ok(c); const after = applyCandidate(t, c);
  assert.equal(verifyEquivalent(t, after).equal, true);
  const broadened = clone(after); broadened.rules[0].anyOf = [{ selections: t.conditions.map(c => ({ conditionId: c.id, partitionIds: c.partitions.map(p => p.id) })) }]; assert.equal(verifyEquivalent(t, broadened).equal, false);
});
test('two identical matches cannot be collapsed into a single action occurrence', () => {
  const t = setAll(fixture(1)); t.rules = [t.rules[0], { ...clone(t.rules[0]), id: 'duplicate' }]; assert.equal(trace(t, atoms(t)[0]).length, 2); assert.equal(proposeMerges(t).length, 0);
});
test('non-adjacent matching rules cannot reorder effects via grouping', () => {
  const t = setAll(fixture(1)); const first = clone(t.rules[0]);
  t.rules = [first, { ...clone(first), id: 'middle', directives: [{ outputId: 'o', state: 'set', value: '2' }] }, { ...clone(first), id: 'last' }];
  assert.equal(proposeMerges(t).length, 0);
});
test('equivalence budgets and stale candidate protection fail closed', () => {
  const t = setAll(fixture(2)); const c = proposeMerges(t)[0]; const changed = clone(t); changed.title = '別の版'; assert.throws(() => applyCandidate(changed, c), /失効/);
  assert.equal(verifyEquivalent(t, t, 0).equal, false);
});
test('unfinished outputs cannot become approved merge candidates', () => { assert.equal(proposeMerges(fixture()).length, 0); });
test('equivalent decimal result encodings do not block safe merge', () => { const t = setAll(fixture(1), '1.0'); t.rules[1].directives[0] = { outputId: 'o', state: 'set', value: '1.00' }; assert.equal(proposeMerges(t).length, 1); });
test('coverage diagnosis distinguishes missing rules from intentional multiple hits', () => {
  const t = setAll(fixture(1)); t.rules = [t.rules[0], { ...clone(t.rules[0]), id: 'd' }]; const ds = diagnose(t); assert.ok(ds.some(d => d.message.includes('規則がありません'))); assert.ok(ds.some(d => d.level === 'info' && d.message.includes('多重適合')));
});
test('adding a condition preserves result values across its new partitions', () => {
  const t = setAll(fixture(1)); const next = clone(t); next.rules = []; next.conditions.push(clone(fixture(2).conditions[1])); const migration = regeneratePreserving(t, next);
  assert.equal(migration.table.rules.length, 4); assert.equal(migration.affected, 0); assert.ok(migration.table.rules.every(r => r.directives[0].state === 'set'));
});
test('removing a condition with conflicting results requires reset, not guessed preservation', () => {
  const t = fixture(2); t.rules.forEach((r, i) => { r.directives[0] = { outputId: 'o', state: 'set', value: String(i) }; }); const next = clone(t); next.conditions.pop(); next.rules = [];
  const migration = regeneratePreserving(t, next); assert.equal(migration.affected, 2); assert.ok(migration.table.rules.every(r => r.directives[0].state === 'unset'));
});
test('changing a retained condition interval does not silently transfer old output meaning', () => {
  const t = setAll(fixture(1)); const next = clone(t); (next.conditions[0].partitions[0] as any).values = [false]; next.conditions[0].partitions.pop(); next.rules = [];
  assert.ok(regeneratePreserving(t, next).affected > 0);
});
test('permuting arbitrary source rule order never changes verified merge semantics', () => {
  for (let n = 0; n < 24; n++) {
    const t = fixture(3); t.rules.forEach((r, i) => { r.directives[0] = { outputId: 'o', state: 'set', value: String((i + n) % 3) }; });
    t.rules = t.rules.slice(n % 8).concat(t.rules.slice(0, n % 8)); for (const c of proposeMerges(t)) assert.equal(verifyEquivalent(t, applyCandidate(t, c)).equal, true);
  }
});
test('published schema is a closed draft-07 document', () => { assert.equal(documentSchema.additionalProperties, false); assert.equal(documentSchema.properties?.schemaVersion.const, '1.0'); });

test('expanded compressed table maps each atom to its matching rule and ordered outcomes', () => {
  const t = setAll(fixture(2)); const merged = applyCandidate(t, proposeMerges(t)[0]); const rows = expandRows(merged);
  assert.equal(rows.length, 4); assert.ok(rows.every(row => row.matches.length === 1 && row.matches[0].ruleId === merged.rules[0].id));
  assert.ok(rows.every(row => row.matches[0].directives[0].state === 'set' && row.matches[0].directives[0].value === '1'));
  const withOverlap = clone(merged); withOverlap.rules.push({ ...clone(merged.rules[0]), id: 'second-occurrence' });
  assert.deepEqual(expandRows(withOverlap)[0].matches.map(x => x.ruleId), [merged.rules[0].id, 'second-occurrence']);
});
