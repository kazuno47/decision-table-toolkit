// TASK-014 / INS-013, CHG-014 / REQ-019 / API-008: the engine other software uses gives the same interpretation as the table itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, atoms, resultOf, encode, type Table, type Clause, type Condition } from '../src/core.ts';
import { load, conditions, actions, classify, evaluate, version } from '../src/engine.ts';

function random(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
// two actions: a limited entry (X / -) and an extended entry (a value)
function randomTable(seed: number): Table {
  const r = random(seed), sizes = Array.from({ length: 2 + Math.floor(r() * 3) }, () => 2 + Math.floor(r() * 3)), t = emptyTable();
  t.conditions = sizes.map((n, i) => ({ id: `c${i}`, name: `条件${i}`, type: 'enum', partitions: Array.from({ length: n }, (_, j) => ({ id: `c${i}p${j}`, label: `v${j}`, kind: 'values', values: [`v${j}`] })) }));
  t.outputs = [{ id: 'a', name: '実施', kind: 'action' }, { id: 'v', name: '承認者', kind: 'result', type: 'string' }];
  const clause = (): Clause => ({ selections: sizes.flatMap((n, i) => { if (r() < 0.4) return []; const ids = Array.from({ length: n }, (_, j) => j).filter(() => r() < 0.5); return [{ conditionId: `c${i}`, partitionIds: (ids.length ? ids : [0]).map(j => `c${i}p${j}`) }]; }) });
  t.rules = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => ({ id: `r${k}`, anyOf: Array.from({ length: 1 + Math.floor(r() * 2) }, clause), directives: [
    r() < 0.5 ? { outputId: 'a', state: 'set' as const, value: r() < 0.8 } : { outputId: 'a', state: 'unset' as const },
    r() < 0.6 ? { outputId: 'v', state: 'set' as const, value: ['課長', '部長', '役員'][Math.floor(r() * 3)] } : { outputId: 'v', state: 'unset' as const }] }));
  return t;
}
// what the definition says for a set of inputs: per action, the distinct values over every input of the range
function expected(t: Table, range: Record<string, string>[]) {
  return t.outputs.map((_, o) => {
    const sets = range.map(a => resultOf(t, a)[o]);
    if (sets.some(s => s.length > 1)) return { status: 'conflict' };
    if (sets.every(s => s.length === 0)) return { status: 'none' };
    if (sets.every(s => s.length === 1 && s[0] === sets[0][0])) return { status: 'determined', value: JSON.parse(sets[0][0]) };
    return { status: 'open' };
  });
}

test('with every condition given, each action is what the satisfied rules specify (300 random tables, every input)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed);
    for (const atom of atoms(t)) {
      const e = evaluate(t, atom), want = expected(t, [atom]);
      assert.equal(e.complete, true); assert.deepEqual(e.needed, []); assert.deepEqual(e.ignored, []);
      e.actions.forEach((a, o) => {
        assert.equal(a.status, want[o].status, `seed ${seed}`); assert.notEqual(a.status, 'open');
        assert.equal(a.executed, a.status === 'determined' ? true : a.status === 'none' ? false : null);
        assert.equal(a.value, a.status === 'determined' ? want[o].value : null);
      });
      assert.deepEqual(e.rules.map(r => r.id), t.rules.filter(r => r.anyOf.some(c => c.selections.every(s => s.partitionIds.includes(atom[s.conditionId])))).map(r => r.id));
      assert.ok(e.rules.every(r => r.always)); assert.equal(e.decided, !e.conflict);
    }
  }
});
test('with some conditions left out, decided actions hold for every remaining input and open ones name conditions still needed', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const t = randomTable(seed), r = random(seed + 7000), all = atoms(t);
    for (let trial = 0; trial < 6; trial++) {
      const picks = Object.fromEntries(t.conditions.filter(() => r() < 0.5).map(c => [c.id, c.partitions[Math.floor(r() * c.partitions.length)].id]));
      const range = all.filter(a => Object.entries(picks).every(([k, v]) => a[k] === v)), e = evaluate(t, picks), want = expected(t, range);
      e.actions.forEach((a, o) => { assert.equal(a.status, want[o].status, `seed ${seed}`); if (a.status === 'determined') assert.equal(a.value, want[o].value); });
      assert.equal(e.complete, Object.keys(picks).length === t.conditions.length);
      assert.equal(e.decided, want.every(w => w.status === 'determined' || w.status === 'none'));
      assert.ok(e.needed.every(id => !(id in picks) && t.conditions.some(c => c.id === id)));
      if (e.actions.some(a => a.status === 'open')) assert.ok(e.needed.length > 0, `seed ${seed}`);
      // candidates of an action are exactly the values it takes somewhere in the range
      e.actions.forEach((a, o) => assert.deepEqual([...new Set(a.candidates.map(v => JSON.stringify(v)))].sort(), [...new Set(range.flatMap(x => resultOf(t, x)[o]))].sort(), `seed ${seed}`));
    }
  }
});
test('giving the needed conditions one by one always ends in a decision or a reported conflict', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const t = randomTable(seed), r = random(seed + 99), picks: Record<string, string> = {};
    for (let step = 0; step <= t.conditions.length; step++) {
      const e = evaluate(t, picks); if (e.decided || e.conflict) break;
      assert.ok(e.needed.length > 0 && step < t.conditions.length, `seed ${seed}`);
      const c = t.conditions.find(x => x.id === e.needed[0])!; picks[c.id] = c.partitions[Math.floor(r() * c.partitions.length)].id;
    }
  }
});

const sample = (): Table => {
  const t = emptyTable(), range = (id: string, label: string, lower: string | null, upper: string | null, li = true, ui = false) => ({ id, label, kind: 'range' as const, range: { lower, upper, lowerInclusive: li, upperInclusive: ui } });
  t.conditions = [
    { id: 'amount', name: '金額', type: 'number', partitions: [range('a1', '1億未満', null, '100000000'), range('a2', '1億以上3億未満', '100000000', '300000000'), range('a3', '3億以上', '300000000', null), { id: 'a0', label: '未定', kind: 'missing' }] },
    { id: 'kind', name: '種別', type: 'enum', partitions: [{ id: 'k1', label: 'AまたはB', kind: 'values', values: ['A', 'B'] }, { id: 'k2', label: 'C', kind: 'values', values: ['C'] }] },
    { id: 'pii', name: '個人情報', type: 'boolean', partitions: [{ id: 'yes', label: 'あり', kind: 'values', values: [true] }, { id: 'no', label: 'なし', kind: 'values', values: [false] }] },
    { id: 'due', name: '期限', type: 'date', partitions: [range('d1', '年内', null, '2026-12-31', true, true), range('d2', '来年以降', '2026-12-31', null, false, false)] }];
  t.outputs = [{ id: 'approver', name: '承認者', kind: 'result', type: 'string' }, { id: 'security', name: 'セキュリティ部門のチェック', kind: 'action' }];
  const rule = (id: string, sel: Record<string, string[]>, approver: string | null, security: boolean) => ({ id, anyOf: [{ selections: Object.entries(sel).map(([conditionId, partitionIds]) => ({ conditionId, partitionIds })) }],
    directives: [approver === null ? { outputId: 'approver', state: 'unset' as const } : { outputId: 'approver', state: 'set' as const, value: approver }, security ? { outputId: 'security', state: 'set' as const, value: true } : { outputId: 'security', state: 'unset' as const }] });
  t.rules = [rule('r1', { amount: ['a1'] }, '課長', false), rule('r2', { amount: ['a2'] }, '部長', false), rule('r3', { amount: ['a3'] }, '役員', false), rule('r4', { pii: ['yes'] }, null, true)];
  return t;
};
test('raw values are placed in the defined entries with exact bounds, decimals and dates', () => {
  const t = sample(), at = (v: Parameters<typeof classify>[1]) => classify(t, v);
  assert.deepEqual(at({ amount: 99999999 }), { amount: 'a1' }); assert.deepEqual(at({ amount: 100000000 }), { amount: 'a2' });
  assert.deepEqual(at({ amount: '99999999.99999999999999999999' }), { amount: 'a1' }); assert.deepEqual(at({ amount: '100000000.00' }), { amount: 'a2' });
  assert.deepEqual(at({ amount: '299999999.999' }), { amount: 'a2' }); assert.deepEqual(at({ amount: '300000000' }), { amount: 'a3' }); assert.deepEqual(at({ amount: -5 }), { amount: 'a1' });
  assert.deepEqual(at({ amount: null }), { amount: 'a0' }); assert.deepEqual(at({ amount: undefined }), {});
  assert.deepEqual(at({ kind: 'B', pii: true, due: '2026-12-31' }), { kind: 'k1', pii: 'yes', due: 'd1' }); assert.deepEqual(at({ due: '2027-01-01', pii: false }), { due: 'd2', pii: 'no' });
  assert.deepEqual(at({ 金額: 5, 種別: 'C', 知らない項目: 'x' }), { amount: 'a1', kind: 'k2' }); // by name; other keys are skipped
  for (const bad of [{ kind: 'D' }, { kind: null }, { pii: 'true' }, { amount: 'abc' }, { amount: 1e21 }, { amount: NaN }, { kind: 3 }, { due: '2026-02-30' }, { due: '2026/12/31' }, { pii: 1 }]) assert.throws(() => at(bad as never), JSON.stringify(bad));
});
test('the worked example: actions combine per action, and only the conditions that matter are asked for', () => {
  const t = sample();
  let e = evaluate(t, {}); assert.equal(e.decided, false); assert.deepEqual(e.needed, ['amount', 'pii']); // kind and due are never needed
  e = evaluate(t, classify(t, { 金額: 350000000 }));
  assert.deepEqual(e.actions.map(a => [a.name, a.status, a.value]), [['承認者', 'determined', '役員'], ['セキュリティ部門のチェック', 'open', null]]); assert.deepEqual(e.needed, ['pii']); assert.deepEqual(e.actions[1].candidates, [true]);
  e = evaluate(t, classify(t, { 金額: 350000000, 個人情報: true }));
  assert.equal(e.decided, true); assert.equal(e.complete, false); assert.deepEqual(e.actions.map(a => [a.executed, a.value]), [[true, '役員'], [true, true]]); assert.deepEqual(e.rules.map(r => [r.id, r.number, r.always]), [['r3', 3, true], ['r4', 4, true]]); assert.deepEqual(e.actions[1].rules, ['r4']);
  e = evaluate(t, { 金額: '1億未満', 個人情報: 'なし' }); // by name and label
  assert.deepEqual(e.actions.map(a => [a.status, a.executed, a.value]), [['determined', true, '課長'], ['none', false, null]]); assert.equal(e.decided, true);
  e = evaluate(t, { amount: 'a0', pii: 'no' }); assert.deepEqual(e.actions.map(a => a.status), ['none', 'none']); assert.deepEqual(e.rules, []); // no rule is satisfied
  t.rules.push({ ...t.rules[0], id: 'r5', directives: [{ outputId: 'approver', state: 'set', value: '部長' }, { outputId: 'security', state: 'unset' }] });
  e = evaluate(t, { amount: 'a1' }); assert.equal(e.conflict, true); assert.equal(e.decided, false); assert.equal(e.actions[0].status, 'conflict'); assert.deepEqual(e.actions[0].candidates.sort(), ['課長', '部長'].sort()); assert.equal(e.actions[0].executed, null);
});
test('keys and values are checked: unknown keys are reported, wrong or ambiguous ones are refused', () => {
  const t = sample();
  assert.deepEqual(evaluate(t, { amount: 'a1', フェーズ: '提案前' }).ignored, ['フェーズ']);
  assert.throws(() => evaluate(t, { amount: 'a9' }), /という値はありません/); assert.throws(() => evaluate(t, { amount: 'a1', 金額: 'a1' }), /2回指定/);
  t.conditions[1].name = '金額'; assert.throws(() => evaluate(t, { 金額: 'a1' }), /複数あります/); assert.equal(evaluate(t, { amount: 'a1' }).actions[0].value, '課長');
  (t.conditions[2] as Condition).partitions[1].label = 'あり'; assert.throws(() => evaluate(t, { pii: 'あり' }), /ラベルの値が複数/); assert.equal(evaluate(t, { pii: 'yes' }).actions[1].executed, true);
});
test('load validates like the editor and does not share state with its input; the lists describe the table', () => {
  const t = sample(), text = encode(t), fromText = load(text), raw = JSON.parse(text), fromObject = load(raw);
  assert.deepEqual(fromText, fromObject); raw.title = 'changed'; assert.notEqual(fromObject.title, 'changed');
  assert.throws(() => load('{')); assert.throws(() => load({ ...raw, schemaVersion: '9.9' })); assert.throws(() => load({ ...raw, extra: 1 })); assert.throws(() => load(null));
  assert.throws(() => evaluate({ ...t, rules: [{ ...t.rules[0], directives: [] }] }, {}));
  assert.deepEqual(conditions(fromText).map(c => [c.id, c.name, c.type, c.values.length]), [['amount', '金額', 'number', 4], ['kind', '種別', 'enum', 2], ['pii', '個人情報', 'boolean', 2], ['due', '期限', 'date', 2]]);
  assert.deepEqual(conditions(fromText)[2].values, [{ id: 'yes', label: 'あり' }, { id: 'no', label: 'なし' }]);
  assert.deepEqual(actions(fromText), [{ id: 'approver', name: '承認者', kind: 'result' }, { id: 'security', name: 'セキュリティ部門のチェック', kind: 'action' }]);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const empty = emptyTable(); empty.outputs = [{ id: 'o', name: '動作', kind: 'action' }]; assert.deepEqual(evaluate(empty, {}).actions.map(a => a.status), ['none']);
});
