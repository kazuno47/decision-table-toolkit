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
