// TASK-001 / REQ-014..016 / ARCH-006: explicit 3-version coordination.
import { clone, decode, encode, stable, type Table } from './core.ts';
export type Handle = { name: string; getFile(): Promise<{ text(): Promise<string> }>; createWritable(options?: { mode: string }): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>; isSameEntry?(other: Handle): Promise<boolean> };
export type Observation = { kind: 'same' | 'local' | 'external' | 'conflict'; raw: string; external?: Table };
export class FileCoordinator {
  handle: Handle;
  baseRaw: string;
  baseModel: string;
  checkedAt = 0;
  constructor(handle: Handle, raw: string) { this.handle = handle; this.baseRaw = raw; this.baseModel = stable(decode(raw)); }
  static async connect(handle: Handle): Promise<{ session: FileCoordinator; table: Table }> {
    const raw = await (await handle.getFile()).text(), table = decode(raw);
    return { session: new FileCoordinator(handle, raw), table };
  }
  async check(local: Table): Promise<Observation> {
    const raw = await (await this.handle.getFile()).text(); this.checkedAt = Date.now();
    const dirty = stable(local) !== this.baseModel;
    if (raw === this.baseRaw) return { kind: dirty ? 'local' : 'same', raw };
    const external = decode(raw); // invalid external data never advances the baseline
    return { kind: dirty ? 'conflict' : 'external', raw, external };
  }
  async accept(expectedRaw: string): Promise<Table> {
    const raw = await (await this.handle.getFile()).text();
    if (raw !== expectedRaw) throw new Error('確認後に外部ファイルが再変更されました。もう一度確認してください');
    const table = decode(raw); this.baseRaw = raw; this.baseModel = stable(table); this.checkedAt = Date.now(); return table;
  }
  async save(local: Table): Promise<void> {
    const snapshot = clone(local), text = encode(snapshot);
    await writeVerified(this.handle, this.baseRaw, text);
    this.baseRaw = text; this.baseModel = stable(snapshot); this.checkedAt = Date.now();
  }
}
export async function writeVerified(handle: Handle, expectedRaw: string, text: string): Promise<void> {
  if (await (await handle.getFile()).text() !== expectedRaw) throw new Error('保存直前に外部変更を検出しました。上書きを中止しました');
  const writer = await handle.createWritable({ mode: 'exclusive' });
  try {
    // A browser writer lock does not imply OS-wide exclusion of external programs.
    if (await (await handle.getFile()).text() !== expectedRaw) throw new Error('書込開始時に外部変更を検出しました');
    await writer.write(text); await writer.close();
  } catch (e) { try { await writer.abort?.(); } catch { /* preserve original error */ } throw e; }
  if (await (await handle.getFile()).text() !== text) throw new Error('保存後の再読込が一致しません。外部同時編集の可能性があります。編集中データは保持しています');
}
