// TASK-002 / INS-001, CHG-001..003 / REQ-001,004,008,010,011,012,013 / NFR-006 / DR-010,011.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, clone, decode, encode, validate, count, atoms, atomsHead, generate, matches, diagnose, coverage, describeChunk, overlappingRules, proposeMerges, proposeStructural, verifyStructural, applyCandidate, replaceCandidate, verifyEquivalent, addRule, migrateRules, lookup, expandRows, LIMIT, type Table, type Rule, type Clause } from '../src/core.ts';
import { documentSchema } from '../src/schema.ts';

function table(sizes: number[]): Table {
  const t = emptyTable();
  t.conditions = sizes.map((n, i) => ({ id: `c${i}`, name: `条件${i}`, type: 'enum', partitions: Array.from({ length: n }, (_, j) => ({ id: `c${i}p${j}`, label: `v${j}`, kind: 'values', values: [`v${j}`] })) }));
  t.outputs = [{ id: 'o', name: '結果', kind: 'result', type: 'number' }];
  return t;
}
const rule = (id: string, picks: Record<number, number[]>, value: string | null = '1'): Rule => ({
  id, anyOf: [{ selections: Object.entries(picks).map(([i, js]) => ({ conditionId: `c${i}`, partitionIds: js.map(j => `c${i}p${j}`) })) }],
  directives: [value === null ? { outputId: 'o', state: 'unset' } : { outputId: 'o', state: 'set', value }]
});
function random(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function randomTable(seed: number, values = 3, wild = 0.4, keep = 0.5): Table {
  const r = random(seed), sizes = Array.from({ length: 2 + Math.floor(r() * 3) }, () => 2 + Math.floor(r() * 3)), t = table(sizes);
  const clause = (): Clause => ({ selections: sizes.flatMap((n, i) => { if (r() < wild) return []; const ids = Array.from({ length: n }, (_, j) => j).filter(() => r() < keep); return [{ conditionId: `c${i}`, partitionIds: (ids.length ? ids : [0]).map(j => `c${i}p${j}`) }]; }) });
  t.rules = Array.from({ length: 1 + Math.floor(r() * 7) }, (_, k) => ({ id: `r${k}`, anyOf: Array.from({ length: 1 + Math.floor(r() * 2) }, clause), directives: [{ outputId: 'o', state: 'set' as const, value: String(Math.floor(r() * values)) }] }));
  return t;
}

test('schema 1.1: an omitted condition matches every partition; new tables are 1.1', () => {
  const t = table([2, 3]); assert.equal(t.schemaVersion, '1.1');
  t.rules = [rule('r', { 0: [1] })]; assert.deepEqual(validate(t), []);
  assert.equal(atoms(t).filter(a => matches(t.rules[0], a)).length, 3);
  t.rules = [{ ...rule('all', {}), anyOf: [{ selections: [] }] }]; assert.deepEqual(validate(t), []); assert.ok(atoms(t).every(a => matches(t.rules[0], a)));
  assert.deepEqual(decode(encode(t)), t);
});
test('schema 1.0 stays exhaustive: omission is rejected there, complete 1.0 files still load, other versions are refused', () => {
  const t = table([2, 2]); t.schemaVersion = '1.0'; t.rules = [rule('r', { 0: [0] })];
  assert.ok(validate(t).some(d => d.message.includes('スキーマ1.1のみ'))); assert.throws(() => decode(JSON.stringify(t)));
  t.rules = [rule('r', { 0: [0], 1: [0, 1] })]; const loaded = decode(JSON.stringify(t)); assert.equal(loaded.schemaVersion, '1.0'); assert.deepEqual(decode(encode(loaded)), loaded);
  for (const v of ['1.2', '2.0', '1', 1.1]) assert.throws(() => decode(JSON.stringify({ ...t, schemaVersion: v })));
  assert.deepEqual(documentSchema.properties?.schemaVersion.enum, ['1.0', '1.1']);
});
test('duplicate or unknown conditions inside a clause are rejected in 1.1 as well', () => {
  const t = table([2, 2]); t.rules = [rule('r', { 0: [0] })]; t.rules[0].anyOf[0].selections.push({ conditionId: 'c0', partitionIds: ['c0p1'] }); assert.ok(validate(t).length);
  t.rules = [rule('r', { 0: [0] })]; t.rules[0].anyOf[0].selections[0].conditionId = 'nope'; assert.ok(validate(t).some(d => d.message.includes('未知')));
  t.rules = [rule('r', { 0: [] })]; assert.ok(validate(t).length);
});
test('NFR-006: coverage without enumeration equals brute force on 400 random rule tables', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const t = randomTable(seed), cells = atoms(t), cov = coverage(t); assert.equal(cov.complete, true);
    const missing = cells.filter(a => !t.rules.some(r => matches(r, a)));
    assert.equal(cov.uncovered, BigInt(missing.length), `seed ${seed}`);
    assert.equal(cov.chunks.reduce((n, c) => n + c.size, 0n), cov.uncovered);
    // every chunk is entirely uncovered, and together the chunks are exactly the uncovered inputs (no overlap).
    const inChunk = (a: Record<string, string>) => cov.chunks.filter(c => c.selections.every(s => s.partitionIds.includes(a[s.conditionId]))).length;
    for (const a of cells) assert.equal(inChunk(a), t.rules.some(r => matches(r, a)) ? 0 : 1, `seed ${seed}`);
  }
});
test('NFR-006: rule overlap detection equals brute force', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const t = randomTable(seed), cells = atoms(t); let expected = 0;
    for (let i = 0; i < t.rules.length; i++) for (let j = i + 1; j < t.rules.length; j++) if (cells.some(a => matches(t.rules[i], a) && matches(t.rules[j], a))) expected++;
    const over = overlappingRules(t); assert.equal(over.complete, true); assert.equal(over.pairs, expected, `seed ${seed}`);
  }
});
test('REQ-008: a table far beyond 10,000 combinations is diagnosed with uncovered chunks', () => {
  const t = table(Array(12).fill(4)); assert.equal(count(t), 16777216n); assert.ok(count(t) > BigInt(LIMIT));
  assert.throws(() => generate(t), /規則を1行ずつ/);
  t.rules = [rule('a', { 0: [0, 1] }), rule('b', { 0: [2, 3], 1: [0] }, '2')];
  const cov = coverage(t); assert.equal(cov.complete, true); assert.equal(cov.uncovered, 16777216n / 2n / 4n * 3n);
  assert.equal(cov.chunks.length, 1); assert.equal(describeChunk(t, cov.chunks[0]), '条件0=v2・v3 / 条件1=v1・v2・v3 / 他の条件はすべて');
  const ds = diagnose(t); assert.ok(ds.some(d => d.message.includes('6291456組み合わせに規則がありません'))); assert.ok(ds.some(d => d.target === '未網羅' && d.message.includes('条件0=v2・v3')));
  t.rules.push(rule('c', { 0: [2, 3], 1: [1, 2, 3] }, '3')); assert.equal(coverage(t).uncovered, 0n); assert.equal(diagnose(t).some(d => d.message.includes('規則がありません')), false);
  t.rules.push(rule('d', { 5: [0] }, '4')); assert.ok(diagnose(t).some(d => d.level === 'info' && d.message.includes('多重適合') && d.message.includes('#1と#4')));
});
test('coverage that exceeds its budget reports "not determined", never "covered"', () => {
  const t = table(Array(10).fill(3)); t.rules = Array.from({ length: 6 }, (_, k) => rule(`r${k}`, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, [(i + k) % 3]]))));
  const cov = coverage(t, 5); assert.equal(cov.complete, false);
});
test('DR-011: structural merge candidates agree with full enumeration on random tables', () => {
  let proposed = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const t = randomTable(seed, 2, seed % 2 ? 0.4 : 0.1, seed % 2 ? 0.5 : 0.25); // dense and sparse rule sets
    for (const c of proposeStructural(t)) { proposed++; assert.equal(verifyStructural(t, c), true); assert.equal(verifyEquivalent(t, replaceCandidate(t, c)).equal, true, `seed ${seed}`); }
    for (const c of proposeMerges(t)) assert.equal(verifyEquivalent(t, applyCandidate(t, c)).equal, true, `seed ${seed}`);
  }
  assert.ok(proposed > 50, `only ${proposed} structural candidates were exercised`);
});
test('DR-011: overlap inside the group or an overlapping rule in between blocks a structural merge', () => {
  const t = table([3, 2]);
  t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [0, 1] })]; assert.equal(proposeStructural(t).length, 0); // same input would fire twice
  t.rules = [rule('a', { 0: [0] }), rule('x', { 0: [1] }, '9'), rule('b', { 0: [1] })]; assert.equal(proposeStructural(t).length, 0); // b would move above x
  t.rules = [rule('a', { 0: [0] }), rule('x', { 0: [2] }, '9'), rule('b', { 0: [1] })];
  const [c] = proposeStructural(t); assert.deepEqual(c.before, ['a', 'b']); assert.equal(verifyEquivalent(t, replaceCandidate(t, c)).equal, true);
  t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1] }, null)]; assert.equal(proposeStructural(t).length, 0); // unset outputs are never merged
});
test('REQ-011: merges are proposed and applied structurally beyond the enumeration budget; stale or forged candidates fail closed', () => {
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1], 3: [2] }), rule('x', { 0: [2] }, '7'), rule('c', { 0: [3] })];
  const cs = proposeMerges(t); assert.equal(cs.length, 1); assert.equal(cs[0].proof, 'structural'); assert.deepEqual(cs[0].before, ['a', 'b', 'c']);
  const merged = applyCandidate(t, cs[0]); assert.deepEqual(merged.rules.map(r => r.id), ['a', 'x']); assert.equal(merged.rules[0].anyOf.length, 3);
  assert.equal(coverage(merged).uncovered, coverage(t).uncovered);
  const changed = clone(t); changed.rules[2] = rule('x', { 0: [2, 3] }, '7'); assert.throws(() => applyCandidate(changed, cs[0]), /失効/);
  const forged = { ...cs[0], base: JSON.stringify(null) }; assert.throws(() => applyCandidate(t, forged));
  const widened = clone(cs[0]); widened.replacement.anyOf = [{ selections: [] }]; assert.equal(verifyStructural(t, widened), false); assert.throws(() => applyCandidate(t, widened), /証明できません/);
});
test('small tables still get enumeration-proven candidates, including a mergeable subset of a group', () => {
  const t = table([3, 2]); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1] }), rule('dup', { 0: [0, 1] })];
  const cs = proposeMerges(t); assert.equal(cs.length, 1); assert.equal(cs[0].proof, 'enumeration'); assert.deepEqual(cs[0].before, ['a', 'b']); assert.equal(cs[0].checked, 6);
  assert.equal(verifyEquivalent(t, applyCandidate(t, cs[0])).equal, true);
});
test('REQ-001: addRule appends an all-conditions rule with unset outputs and upgrades a 1.0 table', () => {
  assert.throws(() => addRule(emptyTable()), /条件/);
  const t = table([2, 2]); t.schemaVersion = '1.0'; const next = addRule(t);
  assert.equal(next.schemaVersion, '1.1'); assert.equal(next.rules.length, 1); assert.deepEqual(next.rules[0].anyOf, [{ selections: [] }]); assert.equal(next.rules[0].directives[0].state, 'unset');
  assert.equal(t.rules.length, 0); assert.equal(coverage(next).uncovered, 0n);
});
test('REQ-013 / DEC-025: "all" follows an added partition, an explicit selection does not', () => {
  const t = table([2, 2]); t.rules = [rule('all', { 1: [0] }), rule('explicit', { 0: [0, 1], 1: [1] }, '2')]; assert.equal(coverage(t).uncovered, 0n);
  const next = clone(t); next.rules = []; next.conditions[0].partitions.push({ id: 'c0p2', label: 'v2', kind: 'values', values: ['v2'] });
  const m = migrateRules(t, next); assert.deepEqual([m.dropped, m.widened, m.narrowed], [0, 0, 0]); assert.equal(m.table.rules.length, 2);
  const cov = coverage(m.table); assert.equal(cov.uncovered, 1n); assert.equal(describeChunk(m.table, cov.chunks[0]), '条件0=v2 / 条件1=v1');
});
test('REQ-013: removing conditions or partitions keeps written rules and reports what could not be kept', () => {
  const t = table([3, 2]); t.rules = [rule('keep', { 1: [0] }), rule('narrow', { 0: [0, 1] }, '2'), rule('drop', { 0: [1], 1: [1] }, '3'), rule('wide', { 0: [2], 1: [1] }, '4')];
  const fewer = clone(t); fewer.rules = []; fewer.conditions[0].partitions.splice(1, 1);
  const a = migrateRules(t, fewer); assert.deepEqual([a.dropped, a.widened, a.narrowed], [1, 0, 1]); assert.deepEqual(a.table.rules.map(r => r.id), ['keep', 'narrow', 'wide']);
  assert.deepEqual(a.table.rules[1].anyOf[0].selections[0].partitionIds, ['c0p0']);
  const noCondition = clone(t); noCondition.rules = []; noCondition.conditions.shift();
  const b = migrateRules(t, noCondition); assert.deepEqual([b.dropped, b.widened, b.narrowed], [0, 3, 0]); assert.equal(b.table.rules.length, 4); assert.deepEqual(validate(b.table), []);
  assert.equal(t.rules.length, 4); // the source table is untouched until the user confirms
});
test('a 1.0 table gains schema 1.1 only when a condition is added to written rules', () => {
  const t = table([2]); t.schemaVersion = '1.0'; t.rules = [rule('r', { 0: [0] })];
  const same = clone(t); same.rules = []; assert.equal(migrateRules(t, same).table.schemaVersion, '1.0');
  const more = clone(same); more.conditions.push(table([2, 2]).conditions[1]); const m = migrateRules(t, more);
  assert.equal(m.table.schemaVersion, '1.1'); assert.equal(atoms(m.table).filter(a => matches(m.table.rules[0], a)).length, 2);
});
test('REQ-012: lookup and the head of the expansion work without materialising a large product', () => {
  const small = table([2, 3, 2]); assert.deepEqual(atomsHead(small, 100), atoms(small)); assert.deepEqual(atomsHead(small, 5), atoms(small).slice(0, 5)); assert.deepEqual(atomsHead(emptyTable(), 5), []);
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 1: [0] }, '2'), rule('c', { 0: [1] }, '3')];
  const atom = Object.fromEntries(t.conditions.map(c => [c.id, c.partitions[0].id]));
  assert.deepEqual(lookup(t, atom).map(m => [m.index, m.ruleId]), [[0, 'a'], [1, 'b']]);
  const rows = expandRows(t, 50); assert.equal(rows.length, 50); assert.deepEqual(rows[0].matches.map(m => m.ruleId), ['a', 'b']);
});
// Regression tests for the independent review of TASK-002 (DEF-005, DEF-006).
function handWritten(sizes: number[], rules: number, picks: number, seed: number): Table {
  const r = random(seed), t = table(sizes);
  t.rules = Array.from({ length: rules }, (_, k) => { const chosen = new Set<number>(); while (chosen.size < picks) chosen.add(Math.floor(r() * sizes.length)); return rule(`r${k}`, Object.fromEntries([...chosen].map(i => [i, [Math.floor(r() * sizes[i])]])), String(k % 3)); });
  return t;
}
test('DEF-005: diagnosing many hand-written rules on a huge table stays bounded and never claims coverage when cut off', () => {
  for (const rules of [50, 100, 200, 400]) {
    const t = handWritten(Array(12).fill(4), rules, 6, rules), started = performance.now(), ds = diagnose(t), elapsed = performance.now() - started;
    assert.ok(elapsed < 8000, `${rules} rules took ${Math.round(elapsed)}ms`);
    const cov = coverage(t);
    if (!cov.complete) { assert.ok(ds.some(d => d.message.includes('判定できていません'))); assert.equal(ds.some(d => d.message.includes('規則がありません')), false); }
    else assert.ok(cov.uncovered > 0n && ds.some(d => d.message.includes('規則がありません')));
  }
});
test('DEF-005: the work budget cuts coverage off as "not determined"', () => {
  const t = handWritten(Array(12).fill(4), 60, 6, 3); assert.equal(coverage(t).complete, true); assert.equal(coverage(t, 200_000, 50).complete, false);
});
test('DEF-005: compaction during subtraction keeps the result equal to brute force', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const t = handWritten([3, 3, 3, 3, 3, 3, 3, 2], 40, 5, seed), cov = coverage(t); assert.equal(cov.complete, true);
    assert.equal(cov.uncovered, BigInt(atoms(t).filter(a => !t.rules.some(r => matches(r, a))).length), `seed ${seed}`);
    assert.equal(cov.chunks.reduce((n, c) => n + c.size, 0n), cov.uncovered);
  }
});
test('DEF-006: a table within 10,000 combinations but beyond the enumeration budget still gets structural candidates', () => {
  const t = table([10, 10, 10, 10]); assert.equal(count(t), 10000n);
  t.rules = Array.from({ length: 300 }, (_, k) => rule(`r${k}`, { 0: [k % 10], 1: [Math.floor(k / 10) % 10], 2: [Math.floor(k / 100)] }, String(k % 2)));
  const cs = proposeMerges(t); assert.equal(cs.length, 2); assert.ok(cs.every(c => c.proof === 'structural' && c.before.length === 150));
  const merged = applyCandidate(t, cs[0]); assert.equal(merged.rules.length, 151); assert.equal(coverage(merged).uncovered, coverage(t).uncovered);
});
test('a candidate whose rule order was forged is rejected by both proofs', () => {
  const t = table([3, 2]); t.rules = [rule('a', { 0: [0] }), rule('x', { 0: [1] }, '9'), rule('b', { 0: [1] })];
  const base = { id: 'forged', base: JSON.stringify(null), before: ['a', 'b'], replacement: { id: 'a', anyOf: [t.rules[0].anyOf[0], t.rules[2].anyOf[0]], directives: t.rules[0].directives }, checked: 0 };
  const stableBase = proposeStructural({ ...t, rules: [t.rules[0], t.rules[2]] })[0]; assert.ok(stableBase);
  for (const proof of ['structural', 'enumeration'] as const) { const c = { ...base, proof }; assert.equal(verifyStructural(t, c), false); assert.throws(() => applyCandidate(t, c)); }
});
