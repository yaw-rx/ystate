import type { IncidenceGraphSet, NodeData, EdgeDef } from '@yaw-rx/ystate'

/**
 * Checks for the structural shape common to both `IncidenceGraphSetMixin`
 * (pre-`implement()`) and `IncidenceMachineMixin` (post-`implement()`, which
 * extends `IncidenceGraphSet`) - a `nodes`/`edges` incidence structure `G = (V, E)`.
 * True for either mixin variant. Use `isIncidenceGraphSetMixin` or
 * `isIncidenceMachineMixin` to distinguish which one a given value is.
 */
export const isIncidenceGraphSet = (obj: unknown): obj is IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef>> =>
    obj != null
    && typeof obj === 'object'
    && 'nodes' in obj
    && 'edges' in obj
