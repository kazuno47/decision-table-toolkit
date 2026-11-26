// TASK-002 / INS-001, CHG-001..003 / REQ-001,004,008,010,011,012,013 / NFR-006 / DR-010,011.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, clone, decode, encode, validate, count, atoms, atomsHead, generate, matches, diagnose, coverage, describeChunk, overlappingRules, proposeMerges, proposeStructural, verifyStructural, applyCandidate, replaceCandidate, verifyEquivalent, simplifyClauses, compressAll, contradictions, results, patternCount, addRule, migrateRules, lookup, expandRows, inspect, LIMIT, type Table, type Rule, type Clause } from '../src/core.ts';
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
  t.rules.push(rule('d', { 5: [0] }, '4')); assert.ok(diagnose(t).some(d => d.level === 'error' && d.target === '矛盾' && d.message.includes('規則 #1 と #4')));
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
test('DR-011: rules with the same result merge whatever overlaps or lies between; unset outputs never merge', () => {
  const t = table([3, 2]);
  t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [0, 1] })]; // b contains a: one result either way
  { const [c] = proposeStructural(t); assert.deepEqual(c.before, ['a', 'b']); const after = replaceCandidate(t, c); assert.deepEqual(after.rules[0].anyOf, [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0', 'c0p1'] }] }]); assert.equal(verifyEquivalent(t, after).equal, true); }
  t.rules = [rule('a', { 0: [0] }), rule('x', { 0: [0, 1] }, '9'), rule('b', { 0: [1] })]; // x contradicts both; merging a and b keeps exactly that
  { const [c] = proposeStructural(t); assert.deepEqual(c.before, ['a', 'b']); const after = replaceCandidate(t, c); assert.deepEqual(after.rules.map(r => r.id), ['a', 'x']); assert.equal(verifyEquivalent(t, after).equal, true); assert.equal(contradictions(after).pairs, 1); }
  t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1] }, null)]; assert.equal(proposeStructural(t).length, 0); // unset outputs are never merged
});
test('REQ-011: merges are proposed and applied structurally beyond the enumeration budget; stale or forged candidates fail closed', () => {
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1], 3: [2] }), rule('x', { 0: [2] }, '7'), rule('c', { 0: [3] })];
  const cs = proposeMerges(t); assert.equal(cs.length, 1); assert.equal(cs[0].proof, 'structural'); assert.deepEqual(cs[0].before, ['a', 'b', 'c']);
  const merged = applyCandidate(t, cs[0]); assert.deepEqual(merged.rules.map(r => r.id), ['a', 'x']); assert.equal(merged.rules[0].anyOf.length, 2); // 条件0=v0 and 条件0=v3 are joined into one block
  assert.equal(coverage(merged).uncovered, coverage(t).uncovered);
  const changed = clone(t); changed.rules[2] = rule('x', { 0: [2, 3] }, '7'); assert.throws(() => applyCandidate(changed, cs[0]), /失効/);
  const forged = { ...cs[0], base: JSON.stringify(null) }; assert.throws(() => applyCandidate(t, forged));
  const widened = clone(cs[0]); widened.replacement.anyOf = [{ selections: [] }]; assert.equal(verifyStructural(t, widened), false); assert.throws(() => applyCandidate(t, widened), /証明できません/);
});
test('small tables get enumeration-proven candidates that include overlapping rules', () => {
  const t = table([3, 2]); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1] }), rule('dup', { 0: [0, 1] })];
  const cs = proposeMerges(t); assert.equal(cs.length, 1); assert.equal(cs[0].proof, 'enumeration'); assert.deepEqual(cs[0].before, ['a', 'b', 'dup']); assert.equal(cs[0].checked, 6);
  const merged = applyCandidate(t, cs[0]); assert.equal(merged.rules.length, 1); assert.equal(verifyEquivalent(t, merged).equal, true);
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
test('a hand-built candidate is accepted only when it matches the same inputs, and never against a stale table', () => {
  const t = table([3, 2]); t.rules = [rule('a', { 0: [0] }), rule('x', { 0: [1] }, '9'), rule('b', { 0: [1] })];
  const good = { id: 'manual', base: JSON.stringify(null), before: ['a', 'b'], replacement: { id: 'a', anyOf: [t.rules[0].anyOf[0], t.rules[2].anyOf[0]], directives: t.rules[0].directives }, checked: 0, proof: 'structural' as const };
  assert.equal(verifyStructural(t, good), true); assert.throws(() => applyCandidate(t, good), /失効/);
  const wrongRules = { ...good, before: ['a', 'x'] }; assert.equal(verifyStructural(t, wrongRules), false); // a and x have different results
  const reversed = { ...good, before: ['b', 'a'] }; assert.equal(verifyStructural(t, reversed), false);
});
// INS-002 / CHG-004 / REQ-012: the filter-like "結果を確認" calculation.
test('inspect: partial and full partition choices agree with brute force on 300 random tables', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed), r = random(seed * 7 + 1), picks: Record<string, string> = {};
    for (const c of t.conditions) if (r() < (seed % 3 ? 0.5 : 1)) picks[c.id] = c.partitions[Math.floor(r() * c.partitions.length)].id;
    const region = atoms(t).filter(a => Object.entries(picks).every(([id, p]) => a[id] === p)), found = inspect(t, picks);
    assert.equal(found.total, BigInt(region.length), `seed ${seed}`); assert.equal(found.exact, Object.keys(picks).length === t.conditions.length);
    assert.deepEqual(found.rules.map(x => x.index), t.rules.flatMap((rule, i) => region.some(a => matches(rule, a)) ? [i] : []), `seed ${seed}`);
    for (const x of found.rules) assert.equal(x.always, region.every(a => matches(t.rules[x.index], a)), `seed ${seed}`);
    assert.equal(found.uncovered, BigInt(region.filter(a => !t.rules.some(rule => matches(rule, a))).length), `seed ${seed}`);
    assert.equal(found.conflict, region.some(a => results(t, a).length > 1), `seed ${seed}`);
    if (found.exact) assert.deepEqual(found.rules.map(x => x.ruleId), lookup(t, region[0]).map(x => x.ruleId));
  }
});
test('inspect: works beyond 10,000 combinations, ignores stale choices and does not change the table', () => {
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [0], 1: [1] }, '2'), rule('c', { 0: [1] }, '3')]; const before = JSON.stringify(t);
  const all = inspect(t, {}); assert.equal(all.total, 16777216n); assert.deepEqual(all.rules.map(x => [x.ruleId, x.always]), [['a', false], ['b', false], ['c', false]]); assert.equal(all.uncovered, 8388608n);
  const one = inspect(t, { c0: 'c0p0', c5: 'gone' }); assert.equal(one.total, 4194304n); assert.deepEqual(one.rules.map(x => [x.ruleId, x.always]), [['a', true], ['b', false]]); assert.equal(one.uncovered, 0n); assert.equal(one.exact, false);
  assert.equal(inspect(t, { c0: 'c0p3' }).rules.length, 0); assert.equal(inspect(t, { c0: 'c0p3' }).uncovered, 4194304n);
  assert.equal(JSON.stringify(t), before); assert.deepEqual(inspect(emptyTable(), {}).rules, []);
});
// TASK-003 / REQ-011: tidy OR blocks, fold complete selections into "all", repeat merging, explain blockers.
const hits = (t: Table, anyOf: Clause[]) => atoms(t).map(a => anyOf.some(c => c.selections.every(s => s.partitionIds.includes(a[s.conditionId]))));
test('simplifyClauses never changes the matched inputs and folds a complete selection into "all"', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed), all = t.rules.flatMap(r => r.anyOf), tidy = simplifyClauses(t, all);
    assert.deepEqual(hits(t, tidy), hits(t, all), `seed ${seed}`); assert.ok(tidy.length <= all.length && tidy.length >= 1);
    assert.ok(tidy.every(c => c.selections.every(s => s.partitionIds.length < t.conditions.find(x => x.id === s.conditionId)!.partitions.length)), 'a full selection must become "all"');
  }
  const t = table([3, 2]);
  assert.deepEqual(simplifyClauses(t, [0, 1, 2].map(j => ({ selections: [{ conditionId: 'c0', partitionIds: [`c0p${j}`] }, { conditionId: 'c1', partitionIds: ['c1p0'] }] }))), [{ selections: [{ conditionId: 'c1', partitionIds: ['c1p0'] }] }]);
  assert.deepEqual(simplifyClauses(t, [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0'] }] }, { selections: [{ conditionId: 'c0', partitionIds: ['c0p0'] }, { conditionId: 'c1', partitionIds: ['c1p1'] }] }]), [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0'] }] }]);
});
test('a fully generated table compresses to one rule per result, written with "all"', () => {
  const t = generate(table([3, 3, 2, 4])); assert.equal(t.rules.length, 72);
  t.rules.forEach(r => { r.directives = [{ outputId: 'o', state: 'set', value: r.anyOf[0].selections[0].partitionIds[0] === 'c0p0' ? '100' : '200' }]; });
  const done = compressAll(t); assert.equal(done.table.rules.length, 2); assert.equal(verifyEquivalent(t, done.table).equal, true);
  assert.deepEqual(done.table.rules.map(r => r.anyOf), [[{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0'] }] }], [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p1', 'c0p2'] }] }]]);
  assert.equal(proposeStructural(done.table).length, 0); assert.equal(t.rules.length, 72);
});
test('compressAll keeps every result on random tables and leaves one rule per distinct result', () => {
  let reduced = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed, 2, seed % 2 ? 0.4 : 0.1, seed % 2 ? 0.5 : 0.25), done = compressAll(t);
    assert.equal(verifyEquivalent(t, done.table).equal, true, `seed ${seed}`); assert.equal(proposeStructural(done.table).length, 0, `seed ${seed}`);
    assert.ok(done.table.rules.length <= t.rules.length); if (done.table.rules.length < t.rules.length) reduced++;
    for (const a of atoms(t)) assert.deepEqual(results(done.table, a), results(t, a));
    assert.equal(done.table.rules.length, new Set(t.rules.map(r => JSON.stringify(r.directives))).size, 'one rule per distinct result');
  }
  assert.ok(reduced > 40, `only ${reduced} tables lost rules`);
});
test('compressAll works beyond 10,000 combinations and single rules get their OR blocks tidied', () => {
  const t = table(Array(12).fill(4));
  t.rules = [rule('a', { 0: [0], 1: [0] }), rule('b', { 0: [0], 1: [1, 2, 3] }), rule('x', { 0: [1] }, '5'), rule('c', { 0: [2, 3] })];
  const done = compressAll(t); assert.deepEqual(done.table.rules.map(r => r.id), ['a', 'x']);
  assert.deepEqual(done.table.rules[0].anyOf, [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0', 'c0p2', 'c0p3'] }] }]);
  assert.equal(coverage(done.table).uncovered, coverage(t).uncovered);
  const solo = table(Array(12).fill(4)); solo.rules = [{ ...rule('s', { 0: [0] }), anyOf: [0, 1, 2, 3].map(j => ({ selections: [{ conditionId: 'c2', partitionIds: [`c2p${j}`] }, { conditionId: 'c3', partitionIds: ['c3p1'] }] })) }];
  const [c] = proposeMerges(solo); assert.deepEqual(c.before, ['s']); assert.deepEqual(applyCandidate(solo, c).rules[0].anyOf, [{ selections: [{ conditionId: 'c3', partitionIds: ['c3p1'] }] }]);
});
test('NFR-006: contradictions and same-result overlaps equal brute force on 300 random tables', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed), cells = atoms(t); let different = 0, same = 0;
    for (let i = 0; i < t.rules.length; i++) for (let j = i + 1; j < t.rules.length; j++) if (cells.some(a => matches(t.rules[i], a) && matches(t.rules[j], a))) { if (JSON.stringify(t.rules[i].directives) === JSON.stringify(t.rules[j].directives)) same++; else different++; }
    const found = contradictions(t); assert.equal(found.complete, true); assert.equal(found.pairs, different, `seed ${seed}`); assert.equal(found.same, same, `seed ${seed}`);
    for (const e of found.examples) { const inChunk = cells.filter(a => e.chunk.selections.every(s => s.partitionIds.includes(a[s.conditionId]))); assert.equal(BigInt(inChunk.length), e.chunk.size); assert.ok(inChunk.every(a => matches(t.rules[e.rules[0]], a) && matches(t.rules[e.rules[1]], a) && results(t, a).length > 1), `seed ${seed}`); }
    assert.equal(cells.some(a => results(t, a).length > 1), found.pairs > 0, `seed ${seed}`);
    assert.equal(diagnose(t).some(d => d.level === 'error'), found.pairs > 0);
  }
});
test('INS-004: a contradiction is reported with the rules and the region; it works beyond 10,000 combinations', () => {
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [0, 1], 3: [2] }, '2'), rule('c', { 0: [1] }, '2'), rule('d', { 0: [2] })];
  const found = contradictions(t); assert.equal(found.pairs, 1); assert.equal(found.same, 1); assert.deepEqual(found.examples[0].rules, [0, 1]); assert.equal(found.examples[0].chunk.size, 16777216n / 16n);
  const ds = diagnose(t); assert.ok(ds.some(d => d.level === 'error' && d.message.includes('1組の規則で結果が食い違っています')));
  assert.ok(ds.some(d => d.target === '矛盾' && d.message.includes('規則 #1 と #2') && d.message.includes('条件0=v0 / 条件3=v2 / 他の条件はすべて')));
  assert.ok(ds.some(d => d.level === 'info' && d.message.includes('同じ結果で重なっています')));
  t.rules[1] = rule('b', { 0: [1], 3: [2] }, '2'); assert.equal(contradictions(t).pairs, 0); assert.equal(diagnose(t).some(d => d.level === 'error'), false);
  assert.equal(contradictions(t, 20, 1).complete, false);
});
test('INS-004: the number of result patterns ignores how many rules repeat the same result', () => {
  const t = table([2, 2]); t.rules = [rule('a', {}), rule('b', { 0: [0] }), rule('c', { 1: [1] })]; assert.equal(patternCount(t), 1);
  t.rules.push(rule('d', { 0: [1], 1: [1] }, '7')); assert.equal(patternCount(t), 2); // {1} and the contradicting {1, 7}
});
test('a forged replacement that covers different inputs or other outputs is rejected', () => {
  const t = table(Array(12).fill(4)); t.rules = [rule('a', { 0: [0] }), rule('b', { 0: [1] })]; const [c] = proposeMerges(t); assert.equal(verifyStructural(t, c), true);
  const narrower = clone(c); narrower.replacement.anyOf = [{ selections: [{ conditionId: 'c0', partitionIds: ['c0p0'] }] }]; assert.equal(verifyStructural(t, narrower), false);
  const other = clone(c); other.replacement.directives = [{ outputId: 'o', state: 'set', value: '9' }]; assert.equal(verifyStructural(t, other), false);
  const moved = clone(c); moved.anchor = 'zzz'; assert.equal(verifyStructural(t, moved), false); assert.throws(() => applyCandidate(t, moved), /証明できません/);
});
// TASK-005: a condition that lists every partition one by one is the same inputs as "all".
test('TASK-005: a rule naming every partition of a condition is offered as "all", also inside a 1.0 table', () => {
  const t = table([4, 2]); t.schemaVersion = '1.0';
  t.rules = [rule('each', { 0: [0, 1, 2, 3], 1: [1] }), rule('other', { 0: [0], 1: [0] }, '2')]; assert.deepEqual(validate(t), []);
  const [c] = proposeMerges(t); assert.deepEqual(c.before, ['each']); assert.deepEqual(c.replacement.anyOf, [{ selections: [{ conditionId: 'c1', partitionIds: ['c1p1'] }] }]);
  const after = applyCandidate(t, c); assert.equal(after.schemaVersion, '1.1'); assert.equal(verifyEquivalent(t, after).equal, true); assert.equal(proposeMerges(after).length, 0);
  const done = compressAll(t); assert.deepEqual(done.table.rules.map(r => r.anyOf[0].selections.length), [1, 2]);
  // the filter-like check keeps such a rule for any chosen partition, and drops rules of other partitions
  assert.deepEqual(inspect(t, { c0: 'c0p3' }).rules.map(x => x.ruleId), ['each']); assert.deepEqual(inspect(t, { c0: 'c0p0' }).rules.map(x => x.ruleId), ['each', 'other']);
});
