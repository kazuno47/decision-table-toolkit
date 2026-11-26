// Build a self-contained HTML with no runtime network dependency.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const offline = process.argv.includes('--offline-compiler');
let js;
if (offline) {
  // Explicit verification fallback when network restrictions prevent installing esbuild.
  const ts = (await import('typescript')).default;
  const names = ['schema', 'core', 'files', 'app'];
  const modules = await Promise.all(names.map(async name => {
    const source = await readFile(`src/${name}.ts`, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    return `${JSON.stringify('./' + name + '.ts')}: function(require,module,exports){\n${output.outputText}\n}`;
  }));
  js = `(function(){'use strict';const modules={${modules.join(',\n')}};const cache={};function require(id){if(cache[id])return cache[id].exports;if(!Object.hasOwn(modules,id))throw Error('Unknown internal module');const m={exports:{}};cache[id]=m;modules[id](require,m,m.exports);return m.exports;}require('./app.ts');})();`;
} else {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { throw new Error('esbuild未取得です。npm install後に再実行するか、明示的な検証用 npm run build:offline を使用してください'); }
  const result = await esbuild.build({ entryPoints: ['src/app.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, legalComments: 'inline' });
  js = result.outputFiles[0].text;
}
const template = await readFile('public/index.html', 'utf8'), css = await readFile('src/style.css', 'utf8');
const html = template.replace('<!--STYLE-->', () => `<style>${css}</style>`).replace('<!--SCRIPT-->', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>`);
await mkdir('dist', { recursive: true }); await writeFile('dist/decision-table-toolkit.html', html);
console.log(`${resolve('dist/decision-table-toolkit.html')} (${Buffer.byteLength(html)} bytes; compiler=${offline ? 'typescript-offline-verification' : 'esbuild'})`);
