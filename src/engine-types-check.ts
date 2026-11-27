// TASK-014: compile-time check that types/decision-table-engine.d.ts (shipped next to the engine) matches src/engine.ts.
// Not part of any bundle.
import * as actual from './engine.ts';
import type * as declared from '../types/decision-table-engine.d.ts';
export const forward: typeof declared = actual;
export const backward: typeof actual = null as unknown as typeof declared;
