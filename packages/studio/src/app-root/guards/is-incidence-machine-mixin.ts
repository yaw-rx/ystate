import type { IncidenceMachineMixin, NodeData, EdgeDef, TransitionDef } from '@yaw-rx/ystate'
import { isIncidenceGraphSet } from './is-incidence-graph-set.js'

/**
 * Checks for the value returned by calling `.implement()` on an
 * `IncidenceGraphSetMixin`: an `IncidenceGraphSet` equipped with transition
 * functions [δ = { δⱼ }] via a `transitions` field, and no remaining
 * `.implement()` method (see `isIncidenceGraphSetMixin` for the pre-implement
 * variant).
 */
export const isIncidenceMachineMixin = (
    obj: unknown,
): obj is IncidenceMachineMixin<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>> =>
    isIncidenceGraphSet(obj)
    && 'transitions' in obj
