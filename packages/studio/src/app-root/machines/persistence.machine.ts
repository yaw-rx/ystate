import { define, type Widen } from '@yaw-rx/ystate'
import { Subject, from, type Observable } from 'rxjs'

/**
 * The lifecycle of persisting one reactive value - a workspace snapshot,
 * the filesystem-level dependency graph, anything with a "write this
 * somewhere" operation and a live source of what to write.
 *
 * `saving`/`saved`/`failed` carry the value itself as node data - real
 * observability of what's actually being/was persisted, and the
 * authoritative baseline for "has this actually changed" (no separate
 * bookkeeping variable duplicating it). `saving` self-loops on `save.next`,
 * so `enter()` tears down an in-flight write before starting a new one - a
 * change arriving mid-save cancels and redoes with the latest value,
 * precisely, instead of an arbitrary debounce window. `removed` is the
 * real terminal-node disposal mechanism (see `workspace-file.machine.ts`'s
 * `analysisTopology` doc comment).
 *
 * The closure owns everything: it subscribes to `value$` itself, compares
 * each new value against `saved.value` (the real invalidation check, not
 * "is this the first emission"), and decides when a change is worth
 * persisting. A caller never calls `save$.next()` or samples `value$`
 * itself, it only ever calls `dispose()`.
 */
export function createPersistenceMachine<T>(
    persist: (value: T) => Promise<void>,
    value$: Observable<T>,
    options?: { isEqual?: (a: T, b: T) => boolean; initial?: T },
) {
    const isEqual = options?.isEqual ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b))

    const persistenceTopology = define({
        nodes: {
            idle: {},
            saving: { value: undefined as T | undefined },
            saved: { value: undefined as T | undefined },
            failed: { error: '', value: undefined as T | undefined },
            removed: {},
        },
        edges: {
            start: { from: 'idle', to: 'saving', on: 'save.next' },
            restart: { from: 'saving', to: 'saving', on: 'save.next' },
            resave: { from: 'saved', to: 'saving', on: 'save.next' },
            retry: { from: 'failed', to: 'saving', on: 'save.next' },
            succeed: { from: 'saving', to: 'saved', on: 'persist.next' },
            fail: { from: 'saving', to: 'failed', on: 'persist.error' },
            disposeIdle: { from: 'idle', to: 'removed', on: 'dispose.next' },
            disposeSaving: { from: 'saving', to: 'removed', on: 'dispose.next' },
            disposeSaved: { from: 'saved', to: 'removed', on: 'dispose.next' },
            disposeFailed: { from: 'failed', to: 'removed', on: 'dispose.next' },
        },
    })

    const save$ = new Subject<T>()
    const dispose$ = new Subject<void>()

    // Bridges `save`'s next handler (which runs first) to `persist`'s $
    // (invoked right after, on entry to 'saving') - $ factories only
    // receive `runningMachines`, never the machine's own current node
    // data, so this is the mechanical link; `saving: { value }` below is
    // the same value, kept as data purely for observability.
    let pending: T

    // `Widen<T>` can't be resolved against a naked generic - TypeScript
    // can't simplify a conditional type over an unresolved type parameter,
    // so `T` and `Widen<T>` are treated as unrelated even though for any
    // concrete T actually used here (SerializedWorkspace,
    // SerializedDependencyGraph) they're structurally the same shape.
    // These casts are the accepted escape for that specific limitation,
    // not a workaround for a design gap - real values, real shapes,
    // TypeScript just can't prove it generically.
    const machine = persistenceTopology.implement({
        save: {
            $: () => save$,
            next: (value) => {
                pending = value
                return { value } as unknown as { value: Widen<T> }
            },
        },
        persist: {
            $: () => from(persist(pending)),
            next: () => ({ value: pending }) as unknown as { value: Widen<T> },
            error: (err, _dest, source) => ({ error: String(err), value: source.value }) as unknown as { error: string; value: Widen<T> },
        },
        dispose: {
            $: () => dispose$,
            next: () => ({}),
        },
    })

    // `initial` seeds the machine directly into 'saved' with that value as
    // its data, if the caller already knows a persisted value exists (a
    // workspace hydrated from storage) - not a separate "skip the first
    // emission" special case, the same init-node-data hydration every
    // other machine in this app already uses.
    const running = options?.initial !== undefined
        ? machine.close().start('saved', {}, { saved: { value: options.initial as unknown as Widen<T> } })
        : machine.close().start('idle')

    // Only 'saved' is confirmed-persisted - 'failed' also carries `value`,
    // but it's the attempted value that *didn't* write, not a fact about
    // what's actually in storage. Feeding that into `known` would mean a
    // network failure permanently suppresses retrying: the next time the
    // same value$ emission recurs unchanged, it would compare equal to the
    // failed attempt and silently never be retried at all.
    let known: T | undefined = options?.initial
    const stateSub = running.state$.subscribe(s => {
        if (s.node === 'saved') known = (s.data as { value?: T }).value
    })

    const sub = value$.subscribe(value => {
        if (known !== undefined && isEqual(value, known)) return
        save$.next(value)
    })

    function dispose(): void {
        dispose$.next()
        sub.unsubscribe()
        stateSub.unsubscribe()
    }

    return { runningMachine: running, dispose }
}
