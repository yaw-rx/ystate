import type { Observable, Subscription } from 'rxjs'

/**
 * Pure observation of a machine's own `state$` - never touches the machine
 * itself, transitions stay side-effect-free. Every `createXMachine` in this
 * app exposes its failure as real node data (see e.g. `analysisTopology`'s
 * `failed: { error }`); this just prints it where it's easy to see.
 */
export function logMachineFailures(
    label: string,
    state$: Observable<{ node: string; data: unknown }>,
    failedNode: string,
): Subscription {
    return state$.subscribe(s => {
        if (s.node === failedNode) console.error(`[${label}] -> ${failedNode}:`, s.data)
    })
}
