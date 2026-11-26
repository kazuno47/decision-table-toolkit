// TASK-001, TASK-002 / REQ-007,010 / DAT-001..005: a closed, versioned exchange schema (1.0 and 1.1).
export type Schema = { type?: string; const?: unknown; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; pattern?: string; oneOf?: Schema[]; $schema?: string; title?: string };
const text = (maxLength = 1024): Schema => ({ type: 'string', maxLength });
const id: Schema = { type: 'string', minLength: 1, maxLength: 128 };
const array = (items: Schema, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems: 10000 });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const scalar: Schema = { oneOf: [{ type: 'boolean' }, text()] };
const nullable: Schema = { oneOf: [text(128), { type: 'null' }] };
const range = object({ lower: nullable, upper: nullable, lowerInclusive: { type: 'boolean' }, upperInclusive: { type: 'boolean' } });
const partition: Schema = { oneOf: [
  object({ id, label: text(), kind: { const: 'values' }, values: array(scalar, 1) }),
  object({ id, label: text(), kind: { const: 'range' }, range }),
  object({ id, label: text(), kind: { const: 'missing' } })
] };
const condition = object({ id, name: text(), type: { enum: ['boolean', 'enum', 'number', 'string', 'date'] }, partitions: array(partition, 1) });
const resultTypes = ['boolean', 'number', 'string', 'date'];
const output: Schema = { oneOf: [
  object({ id, name: text(), kind: { const: 'action' } }),
  object({ id, name: text(), kind: { const: 'result' }, type: { enum: resultTypes } }),
  object({ id, name: text(), kind: { const: 'result' }, type: { const: 'enum' }, values: array(text(), 1) })
] };
const directive: Schema = { oneOf: [object({ outputId: id, state: { const: 'unset' } }), object({ outputId: id, state: { const: 'set' }, value: scalar })] };
const selection = object({ conditionId: id, partitionIds: array(id, 1) });
// 1.1 (DAT-004 / DEC-025): an omitted condition means every partition; core.validate keeps 1.0 exhaustive.
const clause = object({ selections: array(selection) });
const rule = object({ id, anyOf: array(clause, 1), directives: array(directive) });
export const documentSchema: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', title: 'Decision Table Toolkit 1.0 / 1.1 (schemaVersion 1.0 additionally requires every condition exactly once in each clause; the application enforces this)',
  ...object({ schemaVersion: { enum: ['1.0', '1.1'] }, id, title: text(256), conditions: array(condition), outputs: array(output), rules: array(rule) })
};
// Interpret this bounded subset without eval, Function or remote schema requests.
export function checkShape(value: unknown, schema: Schema = documentSchema, path = '$', depth = 0): string[] {
  if (depth > 24) return [`${path}: 入れ子が深すぎます`];
  if (schema.oneOf) return schema.oneOf.filter(s => checkShape(value, s, path, depth + 1).length === 0).length === 1 ? [] : [`${path}: データ形式が一致しないか、未知フィールドがあります`];
  if ('const' in schema && value !== schema.const) return [`${path}: 未対応の値 ${String(value)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: 未対応の値 ${String(value)}`];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && type !== schema.type) return [`${path}: ${schema.type} が必要です`];
  if (type === 'string') {
    const s = value as string;
    if (s.length < (schema.minLength ?? 0) || s.length > (schema.maxLength ?? 100000)) return [`${path}: 文字数が範囲外です`];
  }
  if (schema.type === 'array') {
    const a = value as unknown[];
    if (a.length < (schema.minItems ?? 0) || a.length > (schema.maxItems ?? 10000)) return [`${path}: 要素数が範囲外です`];
    return a.flatMap((v, i) => checkShape(v, schema.items!, `${path}[${i}]`, depth + 1));
  }
  if (schema.type === 'object') {
    const o = value as Record<string, unknown>, props = schema.properties ?? {};
    const errors = (schema.required ?? []).filter(k => !Object.hasOwn(o, k)).map(k => `${path}.${k}: 必須です`);
    for (const k of Object.keys(o)) {
      if (!Object.hasOwn(props, k)) errors.push(`${path}.${k}: 未知のフィールドです`);
      else errors.push(...checkShape(o[k], props[k], `${path}.${k}`, depth + 1));
    }
    return errors;
  }
  return [];
}
