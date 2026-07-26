import type { IncidenceGraphSetMixin, NodeData, EdgeDef, IncidenceGraphSet } from '@yaw-rx/ystate'
import { isIncidenceGraphSet } from './is-incidence-graph-set.js'

/**
 * Checks for the value returned by `define()`: an `IncidenceGraphSet` still
 * carrying its unconsumed `.implement()` method. Calling `.implement()` on it
 * produces an `IncidenceMachineMixin` instead (see `isIncidenceMachineMixin`),
 * so presence of `implement` is exactly what tells the two apart at runtime.
 */
export const isIncidenceGraphSetMixin = (
    obj: unknown,
): obj is IncidenceGraphSetMixin<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef>>>> =>
    isIncidenceGraphSet(obj)
    && typeof (obj as Record<string, unknown>)['implement'] === 'function'
