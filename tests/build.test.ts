import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('single HTML packaging preserves dollar sequences and produces parseable, self-contained script', () => {
  execFileSync(process.execPath, ['scripts/build.mjs', '--offline-compiler'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
  const html = readFileSync(new URL('../dist/decision-table-toolkit.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1); assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.ok(scripts[0][1].includes('path = \'$\'')); // catches replacement-string $' expansion
  assert.equal(/<script\b[^>]*\bsrc\s*=/i.test(html), false);
  assert.equal(/<link\b[^>]*\bhref\s*=/i.test(html), false);
  assert.equal(html.includes('<!--SCRIPT-->'), false); assert.equal(html.includes('<!--STYLE-->'), false);
  assert.ok(html.includes("connect-src 'none'")); assert.equal(html.includes('/.ads/'), false);
});
// TASK-014 / REQ-019: the engine is one dependency-free ES module that can be imported as built, with the release's version.
test('the built engine is a self-contained ES module that interprets a table', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs', '--offline-compiler'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
  const source = readFileSync(new URL('../dist/decision-table-engine.js', import.meta.url), 'utf8'), pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(/^\s*import\s/m.test(source), false); assert.equal(/\brequire\(['"](?!\.\/(schema|core|engine)\.ts)/.test(source), false);
  assert.equal(source.includes('document.'), false); assert.ok(source.startsWith(`// Decision Table Toolkit - engine v${pkg.version}`));
  const engine = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(engine.version, pkg.version); assert.ok(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8').includes(`rail-version">v${pkg.version}<`));
  const t = engine.load(JSON.stringify({ schemaVersion: '1.1', id: 't', title: 't', conditions: [{ id: 'c', name: '金額', type: 'number', partitions: [{ id: 'low', label: '100未満', kind: 'range', range: { lower: null, upper: '100', lowerInclusive: false, upperInclusive: false } }, { id: 'high', label: '100以上', kind: 'range', range: { lower: '100', upper: null, lowerInclusive: true, upperInclusive: false } }] }],
    outputs: [{ id: 'o', name: '承認', kind: 'action' }], rules: [{ id: 'r', anyOf: [{ selections: [{ conditionId: 'c', partitionIds: ['high'] }] }], directives: [{ outputId: 'o', state: 'set', value: true }] }] }));
  assert.deepEqual(engine.classify(t, { 金額: 100 }), { c: 'high' });
  assert.equal(engine.evaluate(t, engine.classify(t, { 金額: '99.99' })).actions[0].executed, false);
  assert.equal(engine.evaluate(t, { c: 'high' }).actions[0].executed, true);
  assert.equal(readFileSync(new URL('../dist/decision-table-engine.d.ts', import.meta.url), 'utf8'), readFileSync(new URL('../types/decision-table-engine.d.ts', import.meta.url), 'utf8'));
});
