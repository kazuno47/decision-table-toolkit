// Build a self-contained HTML with no runtime network dependency.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const offline = process.argv.includes('--offline-compiler');
let js, engine;
// The engine: the interpretation of a table as one dependency-free ES module for other software (TASK-014).
const banner = `// Decision Table Toolkit - engine v${JSON.parse(await readFile('package.json', 'utf8')).version}\n// https://github.com/kazuno47/decision-table-toolkit  (types: decision-table-engine.d.ts)\n`;
if (offline) {
  // Explicit verification fallback when network restrictions prevent installing esbuild.
  const ts = (await import('typescript')).default;
  const names = ['schema', 'core', 'files', 'app'];
  const pack = names => Promise.all(names.map(async name => {
    const source = await readFile(`src/${name}.ts`, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    return `${JSON.stringify('./' + name + '.ts')}: function(require,module,exports){\n${output.outputText}\n}`;
  }));
  const loader = (modules, entry) => `(function(){'use strict';const modules={${modules.join(',\n')}};const cache={};function require(id){if(cache[id])return cache[id].exports;if(!Object.hasOwn(modules,id))throw Error('Unknown internal module');const m={exports:{}};cache[id]=m;modules[id](require,m,m.exports);return m.exports;}return require('./${entry}.ts');})()`;
  js = `${loader(await pack(names), 'app')};`;
  const exported = [...(await readFile('src/engine.ts', 'utf8')).matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  engine = `const __engine = ${loader(await pack(['schema', 'core', 'engine']), 'engine')};\nexport const { ${exported.join(', ')} } = __engine;\n`;
} else {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { throw new Error('esbuild未取得です。npm install後に再実行するか、明示的な検証用 npm run build:offline を使用してください'); }
  const result = await esbuild.build({ entryPoints: ['src/app.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, legalComments: 'inline' });
  js = result.outputFiles[0].text;
  engine = (await esbuild.build({ entryPoints: ['src/engine.ts'], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, legalComments: 'inline' })).outputFiles[0].text;
}
const template = await readFile('public/index.html', 'utf8'), css = await readFile('src/style.css', 'utf8');
const html = template.replace('<!--STYLE-->', () => `<style>${css}</style>`).replace('<!--SCRIPT-->', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>`);
await mkdir('dist', { recursive: true }); await writeFile('dist/decision-table-toolkit.html', html);
await writeFile('dist/decision-table-engine.js', banner + engine); await copyFile('types/decision-table-engine.d.ts', 'dist/decision-table-engine.d.ts');
console.log(`${resolve('dist/decision-table-engine.js')} (${Buffer.byteLength(banner + engine)} bytes)`);
console.log(`${resolve('dist/decision-table-toolkit.html')} (${Buffer.byteLength(html)} bytes; compiler=${offline ? 'typescript-offline-verification' : 'esbuild'})`);
