import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as core from '../src/core.ts';
import * as files from '../src/files.ts';
import * as schema from '../src/schema.ts';
class Element {
  value = ''; hidden = false; options: any[] = []; inert = false;
  append() {} replaceChildren() {} addEventListener() {} setAttribute() {} remove() {} click() {}
}
function environment(pickers: object) {
  const elements = new Map<string, Element>(), main = new Element();
  const context = vm.createContext({
    console, window: { ...pickers, addEventListener() {} },
    document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); }, addEventListener() {}, querySelectorAll() { return [main]; }, hidden: false },
    confirm: () => true, setInterval() {}, setTimeout, structuredClone, Blob, URL, TextEncoder, crypto,
    require(id: string) { return ({ './core.ts': core, './files.ts': files, './schema.ts': schema } as any)[id]; }, exports: {}
  });
  const source = ts.transpileModule(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(source, context); return { context, main };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('a delayed open cannot replace a workspace edited after the read started', async () => {
  let finish!: (raw: string) => void;
  const raw = core.encode({ ...core.emptyTable(), title: 'opened file' });
  const handle = { name: 'slow.json', async getFile() { return { text: () => new Promise<string>(resolve => { finish = resolve; }) }; } };
  const { context } = environment({ showOpenFilePicker: async () => [handle] });
  const operation = vm.runInContext('openFile()', context); await tick();
  vm.runInContext("commit({...table,title:'new local work'});", context); finish(raw);
  await assert.rejects(operation, /古い結果の適用を中止/);
  assert.equal(vm.runInContext('table.title', context), 'new local work'); assert.equal(vm.runInContext('session', context), null);
});
test('a delayed Save As does not attach its old file session to a newer workspace', async () => {
  let finishWrite!: () => void, raw = '', pending = '';
  const handle = { name: 'slow-save.json', async getFile() { return { async text() { return raw; } }; }, async createWritable() { return { write(text: string) { pending = text; return new Promise<void>(resolve => { finishWrite = resolve; }); }, async close() { raw = pending; }, async abort() {} }; } };
  const { context } = environment({ showSaveFilePicker: async () => handle });
  const operation = vm.runInContext('saveAs()', context); await tick();
  vm.runInContext("commit({...table,title:'newer workspace'});", context); finishWrite();
  await assert.rejects(operation, /古い結果の適用を中止/);
  assert.equal(vm.runInContext('table.title', context), 'newer workspace'); assert.equal(vm.runInContext('session', context), null);
});
test('file operation UI exclusion is serialized and restored even after failure', async () => {
  const { context, main } = environment({});
  const operation = vm.runInContext("fileTask(async()=>{await new Promise(resolve=>{globalThis.releaseFile=resolve});throw Error('failure')})", context);
  assert.equal(main.inert, true);
  await assert.rejects(vm.runInContext('fileTask(async()=>{})', context), /処理中/);
  vm.runInContext('releaseFile()', context); await assert.rejects(operation, /failure/); assert.equal(main.inert, false);
});
