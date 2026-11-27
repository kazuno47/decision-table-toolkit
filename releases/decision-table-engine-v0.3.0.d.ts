// Decision Table Toolkit - engine. Types of the single-file ES module in releases/decision-table-engine-v*.js.
// Checked against the sources by src/engine-types-check.ts.
export type DataType = 'boolean' | 'enum' | 'number' | 'string' | 'date';
/** A value in the table. Numbers and dates are decimal / YYYY-MM-DD strings. */
export type Scalar = boolean | string;
export type Bound = { lower: string | null; upper: string | null; lowerInclusive: boolean; upperInclusive: boolean };
export type Partition = { id: string; label: string; kind: 'values'; values: Scalar[] } | { id: string; label: string; kind: 'range'; range: Bound } | { id: string; label: string; kind: 'missing' };
export type Condition = { id: string; name: string; type: DataType; partitions: Partition[] };
export type Output = { id: string; name: string; kind: 'action' } | { id: string; name: string; kind: 'result'; type: DataType; values?: string[] };
export type Directive = { outputId: string; state: 'unset' } | { outputId: string; state: 'set'; value: Scalar };
export type Clause = { selections: { conditionId: string; partitionIds: string[] }[] };
export type Rule = { id: string; anyOf: Clause[]; directives: Directive[] };
/** The exchange format (schemas/decision-table.schema.json), versions 1.0 and 1.1. */
export type Table = { schemaVersion: '1.0' | '1.1'; id: string; title: string; conditions: Condition[]; outputs: Output[]; rules: Rule[] };

export type ConditionInfo = { id: string; name: string; type: DataType; values: { id: string; label: string }[] };
export type ActionInfo = { id: string; name: string; kind: 'action' | 'result' };
/**
 * determined: the same for every input the given values leave open (executed, with `value`).
 * none: no rule specifies the action there (the entry "-", not executed).
 * open: depends on conditions not given yet. conflict: rules specify different values for the same input.
 */
export type ActionResult = ActionInfo & { status: 'determined' | 'none' | 'open' | 'conflict'; executed: boolean | null; value: Scalar | null; candidates: Scalar[]; rules: string[] };
export type Evaluation = {
  /** Every action is determined or none. */
  decided: boolean;
  /** Every condition was given. */
  complete: boolean;
  conflict: boolean;
  actions: ActionResult[];
  /** Ids of conditions not given yet that an open action depends on. */
  needed: string[];
  /** Rules that can be satisfied; always = satisfied for every input the given values leave open. */
  rules: { id: string; number: number; always: boolean }[];
  /** Keys of the input that name no condition of this table. */
  ignored: string[];
};
export type RawValue = boolean | string | number | null;

/** The version of the toolkit release this file belongs to. */
export declare const version: string;
/** Parses and validates a table (JSON text or an already parsed object). Throws when it is not a valid table. */
export declare function load(source: string | unknown): Table;
export declare function conditions(table: Table): ConditionInfo[];
export declare function actions(table: Table): ActionInfo[];
/** Raw values (by condition id or unique name) to condition entry ids. Throws when a value fits no entry. */
export declare function classify(table: Table, values: Record<string, RawValue | undefined>): Record<string, string>;
/** Interprets the table for condition entries (by id or unique label), keyed by condition id or unique name. */
export declare function evaluate(table: Table, picks: Record<string, string | undefined>): Evaluation;
