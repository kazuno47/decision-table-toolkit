// TASK-001..012 / SCR-001..005. Wording follows JIS X 0125 where the standard has a term / REQ-001..018. All user content uses textContent.
import { emptyTable, uid, clone, stable, decode, encode, validate, assertValid, count, generate, diagnose, proposeMerges, applyCandidate, regeneratePreserving, expandRows, addRule, migrateRules, inspect, compressAll, choiceLines, parseChoiceLines, retainPartitions, carryDirective, contradictions, decisionTables, coverage, LIMIT, type Scalar, type Pattern, type Chunk, type Rule, type DecisionPart, type Table, type Condition, type Output, type Partition, type Clause, type Candidate, type Directive, type DataType } from './core.ts';
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
// TASK-010 (INS-009): the single-hit decision table is its own section. It is derived from the rules and cached per
// table state; when one calculation is slow, later ones wait for the user to ask (never saved).
type Completeness = { complete: boolean; uncovered: bigint };
let decisionCache: { key: string; combined: boolean; parts: DecisionPart[]; cov: Completeness } | null = null, decisionAuto = true, pickedColumn = '';
function singleHit(force = false): { combined: boolean; parts: DecisionPart[]; cov: Completeness } | null {
  const key = stable(table); if (decisionCache?.key === key) return decisionCache;
  if (!decisionAuto && !force) return null;
  const started = Date.now(); let found: { combined: boolean; parts: DecisionPart[] } = { combined: true, parts: [] }; try { found = decisionTables(table); } catch { /* shown as not computable */ }
  decisionAuto = Date.now() - started < 700;
  // Completeness is shown here only when it is cheap to determine; the full check stays in 検証.
  let cov: Completeness = { complete: false, uncovered: 0n }; try { cov = coverage(table, 200_000, 250_000); } catch { /* shown as not determined */ }
  decisionCache = { key, ...found, cov }; return decisionCache;
}
// TASK-010: a rule is written as the condition entries it specifies only; conditions it does not mention are irrelevant ("−").
function ruleText(r: Pick<Rule, 'anyOf'>): string {
  const order = (id: string) => table.conditions.findIndex(c => c.id === id);
  return r.anyOf.map(clause => clause.selections.length ? [...clause.selections].sort((a, b) => order(a.conditionId) - order(b.conditionId)).map(sel => {
    const c = table.conditions.find(x => x.id === sel.conditionId)!;
    return `${c.name}＝${sel.partitionIds.length === c.partitions.length && sel.partitionIds.length > 1 ? `全${sel.partitionIds.length}値` : sel.partitionIds.map(id => c.partitions.find(x => x.id === id)!.label).join('・')}`;
  }).join(' かつ ') : 'すべての組合せ（条件指定なし）').join(' ／ または ');
}
// TASK-003: result of applying every candidate repeatedly. Recomputed, never saved.
let compressed: { table: Table; steps: number; base: string } | null = null;
// INS-002 / CHG-004: partitions chosen in the "決定表の解釈" section; view state only, never saved.
let checkPicks: Record<string, string> = {};
let pending: Observation | null = null, fileMessage = 'ファイル未連携', status = '新しい表を作成するか、サンプルを試してください。';
const root = document.getElementById('app')!;
root.innerHTML = `<aside class="rail"><div class="brand-mark">dt<span>∴</span></div><div class="rail-line"></div><span class="vertical">CONDITIONS INTO CLARITY</span><span class="rail-version">v0.3.1</span></aside><main><header><div><p class="eyebrow">DECISION TABLE TOOLKIT</p><h1>条件を整理。<span>判断を明確に。</span></h1><p class="intro">条件と動作をひとつの表に。オフラインで編集・検証・共有できます。</p></div><div class="header-meta"><span class="dot"></span> LOCAL & OFFLINE<br><small>Chrome / JSON schema 1.0・1.1</small></div></header><nav id="file-actions" aria-label="ファイル操作"></nav><section class="workspace"><div class="workspace-top"><div><label class="title-label" for="title">規則の記述 ／ 表見出し</label><input id="title" aria-label="表見出し" maxlength="256"></div><div id="counts" class="stats"></div></div><div class="toolbar"><div id="edit-actions"></div><div id="table-state"></div></div><div class="notice">この表は、複数の規則が同じ条件の組合せで満足される書き方（多重適合）ができます。規則には、関係する条件と、実行する動作（「X」または値）だけを書きます。満足された規則の動作指定を動作ごとに合わせて解釈します。JIS X 0125 が定める決定表は単適合（条件の組合せごとに満足される規則が1つ）で、この下は規則を1行ずつ並べたリストで、規則には関係する条件と実行する動作だけを書きます。規格の形の決定表は、その下の「決定表（単適合）」に別表として表示します。同じ動作に異なる値を指定する規則が同時に満足される場合は「検証」で指摘します。規則の順番は意味をもちません。業務処理は実行しません。JIS完全準拠を保証しません。</div><div id="definition-list"></div><div id="table-wrap"></div><div id="pagination"></div></section><section id="side-panel" class="side-panel" hidden></section><section id="decision" class="check-panel" hidden></section><section id="check" class="check-panel" hidden></section><footer><div id="status" role="status" aria-live="polite"></div><div id="file-state"></div></footer><section id="external-actions"></section><details class="help"><summary>使い方と保存・ファイル連携について</summary><ol><li>条件と、条件のとり得る値を定義します。動作を定義します（X／−で指定する制限指定、または語句・値で指定する拡張指定）。</li><li>「＋ 規則」で規則を1つずつ書きます。条件指定は、関係する条件だけ値を選びます。動作指定は、その規則で実行する動作にだけ「X」または値を入れます。書かなかった条件と動作は、決定表では「−」になります。条件の値が少ない表は、条件指定の全組合せの規則を作成することもできます。</li><li>「検証」で、完備性（条件指定のすべての組合せに満足される規則があるか）と、動作指定の不一致を確認します。</li><li>表の下の「決定表の解釈」で条件の値を選ぶと、実行される動作を確認できます。その上の「決定表（単適合）」は、規則の記述から求めた単適合決定表です（条件・動作が行、規則が列）。規則番号を押すと、その条件指定が「決定表の解釈」に入ります。</li><li>「簡単化」で、動作指定が同じ規則を結合し、すべての値がそろった条件を条件指定から外して整理します。等価性を確認できた候補だけを表示し、承認して反映します。</li><li>JSONで保存・共有します。Chromeで選択したファイルは1秒を目安に再確認します。</li></ol><p>外部ツールと同じファイルへ同時に保存しないでください。ブラウザだけでOS全体の排他は保証できません。保存前に他ツールの編集を停止するか、別名へ書き出してください。バックグラウンド中は検知が遅れます。権限やAPIによって利用できない機能があります。ファイル選択・ダウンロードだけの利用では継続確認はできません。未保存内容はページを閉じると失われます。</p><div id="help-actions"></div></details></main>`;
const $ = (id: string) => document.getElementById(id)!;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; }
function button(text: string, action: () => unknown, cls = ''): HTMLButtonElement { const b = element('button', text, cls); b.type = 'button'; b.addEventListener('click', () => void run(action)); return b; }
function message(s: string) { status = s; $('status').textContent = s; }
async function run(action: () => unknown) { try { await action(); } catch (e) { if ((e as Error).name !== 'AbortError') message(`確認が必要です：${(e as Error).message}`); } }
const dirty = () => stable(table) !== (session?.baseModel ?? saved);
function commit(next: Table, note = '変更を反映しました') { assertValid(next); workspaceRevision++; table = next; candidates = []; compressed = null; pending = null; page = Math.min(page, Math.max(0, Math.ceil(table.rules.length / 40) - 1)); message(note); render(); }
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
function loadDemo() { if (dirty() && !confirm('現在の変更を破棄してサンプルを開きますか？')) return; session = null; fileMessage = 'ファイル未連携'; page = 0; commit(demo(), '条件指定の全組合せ6件を規則にしたサンプルです。「簡単化」を試せます。'); }
function modal(title: string) { const d = element('dialog'); const form = element('div', '', 'modal-content'); form.append(element('h2', title)); d.append(form); document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal(); return { dialog: d, form, close: () => d.close() }; }
function field(label: string, control: HTMLElement, target: HTMLElement) { const wrap = element('label', '', 'field'); wrap.append(element('span', label), control); target.append(wrap); return wrap; }
function input(value = '', type = 'text') { const i = element('input'); i.type = type; i.value = value; return i; }
function select(values: [string, string][], value?: string) { const s = element('select'); for (const [v, label] of values) { const o = element('option', label); o.value = v; s.append(o); } if (value !== undefined) s.value = value; return s; }
const types: [string, string][] = [['boolean', 'Boolean / 真偽'], ['enum', 'Enum / 分類'], ['number', 'Number / 数値'], ['string', 'String / 文字列'], ['date', 'Date / 日付']];
function applyDefinitions(next: Table, close: () => void) {
  assertValid({ ...next, rules: [] });
  if (!table.rules.length) { commit({ ...next, rules: [] }); close(); return; }
  // TASK-002 / REQ-013 / SCR-005: written rules are carried over; nothing changes before the user chooses.
  const migrated = migrateRules(table, { ...next, rules: [] }), affected = migrated.dropped + migrated.widened + migrated.narrowed;
  if (!affected) { commit(migrated.table, '条件の変更を反映しました。規則はすべて保持しています。「検証」で完備性を確認してください。'); close(); return; }
  const m = modal('条件変更の影響を確認');
  m.form.append(element('p', `規則${table.rules.length}件のうち、そのまま保持できないものがあります。削除される規則：${migrated.dropped}件／条件指定のあった条件がなくなり対象が広がる規則：${migrated.widened}件／条件指定の値の一部がなくなる規則：${migrated.narrowed}件。変更前の表は選択が完了するまで保持します。`));
  const actions = element('div', '', 'modal-actions');
  actions.append(button('キャンセル', m.close), button('規則を保持して反映', () => { commit(migrated.table, '条件の変更を反映しました。「検証」で完備性と動作指定の不一致を確認してください。'); m.close(); close(); }, 'primary'));
  if (count(next) <= BigInt(LIMIT)) actions.append(button('変更前JSONを書出後、全組合せの規則を作り直す', () => { download(encode(table), 'decision-table-before-change.json'); commit(generate({ ...next, rules: [] }), '変更前JSONの書出を開始し、全組合せの規則を作り直しました。ダウンロード完了はブラウザで確認してください。'); m.close(); close(); }));
  m.form.append(actions);
}
// REQ-004: full generation stays available for small tables; existing results are carried per combination.
function regenerateDialog() {
  const migrated = regeneratePreserving(table, { ...clone(table), rules: [] }), m = modal('全組合せの規則を作り直す');
  m.form.append(element('p', `現在の規則${table.rules.length}件を、条件指定の全組合せ${count(table)}件それぞれの規則に作り直します。動作指定を引き継げない組合せ：${migrated.affected}件。条件を省いた規則やORで結合した規則の形は失われます。`));
  const actions = element('div', '', 'modal-actions');
  actions.append(button('キャンセル', m.close), button('作り直す', () => { commit(migrated.table, '条件指定の全組合せの規則を作り直しました。'); m.close(); }, 'primary')); m.form.append(actions);
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
    field('値の名前', label, wrap); field('下限（空欄＝なし）', low, wrap); field('下限を含む', li, wrap); field('上限（空欄＝なし）', high, wrap); field('上限を含む', hi, wrap);
    wrap.append(button('値を削除', () => { rangeRows.splice(rangeRows.indexOf(row), 1); wrap.remove(); })); rows.append(wrap);
  }
  function redraw() {
    defs.replaceChildren(); rangeRows.length = 0;
    if (type.value === 'boolean') defs.append(element('p', 'true / false の2つの値を定義します。'));
    else if (type.value === 'enum' || type.value === 'string') {
      choices = element('textarea'); choices.rows = 5; choices.placeholder = '優良\n一般\n新規';
      choices.value = original ? choiceLines(original) : '';
      field('候補値（1行1値。空文字は ""、空白を保つ値は引用符で指定。複数の候補を1つの値にまとめる場合は ["A","B"] と書く）', choices, defs);
    } else {
      rows = element('div'); defs.append(element('p', '数値は10進数、日付はYYYY-MM-DDで指定。区間の重複・逆転・空区間は拒否します。'), rows, button('＋ 範囲を追加', () => addRange()));
      const existing = original?.type === type.value ? original.partitions.filter((p): p is Extract<Partition, { kind: 'range' }> => p.kind === 'range') : [];
      if (existing.length) existing.forEach(p => addRange(p)); else addRange();
    }
    field('未定義を条件の値として追加', missing, defs);
  }
  type.onchange = redraw; redraw();
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button('定義を反映', () => {
    if (!name.value.trim()) throw new Error('条件名を入力してください');
    let partitions: Partition[];
    if (type.value === 'boolean') partitions = [true, false].map(v => ({ id: uid('p'), label: String(v), kind: 'values', values: [v] }));
    else if (type.value === 'enum' || type.value === 'string') partitions = parseChoiceLines(choices.value).map(x => ({ id: uid('p'), label: x.label, kind: 'values', values: x.values }));
    else partitions = rangeRows.map(r => ({ id: uid('p'), label: r.label.value || `${r.li.checked ? '[' : '('}${r.low.value || '−∞'}, ${r.high.value || '∞'}${r.hi.checked ? ']' : ')'}`, kind: 'range', range: { lower: r.low.value || null, upper: r.high.value || null, lowerInclusive: r.li.checked, upperInclusive: r.hi.checked } }));
    if (missing.checked) partitions.push({ id: uid('p'), label: '未定義', kind: 'missing' });
    // DEF-009: unchanged entries keep their id and label, so rules that refer to them are kept.
    if (original) partitions = retainPartitions(original, partitions);
    const c: Condition = { id: original?.id ?? uid('c'), name: name.value, type: type.value as DataType, partitions }, next = clone(table);
    if (original) next.conditions[next.conditions.findIndex(c => c.id === original.id)] = c; else next.conditions.push(c);
    applyDefinitions(next, m.close);
  }, 'primary')); m.form.append(actions);
}
function outputDialog(original?: Output) {
  const m = modal(original ? '動作を編集' : '動作を追加'), name = input(original?.name ?? ''), kind = select([['result', '拡張指定（語句・値で指定する）'], ['action', '制限指定（X／−：実行する・しない）']], original?.kind ?? 'result'), type = select(types, original?.kind === 'result' ? original.type : 'boolean'), choices = element('textarea');
  choices.value = original?.kind === 'result' ? (original.values ?? []).join('\n') : ''; choices.placeholder = '1行に1候補';
  field('名前', name, m.form); field('動作指定の形式', kind, m.form); const typeField = field('値の型', type, m.form), enumField = field('Enumの候補値', choices, m.form);
  function redraw() { typeField.hidden = kind.value === 'action'; enumField.hidden = kind.value === 'action' || type.value !== 'enum'; } kind.onchange = type.onchange = redraw; redraw();
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button('定義を反映', () => {
    if (!name.value.trim()) throw new Error('名前を入力してください');
    const o: Output = kind.value === 'action' ? { id: original?.id ?? uid('o'), name: name.value, kind: 'action' } : { id: original?.id ?? uid('o'), name: name.value, kind: 'result', type: type.value as DataType, ...(type.value === 'enum' ? { values: choices.value.split(/\r?\n/).filter(Boolean) } : {}) };
    const next = clone(table); if (original) next.outputs[next.outputs.findIndex(x => x.id === original.id)] = o; else next.outputs.push(o);
    // Output-only changes preserve rule order, OR clauses and matching multiplicity.
    // DEF-012: every action entry that is still valid under the new definition is kept; the rest are counted and confirmed.
    let lost = 0;
    next.rules.forEach(r => { r.directives = next.outputs.map(output => { const d = r.directives.find(d => d.outputId === output.id), kept = carryDirective(table.outputs.find(x => x.id === output.id), output, d); if (d?.state === 'set' && kept.state === 'unset') lost++; return kept; }); });
    assertValid(next);
    if (lost && !confirm(`形式・型・候補の変更により、動作指定${lost}件が保持できず空欄に戻ります。変更を反映しますか？`)) return;
    commit(next); m.close();
  }, 'primary')); m.form.append(actions);
}
// TASK-011 (INS-011): rules are a plain list, one line each: "conditions → actions", showing only what the rule specifies.
function actionText(r: Pick<Rule, 'directives'>): string {
  const parts = table.outputs.flatMap((o, i) => { const d = r.directives[i]; if (!d || d.state !== 'set') return []; if (o.kind === 'action') return d.value === true ? [`${o.name}＝X`] : []; return [`${o.name}＝${d.value === '' ? '（空文字）' : String(d.value)}`]; });
  return parts.length ? parts.join('、') : '（動作指定なし）';
}
function ruleDialog(id: string | null) {
  const original = id ? table.rules.find(r => r.id === id)! : null, m = modal(original ? `規則 #${table.rules.indexOf(original) + 1} を編集` : '規則を追加'), list = element('div');
  m.form.append(element('h3', '条件指定'), element('p', 'この規則に関係する条件だけ、値を選んでください。「指定しない」の条件は、この規則には無関係です。ブロック内の条件指定はAND、ブロック同士はORです。', 'muted'), list);
  const clauses: { rows: { all: HTMLInputElement; pick: HTMLSelectElement }[]; element: HTMLElement }[] = [];
  function add(c?: Clause) {
    const block = element('div', '', 'clause'), rows: { all: HTMLInputElement; pick: HTMLSelectElement }[] = []; list.append(block);
    for (const condition of table.conditions) {
      // DAT-004: no selection for a condition means it is irrelevant to the rule; an explicit list is kept as written.
      const chosen = c?.selections.find(x => x.conditionId === condition.id)?.partitionIds, all = input('', 'checkbox'), line = element('div', '', 'condition-pick');
      const pick = select(condition.partitions.map(p => [p.id, p.label])); pick.multiple = true; pick.size = Math.min(4, condition.partitions.length);
      Array.from(pick.options).forEach(o => { o.selected = chosen ? chosen.includes(o.value) : false; });
      all.checked = !chosen; pick.disabled = all.checked; all.onchange = () => { pick.disabled = all.checked; };
      pick.setAttribute('aria-label', `${condition.name}の値`);
      line.append(element('strong', condition.name)); field('指定しない', all, line); line.append(pick); block.append(line); rows.push({ all, pick });
    }
    const entry = { rows, element: block }; clauses.push(entry); block.append(button('このORブロックを削除', () => { clauses.splice(clauses.indexOf(entry), 1); block.remove(); }));
  }
  (original?.anyOf ?? [{ selections: [] }]).forEach(add); m.form.append(button('＋ ORブロック', () => add()));
  // actions: only the ones this rule executes get X or a value; blank = not specified by this rule
  const actionsBox = element('div', '', 'clause');
  m.form.append(element('h3', '動作指定'), element('p', 'この規則で実行する動作にだけ「X」または値を入れてください。空欄の動作は、この規則では指定しません。', 'muted'), actionsBox);
  const editors = table.outputs.map((o, at): (() => Directive) => {
    const d: Directive = original?.directives[at] ?? { outputId: o.id, state: 'unset' }, unset = (): Directive => ({ outputId: o.id, state: 'unset' });
    if (o.kind === 'action') { const sel = select([['unset', ''], ['true', 'X']], d.state === 'set' && d.value === true ? 'true' : 'unset'); field(o.name, sel, actionsBox); return () => sel.value === 'true' ? { outputId: o.id, state: 'set', value: true } : unset(); }
    if (o.type === 'boolean') { const sel = select([['unset', ''], ['true', 'true'], ['false', 'false']], d.state === 'unset' ? 'unset' : String(d.value)); field(o.name, sel, actionsBox); return () => sel.value === 'unset' ? unset() : { outputId: o.id, state: 'set', value: sel.value === 'true' }; }
    if (o.type === 'enum') { const sel = select([['unset', ''], ...(o.values ?? []).map((v, i): [string, string] => [String(i), v === '' ? '（空文字）' : v])], d.state === 'unset' ? 'unset' : String((o.values ?? []).indexOf(d.value as string))); field(o.name, sel, actionsBox); return () => sel.value === 'unset' ? unset() : { outputId: o.id, state: 'set', value: o.values![Number(sel.value)] }; }
    const text = input(d.state === 'set' ? String(d.value) : ''), empty = input('', 'checkbox'); empty.checked = d.state === 'set' && d.value === '';
    field(o.name, text, actionsBox); if (o.type === 'string') field(`${o.name}：空文字を値として指定する`, empty, actionsBox);
    return () => text.value !== '' ? { outputId: o.id, state: 'set', value: text.value } : o.type === 'string' && empty.checked ? { outputId: o.id, state: 'set', value: '' } : unset();
  });
  if (!table.outputs.length) actionsBox.append(element('p', '動作がまだ定義されていません。「＋ 動作」で追加できます。', 'muted'));
  const actions = element('div', '', 'modal-actions'); actions.append(button('キャンセル', m.close), button(original ? '規則を反映' : '規則を追加', () => {
    if (!clauses.length) throw new Error('条件ブロックを1つ以上残してください');
    let omitted = false;
    const anyOf: Clause[] = clauses.map(c => ({ selections: table.conditions.flatMap((x, i) => {
      if (c.rows[i].all.checked) { omitted = true; return []; }
      const ids = Array.from(c.rows[i].pick.selectedOptions).map(o => o.value); if (!ids.length) throw new Error(`「${x.name}」の値を1つ以上選ぶか、「指定しない」にしてください`);
      return [{ conditionId: x.id, partitionIds: ids }];
    }) }));
    const directives = editors.map(read => read()), next = clone(table);
    if (original) { const r = next.rules.find(x => x.id === original.id)!; r.anyOf = anyOf; r.directives = directives; }
    else { next.rules.push({ id: uid('r'), anyOf, directives }); page = Math.floor((next.rules.length - 1) / 40); }
    if (omitted) next.schemaVersion = '1.1';
    commit(next, original ? '規則を反映しました。' : `規則を追加しました。${omitted && table.schemaVersion === '1.0' ? 'この表はスキーマ1.1として保存されます（1.0のみ対応の旧版では読み込めません）。' : ''}`); m.close();
  }, 'primary')); m.form.append(actions);
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
// TASK-002 / INS-002, CHG-004 / REQ-012 / SCR-001: choose partitions like a filter and show only the resulting outputs.
function renderCheck() {
  const host = $('check'); host.replaceChildren(); host.hidden = !table.rules.length || !table.conditions.length; if (host.hidden) return;
  for (const id of Object.keys(checkPicks)) if (!table.conditions.some(c => c.id === id && c.partitions.some(p => p.id === checkPicks[id]))) delete checkPicks[id];
  const head = element('div', '', 'panel-heading'); head.append(element('h2', '決定表の解釈'), button('指定を解除', () => { checkPicks = {}; pickedColumn = ''; renderDecision(); renderCheck(); })); host.append(head);
  host.append(element('p', '条件の値を選ぶと、その条件の組合せで満足される規則と、実行される動作を表示します。動作が決まるまで条件を選んでください。無関係な条件（−）は選ばなくても決まります。表は変更しません。', 'muted'));
  // TASK-006: mark the conditions that still have to be chosen before the result is determined.
  let needed: string[] = []; try { needed = inspect(table, checkPicks).relevant; } catch { /* reported below */ }
  const filters = element('div', '', 'lookup');
  for (const c of table.conditions) {
    const s = select([['', '指定なし'], ...c.partitions.map((p): [string, string] => [p.id, p.label])], checkPicks[c.id] ?? ''); s.setAttribute('aria-label', `${c.name}（解釈する値）`);
    s.onchange = () => { if (s.value) checkPicks[c.id] = s.value; else delete checkPicks[c.id]; pickedColumn = ''; renderDecision(); renderCheck(); }; field(needed.includes(c.id) ? `${c.name}（選ぶと絞り込めます）` : c.name, s, filters);
  }
  host.append(filters);
  try {
    const found = inspect(table, checkPicks), chosen = Object.keys(checkPicks).length;
    const value = (d: Directive) => { const o = table.outputs.find(o => o.id === d.outputId); if (o?.kind === 'action') return d.state === 'set' && d.value === true ? 'X（実行する）' : '−（実行しない）'; if (d.state === 'unset') return '−'; return d.value === '' ? '（空文字）' : String(d.value); };
    const outcome = (ds: Directive[]) => ds.length ? ds.map(d => `${table.outputs.find(o => o.id === d.outputId)?.name}：${value(d)}`).join(' ／ ') : '（動作が未定義）';
    // TASK-007 (INS-006): every output is decided on its own by the rules that set it; show one value per output.
    const numbers = (list: number[]) => `規則 ${list.slice(0, 12).map(i => `#${i + 1}`).join(' ')}${list.length > 12 ? ` ほか${list.length - 12}件` : ''}`;
    // TASK-005: show the conditions of the rules behind a value; a rule that names every partition applies to any choice.
    const why = (index: number) => `規則 #${index + 1}：${ruleText(table.rules[index])}`;
    const scope = `${chosen ? `${chosen}条件を指定` : '条件は未指定'}（対象は${found.total.toLocaleString('ja-JP')}組合せ）`;
    const names = table.conditions.filter(c => found.relevant.includes(c.id)).map(c => c.name), open = found.outputs.some(o => o.status === 'open');
    const headline = !found.rules.length ? 'この条件の組合せで満足される規則はありません（完備していません）。'
      : found.determined ? `実行される動作が決まりました。${found.exact ? '' : '選んでいない条件が何であっても、この動作です。'}`
      : found.conflict ? '同じ動作に異なる値を指定する規則が満足されており、決まらない動作があります（動作指定の不一致）。規則を直してください。'
      : open ? `まだ決まっていない動作があります。${names.length ? `次の条件を選ぶと絞り込めます：${names.join('、')}` : ''}`
      : '実行される動作が決まりました。';
    host.append(element('p', `${scope}：${headline}`, found.rules.length && !found.conflict ? 'check-summary' : 'check-empty'));
    if (found.rules.length) for (const o of found.outputs) {
      const name = table.outputs.find(x => x.id === o.outputId)!.name, row = element('div', '', `check-result ${o.status}`);
      if (o.status === 'determined') {
        row.append(element('strong', `${name}：${value(o.directive!)}`), element('small', numbers(o.rules))); host.append(row);
        o.rules.slice(0, 2).forEach(i => host.append(element('p', why(i), 'check-why'))); if (o.rules.length > 2) host.append(element('p', `ほか${o.rules.length - 2}件の規則も同じ値を指定しています。`, 'check-why'));
      } else if (o.status === 'conflict') { row.append(element('strong', `${name}：決まりません（動作指定の不一致）`), element('small', o.candidates.map(c => `${value(c.directive)}＝${numbers(c.rules)}`).join(' ／ '))); host.append(row); }
      else if (o.status === 'open') { row.append(element('strong', `${name}：まだ決まりません`), element('small', `あり得る値：${o.candidates.map(c => value(c.directive)).join(' ／ ')}`)); host.append(row); }
      else { row.append(element('strong', `${name}：−`), element('small', '満足される規則は、この動作を指定していません（実行しない）')); host.append(row); }
    }
    if (found.rules.length && !found.exact && found.uncovered !== null && found.uncovered > 0n) host.append(element('p', `この範囲のうち${found.uncovered.toLocaleString('ja-JP')}組合せには、満足される規則がありません（完備していません）。`, 'check-empty'));
  } catch (e) { host.append(element('p', `解釈を表示できません：${(e as Error).message}`, 'muted')); }
}
// TASK-003 / REQ-011 / SCR-004: candidates, the repeated result and the reasons are always computed from the current table.
function refreshMerge() {
  candidates = proposeMerges(table); const all = compressAll(table); compressed = { ...all, base: stable(table) };
}
// TASK-009, TASK-010, TASK-012 (INS-008, INS-009, INS-012): the decision table itself, in the general form of JIS X 0125
// figure 1 (conditions and actions in rows, one rule per column, single-hit). One table when it stays readable;
// otherwise separated by related actions as the standard recommends for large tables (Annex 1, 2).
// Pressing a rule number puts its condition entries into the interpretation section below.
function renderDecision(force = false) {
  const host = $('decision'); host.replaceChildren(); host.hidden = !table.rules.length || !table.conditions.length; if (host.hidden) return;
  const heading = element('div', '', 'panel-heading'); heading.append(element('h2', '決定表（単適合）')); host.append(heading);
  const hit = singleHit(force);
  if (!hit) { host.append(element('p', '表が大きいため、決定表は自動では更新していません。規則の記述を変えたら更新してください。', 'muted'), button('決定表を更新', () => { renderDecision(true); render(); }, 'primary')); return; }
  if (!hit.parts.length) { host.append(element('p', '動作を指定している規則がないため、決定表はありません。', 'muted')); return; }
  const cov = hit.cov, total = count(table);
  if (hit.combined) host.append(element('p', '上の規則の記述から求めた決定表です。条件と動作を行、規則を列に書いています。条件の組合せのどの1つも、ただ1つの規則（列）でだけ満足されます。規則番号を押すと、その条件指定を下の「決定表の解釈」に反映します。', 'muted'));
  else host.append(element('p', `条件指定の全組合せが${total.toLocaleString('ja-JP')}件あり、1つの決定表には書き切れないため、互いに関係しない動作ごとに${hit.parts.length}個の決定表に分離しています（JIS X 0125 附属書1「表の分離」）。各表には、その動作に関係する条件だけが並びます。どの表も、条件の組合せのどの1つも、ただ1つの規則（列）でだけ満足されます。規則番号を押すと、その条件指定を下の「決定表の解釈」に反映します。`, 'muted'));
  hit.parts.forEach((part, order) => drawDecision(host, part, hit.combined, order));
  host.append(element('p', !cov.complete ? '完備性は、この表では計算に時間がかかるため、ここには表示していません。「検証」で確認できます。' : cov.uncovered === 0n ? `完備性：条件指定の全組合せ${total.toLocaleString('ja-JP')}件のすべてに、満足される規則があります（完備しています）。` : `完備性：条件指定の全組合せ${total.toLocaleString('ja-JP')}件のうち${cov.uncovered.toLocaleString('ja-JP')}件には、満足される規則がありません（完備していません）。「検証」で範囲を確認できます。`, cov.complete && cov.uncovered === 0n ? 'check-summary' : cov.complete ? 'check-empty' : 'muted'));
}
function drawDecision(host: HTMLElement, part: DecisionPart, combined: boolean, order: number) {
  const sub = part.table, found = part.found, names = sub.outputs.map(o => o.name).join('・');
  if (!combined) host.append(element('h3', `決定表 ${order + 1}：${names}`));
  if (!found) { host.append(element('p', `「${names}」の決定表は、計算予算を超えたため表示できません。「簡単化」で規則を結合してから試してください。`, 'check-empty')); return; }
  if (!sub.conditions.length) { host.append(element('p', `「${names}」は、条件によらず指定されています（条件指定のない規則があります）。`, 'muted')); return; }
  const show = (v: Scalar, at: number) => sub.outputs[at].kind === 'action' ? (v ? 'X' : '−') : v === '' ? '（空文字）' : String(v);
  const columns = found.flatMap(x => x.chunks.map(chunk => ({ pattern: x, chunk }))), shown = columns.slice(0, 200);
  // In a separated table, a column where none of its rules is satisfied simply has "−" actions; only the combined table can show gaps.
  const gap = (col: { pattern: Pattern }) => combined && !col.pattern.satisfied;
  const keyOf = (chunk: Chunk) => `${order}:${stable(chunk.selections)}`, wrap = element('div', '', 'jis-wrap'), grid = element('table', '', 'jis-table'), head = element('tr'), thead = element('thead'), body = element('tbody');
  const mark = (col: { pattern: Pattern; chunk: Chunk }, extra = '') => `${gap(col) ? 'gap ' : ''}${keyOf(col.chunk) === pickedColumn ? 'picked ' : ''}${extra}`.trim();
  head.append(element('th', '規則'));
  shown.forEach((col, i) => {
    const th = element('th', '', mark(col)), pick = button(`${i + 1}${gap(col) ? ' *' : ''}`, () => {
      // one representative value per condition entry; "−" stays unspecified
      checkPicks = {}; for (const sel of col.chunk.selections) checkPicks[sel.conditionId] = sel.partitionIds[0];
      pickedColumn = keyOf(col.chunk); renderDecision(); renderCheck(); message(`決定表${combined ? '' : ` ${order + 1}`}の規則${i + 1}の条件指定を「決定表の解釈」に反映しました。`);
      const target = $('check') as HTMLElement & { scrollIntoView?: (o: unknown) => void }; target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 'column-button');
    pick.title = 'この規則の条件指定を「決定表の解釈」に反映'; th.append(pick); head.append(th);
  });
  thead.append(head); grid.append(thead);
  for (const c of sub.conditions) {
    const tr = element('tr'); tr.append(element('th', c.name));
    for (const col of shown) { const sel = col.chunk.selections.find(x => x.conditionId === c.id); tr.append(element('td', sel ? sel.partitionIds.map(id => c.partitions.find(x => x.id === id)!.label).join('・') : '−', mark(col))); }
    body.append(tr);
  }
  sub.outputs.forEach((o, at) => {
    const tr = element('tr', '', at === 0 ? 'divider' : ''); tr.append(element('th', o.name));
    for (const col of shown) { const values = col.pattern.outputs[at].values; tr.append(element('td', gap(col) ? '' : values.length === 0 ? '−' : values.length > 1 ? `不一致（${values.map(v => show(v, at)).join('／')}）` : show(values[0], at), mark(col, values.length > 1 ? 'clash' : ''))); }
    body.append(tr);
  });
  const sizes = element('tr', '', sub.outputs.length ? 'count' : 'count divider'); sizes.append(element('th', '規則数（組合せ数）')); shown.forEach(col => sizes.append(element('td', col.chunk.size.toLocaleString('ja-JP'), mark(col)))); body.append(sizes);
  grid.append(body); wrap.append(grid); host.append(wrap);
  const all = part.columns, sum = columns.reduce((n, c) => n + c.chunk.size, 0n);
  host.append(element('p', `規則${all}個。規則数の検査：各規則の組合せ数の合計は${sum.toLocaleString('ja-JP')}で、${combined ? '条件指定の全組合せ' : 'この表の条件の全組合せ'}${count(sub).toLocaleString('ja-JP')}件と${sum === count(sub) ? '一致します' : '一致しません'}。${all > shown.length ? `先頭${shown.length}規則を表示しています。` : ''}${combined && columns.some(c => !c.pattern.satisfied) ? '「*」の列は、満足される規則がない条件の組合せです。' : ''}`, 'muted'));
  if (found.some(x => x.outputs.some(o => o.values.length > 1))) host.append(element('p', '「不一致」の欄は、同じ動作に異なる値を指定する規則が同時に満足される組合せです。「検証」で規則を確認してください。', 'check-empty'));
}
function renderPanel() {
  const host = $('side-panel'); host.replaceChildren(); host.hidden = panel === 'none'; if (panel === 'none') return;
  const head = element('div', '', 'panel-heading'); head.append(element('h2', panel === 'diagnostics' ? '検証（完備性と動作指定）' : panel === 'merge' ? '表の簡単化（規則の結合）' : '条件指定の全組合せ'), button('閉じる', () => { panel = 'none'; renderPanel(); })); host.append(head);
  try {
  if (panel === 'diagnostics') {
    const ds = diagnose(table); host.append(element('p', ds.length ? `${ds.length}件の診断があります。` : '定義した値域で問題は見つかりませんでした。業務上の正しさを保証する判定ではありません。'));
    ds.forEach(d => { const row = element('div', '', `diagnostic ${d.level}`); const index = table.rules.findIndex(r => r.id === d.target); row.append(element('strong', index >= 0 ? `規則 #${index + 1}` : d.target === 'rules' ? '規則全体' : table.outputs.find(o => o.id === d.target)?.name ?? d.target), element('span', d.message)); host.append(row); });
  } else if (panel === 'merge') {
    host.append(element('p', '条件のどの組合せについても動作が変わらないと確認できた候補だけを表示します。動作指定がすべて同じ規則を1つに結合し、条件指定を整理します。全組合せを列挙できる表は全組合せで比較し、超える表は条件指定の範囲が一致することを証明します。承認前は正本を変更しません。'));
    // Merging keeps every result, so existing contradictions survive it; say so before the user compresses a broken table.
    const clash = contradictions(table).pairs; if (clash) host.append(element('p', `この表には動作指定が一致しない規則が${clash}組あります。結合しても不一致はそのまま残ります。先に「検証」で直すことを勧めます。`, 'check-empty'));
    const numbers = (ids: string[]) => ids.map(id => `#${table.rules.findIndex(r => r.id === id) + 1}`).join(' ');
    const reapply = (next: Table, note: string) => { commit(next, note); refreshMerge(); panel = 'merge'; renderPanel(); };
    if (compressed && compressed.steps > 0) {
      // "部分的に圧縮を繰り返す": every step is one proven candidate; the user approves the end result once.
      const all = compressed, row = element('div', '', 'candidate'), blocks = (t: Table) => t.rules.reduce((n, r) => n + r.anyOf.length, 0);
      row.append(element('strong', `繰り返し結合：${table.rules.length}規則 → ${all.table.rules.length}規則`), element('span', `結合と再計算を${all.steps}回繰り返した結果です。ORブロックは${blocks(table)}件 → ${blocks(all.table)}件。各回とも等価性を確認しています`), button('簡単化後のJSONを確認', () => { const m = modal('繰り返し適用後の表'); m.form.append(element('pre', encode(all.table)), button('閉じる', m.close)); }), button('承認して一括で反映', () => { if (stable(table) !== all.base) throw new Error('表が変更されたため再計算してください'); reapply(all.table, `${all.steps}回の結合を反映しました。`); }, 'primary'));
      host.append(row);
    }
    if (!candidates.length) host.append(element('p', '承認可能な結合候補はありません。', 'muted'));
    candidates.forEach(c => {
      const row = element('div', '', 'candidate'), sources = c.before.map(id => table.rules.find(r => r.id === id)!), from = sources.reduce((n, r) => n + r.anyOf.length, 0), to = c.replacement.anyOf.length;
      const toAll = c.replacement.anyOf.some(clause => table.conditions.some(x => !clause.selections.some(s => s.conditionId === x.id) && sources.some(r => r.anyOf.some(o => o.selections.some(s => s.conditionId === x.id)))));
      row.append(element('strong', c.before.length > 1 ? `${c.before.length}規則を結合 → 1規則` : from > to ? `規則 ${numbers(c.before)} の条件指定を整理` : `規則 ${numbers(c.before)} から、すべての値を選んだ条件を外す`), element('span', `対象：規則 ${numbers(c.before)} ／ ORブロック ${from}件 → ${to}件 ／ ${c.proof === 'structural' ? '条件の集合の一致から等価性を証明' : `${c.checked}組合せで等価性確認`}${toAll ? ' ／ すべての値がそろった条件は、条件指定から外します（無関係になり、あとで追加した値も対象になります）' : ''}`), button('対象条件を確認', () => { const m = modal('結合する規則'); m.form.append(element('pre', JSON.stringify({ sourceRules: c.before, proposed: c.replacement }, null, 2)), button('閉じる', m.close)); }), button('承認して結合', () => reapply(applyCandidate(table, c), '承認した結合を反映し、残りの候補を再計算しました。'), 'primary'));
      host.append(row);
    });
    // Rules with an unset output are not merged (DAT-003/005); say so instead of leaving the list unexplained.
    const idle = table.outputs.length ? table.rules.filter(r => r.directives.every(d => d.state === 'unset')).length : 0;
    if (idle) host.append(element('p', `動作を何も指定していない規則は対象外です（${idle}件）。`, 'muted'));
    const distinct = new Set(table.rules.map(r => stable(r.directives))).size;
    if (!candidates.length && table.rules.length) host.append(element('p', `現在の${table.rules.length}規則は、動作指定が${distinct}種類です。同じ動作指定の規則はすでに結合済みで、これ以上は結合できません。ここでの規則の数は、決定表（単適合）の規則の数とは別です。`, 'muted'));
  } else {
    const total = count(table), pre = element('pre');
    const effects = (ds: Directive[]) => ds.map(d => `${table.outputs.find(o => o.id === d.outputId)?.name}=${d.state === 'unset' ? '−' : JSON.stringify(d.value)}`).join(', ');
    const number = (ruleId: string) => table.rules.findIndex(r => r.id === ruleId) + 1;
    host.append(element('p', '特定の条件の組合せだけを見るには、「決定表の解釈」を使ってください。', 'muted'));
    if (total > 1000n) host.append(element('p', `全${total.toLocaleString('ja-JP')}組合せのうち先頭1,000件を表示します。元データは切り捨てていません。`));
    pre.textContent = expandRows(table, 1000).map((row, i) => { const conditions = table.conditions.map(c => `${c.name}=${c.partitions.find(p => p.id === row.atom[c.id])?.label}`).join(' / '); const lines = row.matches.map((match, order) => `${order + 1}. 規則 #${number(match.ruleId)}: ${effects(match.directives)}`).join('\n    '); return `${i + 1}. ${conditions}\n    ${lines || '満足される規則なし'}`; }).join('\n\n'); host.append(pre);
  }
  } catch (e) { host.append(element('p', `この表示は計算できませんでした：${(e as Error).message}`, 'muted')); }
}
function render() {
  const title = $('title') as HTMLInputElement; title.value = table.title; title.onchange = () => void run(() => commit({ ...table, title: title.value }));
  $('file-actions').replaceChildren(button('＋ 新しい表', clearWorkspace), button('JSONを開く', () => fileTask(openFile)), button('保存', () => fileTask(save)), button('別名で保存', () => fileTask(saveAs)), button('サンプルを開く', loadDemo, 'sample-button'));
  $('edit-actions').replaceChildren(button('＋ 条件', () => conditionDialog()), button('＋ 動作', () => outputDialog()), button('＋ 規則', () => {
    if (!table.conditions.length) throw new Error('先に条件を追加してください'); ruleDialog(null);
  }, 'primary'), button('全組合せの規則を作成', () => {
    const n = count(table); if (n > BigInt(LIMIT)) throw new Error(`条件指定の全組合せ${n.toLocaleString('ja-JP')}件は、規則を作成できる上限${LIMIT.toLocaleString('ja-JP')}件を超えます。「＋ 規則」で規則を1つずつ記述してください`);
    if (n > 1000n && !confirm(`条件指定の全組合せ${n}件の規則を作成します。続けますか？`)) return;
    if (table.rules.length) { regenerateDialog(); return; }
    commit(generate(table), '条件指定の全組合せの規則を作成しました。各規則を押して動作指定を入力してください。');
  }), button('検証', () => { panel = 'diagnostics'; renderPanel(); }), button('簡単化', async () => { message('結合できる規則と等価性を確認しています…'); await new Promise(r => setTimeout(r, 0)); refreshMerge(); panel = 'merge'; renderPanel(); message(`${candidates.length}件の承認可能な結合候補があります`); }), button('全組合せ', () => { panel = 'expand'; renderPanel(); }));
  const counts = $('counts'); counts.replaceChildren();
  for (const [value, label] of [[count(table).toLocaleString('ja-JP'), '条件指定の全組合せ'], [String(table.rules.length), '規則']] as [string, string][]) { const item = element('div'); item.append(element('strong', value), element('span', label)); counts.append(item); }
  const pattern = element('div'), hit = table.rules.length ? singleHit() : null; pattern.append(element('strong', !table.rules.length ? '—' : !hit ? '未更新' : hit.combined && hit.parts[0]?.found ? String(hit.parts[0].found.filter(x => x.satisfied).length) : `${hit.parts.length}表`), element('span', !hit || hit.combined ? '動作指定の組合せ' : '決定表（分離）')); counts.append(pattern);
  const defs = $('definition-list'); defs.replaceChildren();
  for (const c of table.conditions) { const chip = element('div', '', 'definition-chip'); chip.append(button(`${c.name} · 値${c.partitions.length}個`, () => conditionDialog(c)), button('×', () => { const next = clone(table); next.conditions = next.conditions.filter(x => x.id !== c.id); if (!next.conditions.length && table.rules.length) { if (!confirm('最後の条件を削除すると規則を保持できません。先にJSONを保存してください。規則も削除しますか？')) return; commit({ ...next, rules: [] }); } else { if (table.rules.length && !confirm(`条件「${c.name}」とその値の定義を削除しますか？規則は保持し、この条件の条件指定だけを外します。`)) return; applyDefinitions(next, () => {}); } }, 'tiny')); defs.append(chip); }
  for (const o of table.outputs) { const chip = element('div', '', 'definition-chip output-chip'); chip.append(button(`${o.name} · ${o.kind === 'action' ? '制限指定' : `拡張指定 ${o.type}`}`, () => outputDialog(o)), button('×', () => { if (!confirm(`動作「${o.name}」と入力済みの動作指定を削除しますか？`)) return; const next = clone(table); next.outputs = next.outputs.filter(x => x.id !== o.id); next.rules.forEach(r => { r.directives = r.directives.filter(d => d.outputId !== o.id); }); commit(next); }, 'tiny')); defs.append(chip); }
  const wrap = $('table-wrap'); wrap.replaceChildren();
  if (!table.rules.length) {
    const blank = element('div', '', 'empty-state'); blank.append(element('div', '⊞', 'empty-icon'), element('h2', '最初のルールをつくりましょう'), element('p', table.conditions.length ? '「＋ 規則」で規則を1つずつ書きます。規則には、関係する条件と、実行する動作だけを書きます。\n書いた規則は「条件 → 動作」の形で1行ずつ並びます。' : 'まず「＋ 条件」と「＋ 動作」を定義し、「＋ 規則」で規則を1つずつ書きます。\nサンプルなら、編集から簡単化までひと通り試せます。'), button('サンプルで試す →', loadDemo, 'primary')); wrap.append(blank);
  } else {
    const list = element('div', '', 'rule-list');
    table.rules.slice(page * 40, page * 40 + 40).forEach((r, offset) => {
      const index = page * 40 + offset, item = element('div', '', 'rule-item'); item.id = `row-${r.id}`;
      const text = button('', () => ruleDialog(r.id), 'rule-text'); text.title = 'この規則を編集'; text.append(element('span', ruleText(r), 'rule-if'), element('span', '→', 'rule-arrow'), element('span', actionText(r), 'rule-then'));
      const controls = element('div', '', 'rule-controls');
      const up = button('↑', () => { if (!index) return; const next = clone(table); [next.rules[index - 1], next.rules[index]] = [next.rules[index], next.rules[index - 1]]; commit(next); }, 'tiny'); up.disabled = index === 0; up.title = '規則を上へ';
      const down = button('↓', () => { if (index >= table.rules.length - 1) return; const next = clone(table); [next.rules[index + 1], next.rules[index]] = [next.rules[index], next.rules[index + 1]]; commit(next); }, 'tiny'); down.disabled = index === table.rules.length - 1; down.title = '規則を下へ';
      controls.append(up, down, button('×', () => { if (!confirm('この規則を削除しますか？')) return; const next = clone(table); next.rules.splice(index, 1); commit(next); }, 'tiny'));
      item.append(element('span', `#${index + 1}`, 'rule-no'), text, controls); list.append(item);
    }); wrap.append(list);
  }
  const pages = $('pagination'); pages.replaceChildren();
  if (table.rules.length > 40) { const prev = button('← 前へ', () => { page--; render(); }); prev.disabled = page === 0; const next = button('次へ →', () => { page++; render(); }); next.disabled = (page + 1) * 40 >= table.rules.length; pages.append(prev, element('span', `${page + 1} / ${Math.ceil(table.rules.length / 40)}ページ · 1ページ40規則`), next); }
  $('help-actions').replaceChildren(button('対応JSON Schemaを書出', () => download(JSON.stringify(documentSchema, null, 2), 'decision-table.schema.json')), button('外部ファイルを再確認', () => poll(true)), button('現在のJSONを確認', () => { const m = modal('現在のJSON'); m.form.append(element('pre', encode(table)), button('閉じる', m.close)); }));
  updateStatus(); renderPanel(); renderDecision(); renderCheck();
}
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(true); else { fileMessage = session ? '検知休止中（復帰後に再確認）' : fileMessage; updateStatus(); } });
setInterval(() => void poll(), 1000);
render();
