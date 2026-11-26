import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTable, encode, clone, stable } from '../src/core.ts';
import { FileCoordinator, writeVerified, type Handle } from '../src/files.ts';
function mock(raw = encode(emptyTable())) {
  const state = { raw, writes: 0, failWrite: false, mutateAfterClose: false, reads: 0, mutateAtRead: 0 };
  const handle: Handle = { name: 'fixture.json', async getFile() { state.reads++; if (state.reads === state.mutateAtRead) state.raw = 'external'; const value = state.raw; return { async text() { return value; } }; }, async createWritable() { let pending = ''; return { async write(text) { state.writes++; if (state.failWrite) throw new Error('Permission denied'); pending = String(text); }, async close() { state.raw = state.mutateAfterClose ? 'external-race' : pending; }, async abort() {} }; } };
  return { state, handle };
}
test('three-way comparison reports clean, local, external, and both-edited states', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle); assert.equal((await session.check(table)).kind, 'same');
  const local = clone(table); local.title = 'local'; assert.equal((await session.check(local)).kind, 'local');
  const external = clone(table); external.title = 'external'; state.raw = encode(external); assert.equal((await session.check(table)).kind, 'external'); assert.equal((await session.check(local)).kind, 'conflict'); assert.equal(session.baseModel, stable(table));
});
test('malformed external JSON does not advance the baseline or destroy the local model', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle), baseline = session.baseRaw;
  state.raw = '{bad'; await assert.rejects(() => session.check(table)); assert.equal(session.baseRaw, baseline); assert.equal(session.baseModel, stable(table));
});
test('accepting an external version rereads it and rejects changed confirmation targets', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle); const external = clone(table); external.title = 'external'; const shown = encode(external); state.raw = shown;
  const observation = await session.check(table); state.raw = encode({ ...external, title: 'newer' }); await assert.rejects(() => session.accept(observation.raw), /再変更/); assert.equal(session.baseModel, stable(table));
  state.raw = shown; assert.equal((await session.accept(shown)).title, 'external');
});
test('pre-save external changes refuse writes and preserve the baseline', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle), base = session.baseRaw;
  state.raw = encode({ ...table, title: 'outside' }); await assert.rejects(() => session.save({ ...table, title: 'inside' }), /外部変更/); assert.equal(state.writes, 0); assert.equal(session.baseRaw, base);
});
test('a change after opening the writer is caught before writing', async () => {
  const { state, handle } = mock(); const base = state.raw; state.mutateAtRead = 2;
  await assert.rejects(() => writeVerified(handle, base, 'new-data'), /外部変更/); assert.equal(state.writes, 0);
});
test('failed writes never mark the local version as saved', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle); const base = session.baseRaw; state.failWrite = true;
  await assert.rejects(() => session.save({ ...table, title: 'local' })); assert.equal(session.baseRaw, base); assert.equal(session.baseModel, stable(table));
});
test('post-save mismatches are failures, not false save acknowledgements', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle); const base = session.baseRaw; state.mutateAfterClose = true;
  await assert.rejects(() => session.save({ ...table, title: 'local' }), /再読込/); assert.equal(session.baseRaw, base);
});
test('a verified save advances the baseline only to the saved snapshot', async () => {
  const { state, handle } = mock(), { session, table } = await FileCoordinator.connect(handle); const local = { ...table, title: 'saved' }; await session.save(local);
  assert.equal(session.baseRaw, encode(local)); assert.equal(session.baseModel, stable(local)); assert.equal(state.writes, 1);
});
