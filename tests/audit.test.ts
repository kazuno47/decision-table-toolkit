// DEF-010 (issue #12), DEF-011 (issue #13): what the audit found in the separated tables and in repeated merging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, assertValid, atoms, resultOf, stable, decisionTables, unconditional, separate, compressAll, proposeStructural, verifyEquivalent, diagnose, type Table, type Directive } from '../src/core.ts';

function random(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const enumCondition = (id: string, n: number) => ({ id, name: id, type: 'enum' as const, partitions: Array.from({ length: n }, (_, j) => ({ id: `${id}p${j}`, label: `v${j}`, kind: 'values' as const, values: [`v${j}`] })) });

test('issue #12: an action specified only without conditions appears in its separated table with its value', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = random(seed), t = emptyTable(); t.conditions = [enumCondition('c0', 3), enumCondition('c1', 2)];
    t.outputs = [{ id: 'a', name: '承認者', kind: 'result', type: 'string' }, { id: 'log', name: '記録先', kind: 'result', type: 'string' }, { id: 'notify', name: '通知', kind: 'action' }];
    const dirs = (a: string | null, log: string | null, notify: boolean | null): Directive[] => [a === null ? { outputId: 'a', state: 'unset' } : { outputId: 'a', state: 'set', value: a }, log === null ? { outputId: 'log', state: 'unset' } : { outputId: 'log', state: 'set', value: log }, notify === null ? { outputId: 'notify', state: 'unset' } : { outputId: 'notify', state: 'set', value: notify }];
    t.rules = [0, 1, 2].map(j => ({ id: `r${j}`, anyOf: [{ selections: [{ conditionId: 'c0', partitionIds: [`c0p${j}`] }] }], directives: dirs(`役${j}`, null, null) }));
    const n = 1 + Math.floor(r() * 3); for (let k = 0; k < n; k++) t.rules.push({ id: `u${k}`, anyOf: [{ selections: [] }], directives: dirs(null, r() < 0.8 ? `台帳${Math.floor(r() * 2)}` : null, r() < 0.5 ? r() < 0.7 : null) });
    assertValid(t);
    const parts = decisionTables(t, 0).parts.filter(p => !p.table.conditions.length);
    for (const part of parts) {
      assert.equal(part.found!.length, 1); assert.equal(part.columns, 1); assert.deepEqual(part.found![0].chunks, [{ selections: [], size: 1n }]);
      part.outputs.forEach((o, at) => { for (const atom of atoms(t)) assert.deepEqual(part.found![0].outputs[at].values.map(v => stable(v)).sort(), resultOf(t, atom)[o], `seed ${seed}`); });
    }
    // every action some rule specifies is in exactly one of the tables
    const specified = t.outputs.map((_, o) => o).filter(o => atoms(t).some(a => resultOf(t, a)[o].length > 0));
    assert.deepEqual(decisionTables(t, 0).parts.flatMap(p => p.outputs).sort(), specified, `seed ${seed}`);
  }
});
test('issue #12: a fixed value, an X and a discrepancy between unconditional rules are all visible', () => {
  const t = emptyTable(); t.conditions = [enumCondition('c', 2)];
  t.outputs = [{ id: 'log', name: '記録先', kind: 'result', type: 'string' }, { id: 'notify', name: '通知', kind: 'action' }];
  const rule = (id: string, log: string | null, notify: boolean) => ({ id, anyOf: [{ selections: [] }], directives: [log === null ? { outputId: 'log', state: 'unset' as const } : { outputId: 'log', state: 'set' as const, value: log }, notify ? { outputId: 'notify', state: 'set' as const, value: true } : { outputId: 'notify', state: 'set' as const, value: false }] });
  t.rules = [rule('a', '台帳A', false), rule('b', null, true)];
  let u = unconditional(separate(t, [0, 1])); assert.deepEqual(u.outputs, [{ values: ['台帳A'] }, { values: [true] }]); assert.equal(u.satisfied, true); // "not executed" entries add nothing
  t.rules.push(rule('c', '台帳B', false)); u = unconditional(separate(t, [0, 1]));
  assert.deepEqual(u.outputs[0].values.sort(), ['台帳A', '台帳B']); assert.ok(diagnose(t).some(d => d.level === 'error')); // the same discrepancy "検証" reports
  t.rules = [rule('a', '台帳A', false), rule('a2', '台帳A', false)]; assert.deepEqual(unconditional(separate(t, [0])).outputs, [{ values: ['台帳A'] }]);
});
test('issue #13: repeated merging says when it stopped at its limit, and continuing reaches the same result', () => {
  const t: Table = emptyTable(); t.conditions = [enumCondition('c', 40)]; t.outputs = [{ id: 'o', name: '値', kind: 'result', type: 'string' }];
  t.rules = t.conditions[0].partitions.map((p, j) => ({ id: `r${j}`, anyOf: [{ selections: [{ conditionId: 'c', partitionIds: [p.id] }] }], directives: [{ outputId: 'o', state: 'set' as const, value: `g${Math.floor(j / 2)}` }] }));
  const full = compressAll(t); assert.equal(full.complete, true); assert.equal(full.steps, 20); assert.equal(full.table.rules.length, 20); assert.equal(proposeStructural(full.table).length, 0);
  const cut = compressAll(t, 5); assert.equal(cut.complete, false); assert.equal(cut.steps, 5); assert.equal(cut.table.rules.length, 35); assert.ok(proposeStructural(cut.table).length > 0);
  let x = t, rounds = 0, steps = 0; for (;;) { const next = compressAll(x, 5); x = next.table; steps += next.steps; rounds++; if (next.complete) break; assert.ok(rounds < 20); }
  assert.equal(steps, 20); assert.deepEqual(x, full.table); assert.equal(verifyEquivalent(t, x).equal, true);
  assert.equal(compressAll(t, 20).complete, true); // stopping exactly when nothing is left is complete
  assert.deepEqual(compressAll(full.table), { table: full.table, steps: 0, complete: true });
});
