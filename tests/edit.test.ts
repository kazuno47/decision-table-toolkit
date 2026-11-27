// DEF-009 (issue #11), DEF-012 (issue #14) / REQ-013: editing a definition keeps everything the edit does not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, assertValid, migrateRules, choiceLines, parseChoiceLines, retainPartitions, carryDirective, type Condition, type Output, type Partition, type Table } from '../src/core.ts';

const grouped = (): Table => {
  const t = emptyTable();
  t.conditions = [{ id: 'kind', name: '種別', type: 'enum', partitions: [{ id: 'ab', label: '主要案件', kind: 'values', values: ['A', 'B'] }, { id: 'c', label: 'その他（C）', kind: 'values', values: ['C'] }, { id: 'e', label: '（空文字）', kind: 'values', values: [''] }, { id: 'm', label: '不明', kind: 'missing' }] }];
  t.outputs = [{ id: 'o', name: '監査', kind: 'action' }];
  t.rules = [{ id: 'r1', anyOf: [{ selections: [{ conditionId: 'kind', partitionIds: ['ab'] }] }], directives: [{ outputId: 'o', state: 'set', value: true }] }, { id: 'r2', anyOf: [{ selections: [{ conditionId: 'kind', partitionIds: ['c', 'm'] }] }], directives: [{ outputId: 'o', state: 'unset' }] }];
  assertValid(t); return t;
};
// what the condition dialog does on "apply": text -> entries with new ids -> entries that are unchanged keep id and label
function reapply(t: Table, text: string, missing = true): { condition: Condition; migrated: ReturnType<typeof migrateRules> } {
  const original = t.conditions[0]; let partitions: Partition[] = parseChoiceLines(text).map((x, i) => ({ id: `new${i}`, label: x.label, kind: 'values', values: x.values }));
  if (missing) partitions.push({ id: 'new-missing', label: '未定義', kind: 'missing' });
  const condition = { ...original, name: '案件種別', partitions: retainPartitions(original, partitions) };
  return { condition, migrated: migrateRules(t, { ...structuredClone(t), conditions: [condition], rules: [] }) };
}
test('issue #11: opening a condition with a grouped entry and applying it unchanged keeps entries, labels and rules', () => {
  const t = grouped(), text = choiceLines(t.conditions[0]);
  assert.equal(text, '["A","B"]\n"C"\n""');
  const { condition, migrated } = reapply(t, text);
  assert.deepEqual(condition.partitions, t.conditions[0].partitions); // ids, labels, grouping and the missing entry
  assert.deepEqual([migrated.dropped, migrated.widened, migrated.narrowed], [0, 0, 0]); assert.deepEqual(migrated.table.rules, t.rules);
});
test('issue #11: only what the user really changes is affected', () => {
  const t = grouped();
  let r = reapply(t, '["A","B"]\n"C"\n""\nD'); // a candidate is added
  assert.deepEqual(r.condition.partitions.map(p => [p.id, p.label]), [['ab', '主要案件'], ['c', 'その他（C）'], ['e', '（空文字）'], ['new3', 'D'], ['m', '不明']]); assert.equal(r.migrated.dropped + r.migrated.narrowed, 0);
  r = reapply(t, '"A"\n"B"\n"C"\n""'); // the group is split on purpose: its rule no longer has an entry to refer to
  assert.deepEqual(r.condition.partitions.slice(0, 2).map(p => [p.id, p.label]), [['new0', 'A'], ['new1', 'B']]); assert.equal(r.migrated.dropped, 1);
  r = reapply(t, '["A","B","X"]\n"C"\n""'); assert.equal(r.condition.partitions[0].id, 'new0'); assert.equal(r.condition.partitions[0].label, 'A・B・X'); // a different group is a new entry
  r = reapply(t, '["A","B"]\n""', false); assert.deepEqual(r.condition.partitions.map(p => p.id), ['ab', 'e']); assert.deepEqual([r.migrated.dropped, r.migrated.narrowed], [1, 0]); // C and "missing" removed: r2 has nothing left
});
test('the lines of the condition editor: one entry per line, literal text stays literal', () => {
  assert.deepEqual(parseChoiceLines('優良\n一般\r\n\n" 前後に空白 "\n""'), [{ label: '優良', values: ['優良'] }, { label: '一般', values: ['一般'] }, { label: ' 前後に空白 ', values: [' 前後に空白 '] }, { label: '（空文字）', values: [''] }]);
  assert.deepEqual(parseChoiceLines('["A","B"]\n[未分類]\n[1,2]\n[]\n"[\\"A\\"]"'), [{ label: 'A・B', values: ['A', 'B'] }, { label: '[未分類]', values: ['[未分類]'] }, { label: '[1,2]', values: ['[1,2]'] }, { label: '[]', values: ['[]'] }, { label: '["A"]', values: ['["A"]'] }]);
  assert.throws(() => parseChoiceLines('"閉じていない')); assert.throws(() => parseChoiceLines('"a" 3'));
  for (const values of [['x'], ['[x]'], ['a', 'b'], ['', ' '], ['"q"', '[', ']'], ['["A","B"]']]) { // every entry survives showing and reading back
    const c = { partitions: [{ id: 'p', label: 'l', kind: 'values' as const, values }] }; assert.deepEqual(parseChoiceLines(choiceLines(c)).map(x => x.values), [values]);
  }
  const bool = { partitions: [{ id: 't', label: 'はい', kind: 'values' as const, values: [true] }, { id: 'f', label: 'いいえ', kind: 'values' as const, values: [false] }] };
  assert.deepEqual(retainPartitions(bool, [true, false].map(v => ({ id: `n${v}`, label: String(v), kind: 'values' as const, values: [v] }))), bool.partitions);
  const range = { id: 'r', label: '旧名', kind: 'range' as const, range: { lower: '0', upper: '10', lowerInclusive: true, upperInclusive: false } };
  assert.deepEqual(retainPartitions({ partitions: [range] }, [{ ...range, id: 'n', label: '新名' }]), [{ ...range, label: '新名' }]); // a range can be renamed in the editor
});
test('issue #14: changing an action keeps every action entry that is still valid', () => {
  const before: Output = { id: 'o', name: '承認者', kind: 'result', type: 'enum', values: ['課長', '部長'] }, set = (value: string | boolean) => ({ outputId: 'o', state: 'set' as const, value }), unset = { outputId: 'o', state: 'unset' as const };
  const carry = (after: Output, value: string | boolean, from: Output = before) => carryDirective(from, after, set(value));
  assert.deepEqual(carry({ ...before, values: ['課長', '部長', '役員'] }, '課長'), set('課長')); // a candidate is added
  assert.deepEqual(carry({ ...before, values: ['部長', '課長'] }, '部長'), set('部長')); // reordered
  assert.deepEqual(carry({ ...before, name: '最終承認者' }, '部長'), set('部長'));
  assert.deepEqual(carry({ ...before, values: ['部長'] }, '課長'), unset); assert.deepEqual(carry({ ...before, values: ['部長'] }, '部長'), set('部長')); // only the removed candidate is lost
  assert.deepEqual(carry({ id: 'o', name: '承認者', kind: 'result', type: 'string' }, '課長'), unset); // another type: nothing is assumed
  assert.deepEqual(carry({ id: 'o', name: '承認者', kind: 'action' }, '課長'), unset);
  const action: Output = { id: 'o', name: '監査', kind: 'action' };
  assert.deepEqual(carry({ ...action, name: '内部監査' }, true, action), set(true)); assert.deepEqual(carry({ id: 'o', name: '監査', kind: 'result', type: 'boolean' }, true, action), unset);
  const number: Output = { id: 'o', name: '金額', kind: 'result', type: 'number' }; assert.deepEqual(carry({ ...number, name: '上限' }, '12.50', number), set('12.50'));
  assert.deepEqual(carryDirective(before, before, unset), unset); assert.deepEqual(carryDirective(before, before, undefined), unset); assert.deepEqual(carryDirective(undefined, before, set('課長')), unset); // a new action starts empty
});
