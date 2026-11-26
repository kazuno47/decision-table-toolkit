// TASK-001 / SCR-001..005 / REQ-001..018. All user content uses textContent.
import { emptyTable, uid, clone, stable, decode, encode, validate, assertValid, count, atoms, generate, diagnose, patternCount, proposeMerges, applyCandidate, regeneratePreserving, expandRows, type Table, type Condition, type Output, type Partition, type Clause, type Candidate, type Directive, type DataType } from './core.ts';
import { FileCoordinator, writeVerified, type Handle, type Observation } from './files.ts';
import { documentSchema } from './schema.ts';
type PickerWindow = Window & { showOpenFilePicker?: (o: unknown) => Promise<Handle[]>; showSaveFilePicker?: (o: unknown) => Promise<Handle> };
const picker = window as PickerWindow;
let workspaceRevision = 0, fileBusy = false;
function captureWorkspace(): () => void {
  const revision = workspaceRevision, linked = session, model = stable(table);
  return () => { if (workspaceRevision !== revision || session !== linked || stable(table) !== model) throw new Error('処理中に表や連携先が変更されたため、古い結果の適用を中止しました。現在の編集内容は保持されています。'); };
}
async function fileTask(operation: () => Promise<unknown>) {
  if (fileBusy) throw new Error('別のファイル操作が処理中です');
  fileBusy = true; const surfaces = Array.from(document.querySelectorAll<HTMLElement>('main, dialog')).map(node => ({ node, inert: node.inert }));
  surfaces.forEach(({ node }) => { node.inert = true; });
  try { return await operation(); } finally { surfaces.forEach(({ node, inert }) => { node.inert = inert; }); fileBusy = false; }
}
let table = emptyTable(), saved = stable(table), session: FileCoordinator | null = null;
let candidates: Candidate[] = [], panel: 'none' | 'diagnostics' | 'merge' | 'expand' = 'none', page = 0, polling = false, pollErrors = 0;
let externalUIKey = '';
let pending: Observation | null = null, fileMessage = 'ファイル未連携', status = '新しい表を作成するか、サンプルを試してください。';
const root = document.getElementById('app')!;
root.innerHTML = `<aside class="rail"><div class="brand-mark">dt<span>∴</span></div><div class="rail-line"></div><span class="vertical">CONDITIONS INTO CLARITY</span><span class="rail-version">v0.1</span></aside><main><header><div><p class="eyebrow">DECISION TABLE TOOLKIT</p><h1>条件を整理。<span>判断を明確に。</span></h1><p class="intro">条件と結果をひとつの表に。オフラインで編集・検証・共有できます。</p></div><div class="header-meta"><span class="dot"></span> LOCAL & OFFLINE<br><small>Chrome / JSON schema 1.0</small></div></header><nav id="file-actions" aria-label="ファイル操作"></nav><section class="workspace"><div class="workspace-top"><div><label class="title-label" for="title">DECISION TABLE</label><input id="title" aria-label="決定表の名前" maxlength="256"></div><div id="counts" class="stats"></div></div><div class="toolbar"><div id="edit-actions"></div><div id="table-state"></div></div><div class="notice">全件適用・上から順：一致する規則をすべて順に扱います。これは本ツール独自の拡張です。業務処理は実行しません。JIS完全準拠を保証しません。</div><div id="definition-list"></div><div id="table-wrap"></div><div id="pagination"></div></section><section id="side-panel" class="side-panel" hidden></section><footer><div id="status" role="status" aria-live="polite"></div><div id="file-state"></div></footer><section id="external-actions"></section><details class="help"><summary>使い方と保存・ファイル連携について</summary><ol><li>条件と動作・結果を定義し、組み合わせを生成します。</li><li>結果を入力し、検証で未設定や網羅性を確認します。</li><li>「まとめる」で等価性を確認できた候補を作成し、承認して反映します。</li><li>JSONで保存・共有します。Chromeで選択したファイルは1秒を目安に再確認します。</li></ol><p>外部ツールと同じファイルへ同時に保存しないでください。ブラウザだけでOS全体の排他は保証できません。保存前に他ツールの編集を停止するか、別名へ書き出してください。バックグラウンド中は検知が遅れます。権限やAPIによって利用できない機能があります。ファイル選択・ダウンロードだけの利用では継続確認はできません。未保存内容はページを閉じると失われます。</p><div id="help-actions"></div></details></main>`;
const $ = (id: string) => document.getElementById(id)!;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; }
function button(text: string, action: () => unknown, cls = ''): HTMLButtonElement { const b = element('button', text, cls); b.type = 'button'; b.addEventListener('click', () => void run(action)); return b; }
function message(s: string) { status = s; $('status').textContent = s; }
async function run(action: () => unknown) { try { await action(); } catch (e) { if ((e as Error).name !== 'AbortError') message(`確認が必要です：${(e as Error).message}`); } }
const dirty = () => stable(table) !== (session?.baseModel ?? saved);
function commit(next: Table, note = '変更を反映しました') { assertValid(next); workspaceRevision++; table = next; candidates = []; pending = null; page = Math.min(page, Math.max(0, Math.ceil(table.rules.length / 40) - 1)); message(note); render(); }
function download(text: string, filename: string, mime = 'application/json') { const url = URL.createObjectURL(new Blob([text], { type: mime })), a = element('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function clearWorkspace() { if (dirty() && !confirm('未保存の変更があります。現在の表を閉じますか？')) return; session = null; pending = null; saved = stable(emptyTable()); table = emptyTable(); saved = stable(table); fileMessage = 'ファイル未連携'; panel = 'none'; page = 0; commit(table, '新しい表を作成しました'); }
function demo(): Table {
  const t = emptyTable(); t.title = '配送ルール';
  t.conditions = [
    { id: 'member', name: '会員区分', type: 'enum', partitions: ['一般', '優良'].map((v, i) => ({ id: `member-${i}`, label: v, kind: 'values', values: [v] })) },
    { id: 'region', name: '配送先', type: 'enum', partitions: ['本州', '北海道', '沖縄'].map((v, i) => ({ id: `region-${i}`, label: v, kind: 'values', values: [v] })) }
  ];
  t.outputs = [{ id: 'fee', name: '送料（円）', kind: 'result', type: 'number' }, { id: 'notify', name: '発送通知', kind: 'action' }];
  const result = generate(t);
  result.rules.forEach(r => { const member = r.anyOf[0].selections[0].partitionIds[0]; r.directives = [{ outputId: 'fee', state: 'set', value: member === 'member-1' ? '0' : '500' }, { outputId: 'notify', state: 'set', value: true }]; });
  return result;
}
function loadDemo() { if (dirty() && !confirm('現在の変更を破棄してサンプルを開きますか？')) return; session = null; fileMessage = 'ファイル未連携'; page = 0; commit(demo(), '6組み合わせ・2結果パターンのサンプルです。「まとめる」を試せます。'); }
function modal(title: string) { const d = element('dialog'); const form = element('div', '', 'modal-content'); form.append(element('h2', title)); d.append(form); document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal(); return { dialog: d, form, close: () => d.close() }; }
function field(label: string, control: HTMLElement, target: HTMLElement) { const wrap = element('label', '', 'field'); wrap.append(element('span', label), control); target.append(wrap); return wrap; }
function input(value = '', type = 'text') { const i = element('input'); i.type = type; i.value = value; return i; }
function select(values: [string, string][], value?: string) { const s = element('select'); for (const [v, label] of values) { const o = element('option', label); o.value = v; s.append(o); } if (value !== undefined) s.value = value; return s; }
const types: [string, string][] = [['boolean', 'Boolean / 真偽'], ['enum', 'Enum / 分類'], ['number', 'Number / 数値'], ['string', 'String / 文字列'], ['date', 'Date / 日付']];
function applyDefinitions(next: Table, close: () => void) {
  assertValid({ ...next, rules: [] });
  if (!table.rules.length) { commit({ ...next, rules: [] }); close(); return; }
  const migrated = regeneratePreserving(table, { ...next, rules: [] });
  const m = modal('条件変更の影響を確認');
  m.form.append(element('p', `変更後は${count(next)}組み合わせです。保持できない、または出力を確認し直す必要がある組み合わせ：${migrated.affected}件。変更前の表は選択が完了するまで保持します。`));
  const actions = element('div', '', 'modal-actions');
  actions.append(button('キャンセル', m.close), button('保持可能な結果を引き継ぐ', () => { commit(migrated.table); m.close(); close(); }, 'primary'), button('変更前JSONを書出後、再生成', () => { download(encode(table), 'decision-table-before-change.json'); commit(generate({ ...next, rules: [] }), '変更前JSONの書出を開始し、新しい組み合わせを生成しました。ダウンロード完了はブラウザで確認してください。'); m.close(); close(); })); m.form.append(actions);
}
function conditionDialog(original?: Condition) {
  const m = modal(original ? '条件を編集' : '条件を追加'), name = input(original?.name ?? ''), type = select(types, original?.type ?? 'boolean'), defs = element('div');
  name.placeholder = '例：会員区分、年齢、申込日'; field('条件名', name, m.form); field('型', type, m.form); m.form.append(defs);
  let choices = element('textarea'), rows = element('div'); const missing = input('', 'checkbox'); missing.checked = original?.partitions.some(p => p.kind === 'missing') ?? false;
  const rangeRows: { low: HTMLInputElement; high: HTMLInputElement; li: HTMLInputElement; hi: HTMLInputElement; label: HTMLInputElement }[] = [];
  function addRange(p?: Extract<Partition, { kind: 'range' }>) {
    const wrap = element('div', '', 'range-row'), low = input(p?.range.lower ?? ''), high = input(p?.range.upper ?? ''), li = input('', 'checkbox'), hi = input('', 'checkbox'), label = input(p?.label ?? '');
    li.checked = p?.range.lowerInclusive ?? true; hi.checked = p?.range.upperInclusive ?? false;
    low.placeholder = type.value === 'date' ? '2026-01-01' : '0'; high.placeholder = type.value === 'date' ? '2027-01-01' : '18'; label.placeholder = '表示名';
    const row = { low, high, li, hi, label }; rangeRows.push(row);
    field('区分名', label, wrap); field('下限（空欄＝なし）', low, wrap); field('下限を含む', li, wrap); field('上限（空欄＝なし）', high, wrap); field('上限を含む', hi, wrap);
    wrap.append(button('区分を削除', () => { rangeRows.splice(rangeRows.indexOf(row), 1); wrap.remove(); })); rows.append(wrap);
  }
  function redraw() {
    defs.replaceChildren(); rangeRows.length = 0;
    if (type.value === 'boolean') defs.append(element('p', 'true / false の2区分を定義します。'));
    else if (type.value === 'enum' || type.value === 'string') {
      choices = element('textarea'); choices.rows = 5; choices.placeholder = '優良\n一般\n新規';
      choices.value = original?.partitions.filter(p => p.kind === 'values').flatMap(p => p.values.map(v => typeof v === 'string' ? JSON.stringify(v) : String(v))).join('\n') ?? '';
      field('候補値（1行1値。空文字は ""、空白を保つ値は引用符で指定）', choices, defs);
    } else {
      rows = element('div'); defs.append(element('p', '数値は10進数、日付はYYYY-MM-DDで指定。区間の重複・逆転・空区間は拒否します。'), rows, button('＋ 範囲を追加', () => addRange()));
      const existing = original?.type === type.value ? original.partitions.filter((p): p is Extract<Partition, { kind: 'range' }> => p.kind === 'range') : [];
      if (existing.length) existing.forEach(p => addRange(p)); else addRange();
    }
    field('未定義値を明示区分として追加', missing, defs);
  }
  type.onchange = redraw; redraw();
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button('定義を反映', () => {
    if (!name.value.trim()) throw new Error('条件名を入力してください');
    let partitions: Partition[];
    if (type.value === 'boolean') partitions = [true, false].map(v => ({ id: uid('p'), label: String(v), kind: 'values', values: [v] }));
    else if (type.value === 'enum' || type.value === 'string') partitions = choices.value.split(/\r?\n/).filter(s => s.length > 0).map(s => { const v: unknown = s.startsWith('"') ? JSON.parse(s) : s; if (typeof v !== 'string') throw new Error('文字列を指定してください'); return { id: uid('p'), label: v === '' ? '（空文字）' : v, kind: 'values', values: [v] }; });
    else partitions = rangeRows.map(r => ({ id: uid('p'), label: r.label.value || `${r.li.checked ? '[' : '('}${r.low.value || '−∞'}, ${r.high.value || '∞'}${r.hi.checked ? ']' : ')'}`, kind: 'range', range: { lower: r.low.value || null, upper: r.high.value || null, lowerInclusive: r.li.checked, upperInclusive: r.hi.checked } }));
    if (missing.checked) partitions.push({ id: uid('p'), label: '未定義', kind: 'missing' });
    // Retain identifiers for unchanged partitions rather than resetting existing results on rename.
    if (original) partitions = partitions.map(p => { const prior = original.partitions.find(old => stable({ ...old, id: '', label: '' }) === stable({ ...p, id: '', label: '' })); return prior ? { ...p, id: prior.id } : p; });
    const c: Condition = { id: original?.id ?? uid('c'), name: name.value, type: type.value as DataType, partitions }, next = clone(table);
    if (original) next.conditions[next.conditions.findIndex(c => c.id === original.id)] = c; else next.conditions.push(c);
    applyDefinitions(next, m.close);
  }, 'primary')); m.form.append(actions);
}
function outputDialog(original?: Output) {
  const m = modal(original ? '動作・結果を編集' : '動作・結果を追加'), name = input(original?.name ?? ''), kind = select([['result', '結果の値'], ['action', '動作の実行有無']], original?.kind ?? 'result'), type = select(types, original?.kind === 'result' ? original.type : 'boolean'), choices = element('textarea');
  choices.value = original?.kind === 'result' ? (original.values ?? []).join('\n') : ''; choices.placeholder = '1行に1候補';
  field('名前', name, m.form); field('種類', kind, m.form); const typeField = field('結果の型', type, m.form), enumField = field('Enumの候補値', choices, m.form);
  function redraw() { typeField.hidden = kind.value === 'action'; enumField.hidden = kind.value === 'action' || type.value !== 'enum'; } kind.onchange = type.onchange = redraw; redraw();
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button('定義を反映', () => {
    if (!name.value.trim()) throw new Error('名前を入力してください');
    const o: Output = kind.value === 'action' ? { id: original?.id ?? uid('o'), name: name.value, kind: 'action' } : { id: original?.id ?? uid('o'), name: name.value, kind: 'result', type: type.value as DataType, ...(type.value === 'enum' ? { values: choices.value.split(/\r?\n/).filter(Boolean) } : {}) };
    const next = clone(table); if (original) next.outputs[next.outputs.findIndex(x => x.id === original.id)] = o; else next.outputs.push(o);
    // Output-only changes preserve rule order, OR clauses and matching multiplicity.
    next.rules.forEach(r => { r.directives = next.outputs.map(output => { const before = table.outputs.find(x => x.id === output.id); const d = r.directives.find(d => d.outputId === output.id); return before && stable({ ...before, name: '' }) === stable({ ...output, name: '' }) && d ? d : { outputId: output.id, state: 'unset' }; }); });
    assertValid(next);
    if (original && table.rules.length && !confirm('型や候補の変更で保持できない結果は未設定になります。変更を反映しますか？')) return;
    commit(next); m.close();
  }, 'primary')); m.form.append(actions);
}
function ruleConditions(id: string) {
  const r = table.rules.find(r => r.id === id)!; const m = modal('規則の条件を編集（OR / AND）'), list = element('div'); m.form.append(element('p', 'ブロック内の条件はAND、ブロック同士はORです。同じ規則へ複数ブロックが一致しても適用は1回です。'), list);
  const clauses: { selections: HTMLSelectElement[]; element: HTMLElement }[] = [];
  function add(c?: Clause) {
    const block = element('div', '', 'clause'), selections: HTMLSelectElement[] = []; list.append(block);
    for (const condition of table.conditions) {
      const s = select(condition.partitions.map(p => [p.id, p.label])); s.multiple = true; s.size = Math.min(4, condition.partitions.length);
      const ids = c?.selections.find(x => x.conditionId === condition.id)?.partitionIds ?? condition.partitions.map(p => p.id);
      Array.from(s.options).forEach(o => { o.selected = ids.includes(o.value); }); selections.push(s); field(condition.name, s, block);
    }
    const entry = { selections, element: block }; clauses.push(entry); block.append(button('このORブロックを削除', () => { clauses.splice(clauses.indexOf(entry), 1); block.remove(); }));
  }
  r.anyOf.forEach(add); m.form.append(button('＋ ORブロック', () => add()));
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button('条件を反映', () => { const next = clone(table); next.rules.find(x => x.id === id)!.anyOf = clauses.map(c => ({ selections: table.conditions.map((x, i) => ({ conditionId: x.id, partitionIds: Array.from(c.selections[i].selectedOptions).map(o => o.value) })) })); commit(next); m.close(); }, 'primary')); m.form.append(actions);
}
function outputControl(ruleId: string, output: Output, d: Directive) {
  const wrap = element('div', '', 'value-editor');
  const set = (value: Directive) => { const next = clone(table), r = next.rules.find(r => r.id === ruleId)!; r.directives[next.outputs.findIndex(o => o.id === output.id)] = value; commit(next, '値を反映しました'); };
  if (output.kind === 'action' || output.type === 'boolean') {
    const s = select([['unset', '— 未設定'], ['true', output.kind === 'action' ? '実行する' : 'true'], ['false', output.kind === 'action' ? '実行しない' : 'false']], d.state === 'unset' ? 'unset' : String(d.value));
    s.setAttribute('aria-label', output.name); s.onchange = () => void run(() => set(s.value === 'unset' ? { outputId: output.id, state: 'unset' } : { outputId: output.id, state: 'set', value: s.value === 'true' })); wrap.append(s);
  } else if (output.type === 'enum') {
    const s = select([['unset', '— 未設定'], ...(output.values ?? []).map((v, i): [string, string] => [String(i), v === '' ? '（空文字）' : v])], d.state === 'unset' ? 'unset' : String((output.values ?? []).indexOf(d.value as string)));
    s.setAttribute('aria-label', output.name); s.onchange = () => void run(() => set(s.value === 'unset' ? { outputId: output.id, state: 'unset' } : { outputId: output.id, state: 'set', value: output.values![Number(s.value)] })); wrap.append(s);
  } else {
    const i = input(d.state === 'set' ? String(d.value) : ''); i.placeholder = d.state === 'unset' ? '未設定' : output.type === 'string' ? '（空文字）' : ''; i.setAttribute('aria-label', output.name);
    i.onchange = () => void run(() => set({ outputId: output.id, state: 'set', value: i.value })); wrap.append(i);
    if (output.type === 'string' && d.state === 'unset') wrap.append(button('空文字', () => set({ outputId: output.id, state: 'set', value: '' }), 'tiny'));
    if (d.state === 'set') wrap.append(button('×', () => set({ outputId: output.id, state: 'unset' }), 'tiny'));
  }
  return wrap;
}
async function openFile() {
  const ensureCurrent = captureWorkspace();
  if (dirty() && !confirm('未保存の変更があります。別のJSONを読み込みますか？（現在の内容は保存されません）')) return;
  if (picker.showOpenFilePicker) {
    const [handle] = await picker.showOpenFilePicker({ types: [{ description: '決定表 JSON', accept: { 'application/json': ['.json'] } }] });
    ensureCurrent(); const connection = await FileCoordinator.connect(handle); ensureCurrent(); session = connection.session; table = connection.table; saved = stable(table); pending = null; pollErrors = 0; fileMessage = `連携中：${handle.name}`; page = 0; commit(table, 'JSONを検証して読み込みました。選択したファイルを継続確認します。');
  } else {
    const i = input('', 'file'); i.accept = '.json,application/json'; i.onchange = () => void run(() => fileTask(async () => { const f = i.files?.[0]; if (!f) return; ensureCurrent(); const next = decode(await f.text()); ensureCurrent(); session = null; table = next; saved = stable(table); fileMessage = '明示読込のみ・継続確認なし'; commit(next, 'JSONを読み込みました。この環境のファイル選択方式では継続確認できません。'); })); i.click();
  }
}
async function saveAs() {
  const ensureCurrent = captureWorkspace();
  const text = encode(table), snapshot = clone(table);
  if (!picker.showSaveFilePicker) { download(text, 'decision-table.json'); message('JSONの書出を開始しました。ブラウザで保存完了を確認してください。元ファイルの保存完了は確認できません。'); return; }
  const h = await picker.showSaveFilePicker({ suggestedName: 'decision-table.json', types: [{ description: '決定表 JSON', accept: { 'application/json': ['.json'] } }] });
  ensureCurrent();
  if (session && h.isSameEntry && await h.isSameEntry(session.handle)) { await save(); return; }
  const before = await (await h.getFile()).text(); ensureCurrent();
  if (before && !confirm('既存のファイルです。外部ツールの編集を停止し、上書きしてよいことを確認してください。')) return;
  await writeVerified(h, before, text); ensureCurrent(); session = new FileCoordinator(h, text); saved = stable(snapshot); pending = null; pollErrors = 0; fileMessage = `連携中：${h.name}`; render(); message('JSONを保存し、再読込で一致を確認しました。');
}
async function save() {
  const ensureCurrent = captureWorkspace();
  if (!session) return saveAs();
  if (!confirm('同じファイルを編集している外部ツールを停止してください。ブラウザだけで外部同時書込の排他は保証できません。停止を確認して保存しますか？')) return;
  await session.save(table); ensureCurrent(); pending = null; render(); message('保存後の再読込が一致しました。');
}
async function poll(force = false) {
  if (!session || polling || (pollErrors >= 3 && !force)) return;
  if (document.hidden && !force) { fileMessage = '検知休止中（復帰後に再確認）'; updateStatus(); return; }
  polling = true;
  const activeSession = session;
  try {
    const observation = await activeSession.check(table);
    if (session !== activeSession) return;
    if (observation.kind === 'external' || observation.kind === 'conflict') observation.kind = stable(table) === activeSession.baseModel ? 'external' : 'conflict';
    pending = observation.kind === 'external' || observation.kind === 'conflict' ? observation : null; pollErrors = 0;
    fileMessage = pending ? pending.kind === 'conflict' ? '競合：ブラウザと外部ファイルの双方が変更されています' : '外部変更：取込確認が必要です' : `連携中：${session.handle.name} / 最終確認 ${new Date(session.checkedAt).toLocaleTimeString()}`;
  } catch (e) { if (session !== activeSession) return; pollErrors++; fileMessage = `連携${pollErrors >= 3 ? '停止' : '確認失敗'}：${(e as Error).message}。権限・ファイル選択・外部ツールの状態を確認してください`; }
  finally { polling = false; updateStatus(); }
}
function updateStatus() {
  $('table-state').textContent = dirty() ? '● 未保存の変更' : '✓ 変更なし'; $('file-state').textContent = fileMessage; $('status').textContent = status;
  const key = stable({ raw: pending?.raw ?? '', kind: pending?.kind ?? '', dirty: dirty(), file: session?.handle.name ?? '' });
  if (key === externalUIKey) return;
  externalUIKey = key;
  const actions = $('external-actions'); actions.replaceChildren();
  if (pending && session) {
    const observation = pending, linkedSession = session; actions.append(element('p', pending.kind === 'conflict' ? '両方の変更を保持しています。現在の内容を別名保存するか、外部版を確認して取り込んでください。' : '外部JSONが変更されています。自動置換はしていません。'));
    actions.append(button('外部版を確認して取り込む', async () => {
      const m = modal('外部版を確認'), pre = element('pre', JSON.stringify(observation.external, null, 2)); m.form.append(element('p', dirty() ? '取り込むと現在の未保存内容を置き換えます。必要なら先に別名保存してください。' : 'この検証済み外部版を取り込みます。'), pre, button('キャンセル', m.close), button('この外部版で置換', () => fileTask(async () => { const ensureCurrent = captureWorkspace(); if (session !== linkedSession) throw new Error('連携先が変更されました'); const next = await linkedSession.accept(observation.raw); ensureCurrent(); if (session !== linkedSession) throw new Error('連携先が変更されました'); pending = null; commit(next, '外部版を再確認して取り込みました'); m.close(); }), 'primary'));
    }), button('現在の内容を別名保存', () => fileTask(saveAs)));
  }
}
function renderPanel() {
  const host = $('side-panel'); host.replaceChildren(); host.hidden = panel === 'none'; if (panel === 'none') return;
  const head = element('div', '', 'panel-heading'); head.append(element('h2', panel === 'diagnostics' ? '表の検証' : panel === 'merge' ? '同じ結果をまとめる' : '元の組み合わせへ展開'), button('閉じる', () => { panel = 'none'; renderPanel(); })); host.append(head);
  if (panel === 'diagnostics') {
    const ds = diagnose(table); host.append(element('p', ds.length ? `${ds.length}件の診断があります。` : '定義した値域で問題は見つかりませんでした。業務上の正しさを保証する判定ではありません。'));
    ds.forEach(d => { const row = element('div', '', `diagnostic ${d.level}`); row.append(element('strong', d.target), element('span', d.message)); host.append(row); });
  } else if (panel === 'merge') {
    host.append(element('p', '条件の集合・値・順序・適用回数の等価性を全区分で確認できた候補だけを表示します。承認前は正本を変更しません。'));
    if (!candidates.length) host.append(element('p', '承認可能な候補はありません。未設定の結果、多重適合の回数・順序、計算予算も確認してください。', 'muted'));
    candidates.forEach(c => { const row = element('div', '', 'candidate'); row.append(element('strong', `${c.before.length}規則 → 1規則`), element('span', `${c.checked}組み合わせで等価性確認 / OR条件 ${c.replacement.anyOf.length}件`), button('対象条件を確認', () => { const m = modal('統合する条件と結果'); m.form.append(element('pre', JSON.stringify({ sourceRules: c.before, proposed: c.replacement }, null, 2)), button('閉じる', m.close)); }), button('承認してまとめる', () => { commit(applyCandidate(table, c), '承認した候補を反映しました。他の候補は表の変更で失効します。'); panel = 'merge'; renderPanel(); }, 'primary')); host.append(row); });
  } else {
    const cells = atoms(table), pre = element('pre');
    if (cells.length > 1000) { host.append(element('p', '展開表示は先頭1,000件です。元データは切り捨てていません。')); }
    pre.textContent = expandRows(table, 1000).map((row, i) => { const conditions = table.conditions.map(c => `${c.name}=${c.partitions.find(p => p.id === row.atom[c.id])?.label}`).join(' / '); const effects = row.matches.map((match, order) => `${order + 1}. 規則 ${match.ruleId}: ${match.directives.map(d => `${table.outputs.find(o => o.id === d.outputId)?.name}=${d.state === 'unset' ? '未設定' : JSON.stringify(d.value)}`).join(', ')}`).join('\n    '); return `${i + 1}. ${conditions}\n    ${effects || '適合する規則なし'}`; }).join('\n\n'); host.append(pre);
  }
}
function render() {
  const title = $('title') as HTMLInputElement; title.value = table.title; title.onchange = () => void run(() => commit({ ...table, title: title.value }));
  $('file-actions').replaceChildren(button('＋ 新しい表', clearWorkspace), button('JSONを開く', () => fileTask(openFile)), button('保存', () => fileTask(save)), button('別名で保存', () => fileTask(saveAs)), button('サンプルを開く', loadDemo, 'sample-button'));
  $('edit-actions').replaceChildren(button('＋ 条件', () => conditionDialog()), button('＋ 動作・結果', () => outputDialog()), button('組み合わせを生成', () => {
    const n = count(table); if (n > 1000n && !confirm(`${n}組み合わせを生成します。続けますか？`)) return;
    if (table.rules.length) { applyDefinitions({ ...clone(table), rules: [] }, () => {}); return; }
    commit(generate(table), '条件の組み合わせを生成しました。各規則の結果を入力してください。');
  }, 'primary'), button('検証', () => { panel = 'diagnostics'; renderPanel(); }), button('まとめる', async () => { message('同じ結果の候補と等価性を確認しています…'); await new Promise(r => setTimeout(r, 0)); candidates = proposeMerges(table); panel = 'merge'; renderPanel(); message(`${candidates.length}件の承認可能な統合候補があります`); }), button('展開表示', () => { panel = 'expand'; renderPanel(); }));
  const counts = $('counts'); counts.replaceChildren();
  for (const [value, label] of [[String(count(table)), '元の組み合わせ'], [String(table.rules.length), '現在の規則']] as [string, string][]) { const item = element('div'); item.append(element('strong', value), element('span', label)); counts.append(item); }
  const pattern = element('div'); let patterns = '—'; try { if (table.rules.length) patterns = String(patternCount(table)); } catch { patterns = '未算出'; } pattern.append(element('strong', patterns), element('span', '結果パターン')); counts.append(pattern);
  const defs = $('definition-list'); defs.replaceChildren();
  for (const c of table.conditions) { const chip = element('div', '', 'definition-chip'); chip.append(button(`${c.name} · ${c.partitions.length}区分`, () => conditionDialog(c)), button('×', () => { const next = clone(table); next.conditions = next.conditions.filter(x => x.id !== c.id); if (!next.conditions.length && table.rules.length) { if (!confirm('最後の条件を削除すると規則を保持できません。先にJSONを保存してください。規則も削除しますか？')) return; commit({ ...next, rules: [] }); } else applyDefinitions(next, () => {}); }, 'tiny')); defs.append(chip); }
  for (const o of table.outputs) { const chip = element('div', '', 'definition-chip output-chip'); chip.append(button(`${o.name} · ${o.kind === 'action' ? '動作' : o.type}`, () => outputDialog(o)), button('×', () => { if (!confirm(`出力「${o.name}」と入力済みの値を削除しますか？`)) return; const next = clone(table); next.outputs = next.outputs.filter(x => x.id !== o.id); next.rules.forEach(r => { r.directives = r.directives.filter(d => d.outputId !== o.id); }); commit(next); }, 'tiny')); defs.append(chip); }
  const wrap = $('table-wrap'); wrap.replaceChildren();
  if (!table.rules.length) {
    const blank = element('div', '', 'empty-state'); blank.append(element('div', '⊞', 'empty-icon'), element('h2', '最初のルールをつくりましょう'), element('p', '条件と結果を定義して、組み合わせを生成します。\nサンプルなら、編集から統合までひと通り試せます。'), button('サンプルで試す →', loadDemo, 'primary')); wrap.append(blank);
  } else {
    const grid = element('table', '', 'decision-table'), thead = element('thead'), hr = element('tr'); hr.append(element('th', '#')); table.conditions.forEach(c => hr.append(element('th', c.name))); table.outputs.forEach(o => hr.append(element('th', o.name, 'output-heading'))); hr.append(element('th', '順序')); thead.append(hr); grid.append(thead);
    const body = element('tbody');
    table.rules.slice(page * 40, page * 40 + 40).forEach((r, offset) => {
      const index = page * 40 + offset, tr = element('tr'); tr.id = `row-${r.id}`; const indexCell = element('td'); indexCell.append(element('strong', String(index + 1)), element('small', r.anyOf.length > 1 ? `OR ${r.anyOf.length}` : 'RULE')); tr.append(indexCell);
      for (const c of table.conditions) {
        const td = element('td'); const descriptions = r.anyOf.map(clause => { const ids = clause.selections.find(s => s.conditionId === c.id)!.partitionIds; return ids.length === c.partitions.length ? 'すべて' : ids.map(id => c.partitions.find(p => p.id === id)!.label).join(' / '); });
        td.append(button([...new Set(descriptions)].join(' または '), () => ruleConditions(r.id), 'cell-button')); if (r.anyOf.length > 1) td.append(element('small', 'ORの組合せはクリックで確認')); tr.append(td);
      }
      table.outputs.forEach((o, i) => { const td = element('td', '', 'output-cell'); td.append(outputControl(r.id, o, r.directives[i])); tr.append(td); });
      const controls = element('td', '', 'row-actions');
      const up = button('↑', () => { if (!index) return; const next = clone(table); [next.rules[index - 1], next.rules[index]] = [next.rules[index], next.rules[index - 1]]; commit(next); }, 'tiny'); up.disabled = index === 0; up.title = '規則を上へ';
      const down = button('↓', () => { if (index >= table.rules.length - 1) return; const next = clone(table); [next.rules[index + 1], next.rules[index]] = [next.rules[index], next.rules[index + 1]]; commit(next); }, 'tiny'); down.disabled = index === table.rules.length - 1; down.title = '規則を下へ';
      controls.append(up, down, button('×', () => { if (!confirm('この規則を削除しますか？')) return; const next = clone(table); next.rules.splice(index, 1); commit(next); }, 'tiny')); tr.append(controls); body.append(tr);
    }); grid.append(body); wrap.append(grid);
  }
  const pages = $('pagination'); pages.replaceChildren();
  if (table.rules.length > 40) { const prev = button('← 前へ', () => { page--; render(); }); prev.disabled = page === 0; const next = button('次へ →', () => { page++; render(); }); next.disabled = (page + 1) * 40 >= table.rules.length; pages.append(prev, element('span', `${page + 1} / ${Math.ceil(table.rules.length / 40)}ページ · 1ページ40規則`), next); }
  $('help-actions').replaceChildren(button('対応JSON Schemaを書出', () => download(JSON.stringify(documentSchema, null, 2), 'decision-table.schema.json')), button('外部ファイルを再確認', () => poll(true)), button('現在のJSONを確認', () => { const m = modal('現在のJSON'); m.form.append(element('pre', encode(table)), button('閉じる', m.close)); }));
  updateStatus(); renderPanel();
}
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(true); else { fileMessage = session ? '検知休止中（復帰後に再確認）' : fileMessage; updateStatus(); } });
setInterval(() => void poll(), 1000);
render();
