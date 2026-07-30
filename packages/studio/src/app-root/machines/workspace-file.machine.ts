import { define } from '@yaw-rx/ystate'
import { Subject, merge, switchMap, map, filter, skip, from, of, EMPTY, observeOn, queueScheduler, type Observable } from 'rxjs'
import type { FileAnalysis } from '../types/serialized-filesystem.types.js'
import type { RuntimeFilesystem, RuntimeWorkspace, RuntimeFile, QualifiedName } from '../types/runtime-filesystem.types.js'
import type { WorkspaceEvaluationService } from '../services/workspace-evaluation.service.js'
import { splitQualifiedName, toQualifiedName } from '../utils/qualified-name.js'

export type WorkspaceFileNode = 'unanalyzed' | 'blocked' | 'analyzing' | 'analyzed' | 'failed' | 'removed'

/**
 * The lifecycle of a single workspace file's analysis, including the
 * cascade through its dependency chain.
 *
 * `blocked` is the state that makes the cascade visible: the instant an
 * upstream dependency becomes unsettled (enters `analyzing` or `blocked`
 * itself), this file's own machine transitions to `blocked` immediately -
 * not once the upstream finishes, the moment it starts. `waitingOn` on
 * that node is the live set of upstream files still unsettled, real node
 * data, not invisible bookkeeping. Only once every one of them has settled
 * (`analyzed`/`failed`) does `blocked` advance to `analyzing` and the
 * actual `analyze` call happens - re-running while even one dependency is
 * still unsettled would read stale data from it. If this file was actively
 * `analyzing` when an upstream newly went dirty, that's a cancel: the
 * in-flight run was reading soon-to-be-stale data, so `enter()` tears it
 * down and this file moves to `blocked` instead of finishing it.
 *
 * `analyzing` also self-loops on `request.next` for the same reason as
 * always: a direct edit arriving mid-run cancels and restarts the
 * environment call with the newest content.
 *
 * `removed` is a genuine terminal node [outdeg(v) = 0] - reachable from
 * every other node via `dispose.next`. Entering it is what tears the
 * machine down: `enter()` calls `teardown()` (unsubscribing whatever was
 * in flight) before checking for terminality, then completes
 * `state$`/`event$`/`status$`. This is the library's own disposal
 * mechanism (F = terminal nodes), not a manual unsubscribe reached in
 * from outside.
 */
const analysisTopology = define({
    nodes: {
        unanalyzed: {},
        blocked: { waitingOn: [] as QualifiedName[], stale: undefined as FileAnalysis | undefined },
        analyzing: { stale: undefined as FileAnalysis | undefined },
        analyzed: { analysis: { diagnostics: [], exports: [] } as FileAnalysis },
        failed: { error: '', stale: undefined as FileAnalysis | undefined },
        removed: {},
    },
    edges: {
        start: { from: 'unanalyzed', to: 'analyzing', on: 'request.next' },
        restart: { from: 'analyzing', to: 'analyzing', on: 'request.next' },
        reanalyze: { from: 'analyzed', to: 'analyzing', on: 'request.next' },
        retry: { from: 'failed', to: 'analyzing', on: 'request.next' },
        succeed: { from: 'analyzing', to: 'analyzed', on: 'analyze.next' },
        fail: { from: 'analyzing', to: 'failed', on: 'analyze.error' },

        blockFromUnanalyzed: { from: 'unanalyzed', to: 'blocked', on: 'dirty.next' },
        blockFromAnalyzing: { from: 'analyzing', to: 'blocked', on: 'dirty.next' },
        blockFromAnalyzed: { from: 'analyzed', to: 'blocked', on: 'dirty.next' },
        blockFromFailed: { from: 'failed', to: 'blocked', on: 'dirty.next' },
        restartBlocked: { from: 'blocked', to: 'blocked', on: 'dirty.next' },
        unblock: { from: 'blocked', to: 'analyzing', on: 'ready.next' },

        disposeUnanalyzed: { from: 'unanalyzed', to: 'removed', on: 'dispose.next' },
        disposeBlocked: { from: 'blocked', to: 'removed', on: 'dispose.next' },
        disposeAnalyzing: { from: 'analyzing', to: 'removed', on: 'dispose.next' },
        disposeAnalyzed: { from: 'analyzed', to: 'removed', on: 'dispose.next' },
        disposeFailed: { from: 'failed', to: 'removed', on: 'dispose.next' },
    },
})

/**
 * `QualifiedName` is only ever an address, never storage - a file always
 * actually lives at `workspaces.get(ws).files$`. This resolves one address
 * back down through the real filesystem -> workspace -> file tree.
 */
function resolveFile$(workspaces: ReadonlyMap<string, RuntimeWorkspace>, qualifiedName: QualifiedName): Observable<RuntimeFile | undefined> {
    const { workspace: workspaceName, file: fileName } = splitQualifiedName(qualifiedName)
    const workspace = workspaces.get(workspaceName)
    return workspace ? workspace.files$.pipe(map(files => files.get(fileName))) : of(undefined)
}

export function createFileMachine(
    evaluationService: WorkspaceEvaluationService,
    filesystem: RuntimeFilesystem,
    workspaceName: string,
    fileName: string,
    content$: Observable<string>,
) {
    const qualifiedName = toQualifiedName(workspaceName, fileName)
    const request$ = new Subject<void>()
    const dirty$ = new Subject<QualifiedName[]>()
    const ready$ = new Subject<void>()
    const dispose$ = new Subject<void>()

    // The root trigger the whole cascade starts from - content$ always
    // emits once immediately with whatever's already there (modelContent$'s
    // startWith), which is the just-hydrated value, not an edit; skipping
    // it is what lets a file hydrate straight into analyzed/failed without
    // immediately requesting a redundant re-analysis of itself.
    const contentSub = content$.pipe(skip(1)).subscribe(() => request$.next())

    // The live set of upstream dependencies currently unsettled. Grows the
    // instant one enters analyzing/blocked (dirty$ fires immediately, with
    // the updated set, so the cascade is visible before any upstream work
    // finishes) and shrinks as each settles - only once it's empty does
    // ready$ fire.
    const waiting = new Set<QualifiedName>()
    const upstreamSub = filesystem.dependencyGraph$.pipe(
        switchMap(graph => {
            const upstream = graph.imports.get(qualifiedName)
            if (!upstream || upstream.size === 0) return EMPTY
            return filesystem.workspaces$.pipe(
                switchMap(workspaces => merge(...[...upstream].map(dep =>
                    resolveFile$(workspaces, dep).pipe(
                        filter((f): f is RuntimeFile => !!f),
                        switchMap(f => f.machine.state$.pipe(map(s => ({ dep, node: s.node })))),
                    ),
                ))),
            )
        }),
        // This callback fires synchronously from *another* file's
        // machine.state$ emission (a dependency settling) - without
        // breaking that, this.dirty$/ready$.next() below re-enters the
        // ystate runtime's enter() while it's still unwinding the upstream
        // file's own transition (and whatever DOM patch that transition's
        // own subscribers are mid-flight on). queueScheduler trampolines
        // reentrant notifications into a queue instead of nesting the call
        // stack, which is what was corrupting rx-for's DOM reconciliation
        // (Uncaught NotFoundError: insertBefore) and silently dropping
        // delivery to subscribers later in the same synchronous chain -
        // exactly why the UI looked "stuck" until an unrelated edit forced
        // a fresh, non-reentrant transition.
        observeOn(queueScheduler),
    ).subscribe(({ dep, node }) => {
        const unsettled = node === 'analyzing' || node === 'blocked'
        if (unsettled) waiting.add(dep)
        else waiting.delete(dep)

        if (waiting.size === 0) ready$.next()
        else dirty$.next([...waiting])
    })
    dispose$.subscribe(() => {
        upstreamSub.unsubscribe()
        contentSub.unsubscribe()
    })

    const machine = analysisTopology.implement({
        // Carries the last-known-good analysis forward through analyzing/
        // blocked/failed so a consumer never has to fall back to nothing
        // just because a fresh pass is running or the last one errored -
        // only unanalyzed has no `stale`.
        request: {
            $: () => request$,
            next: (_result, _dest, source) => ({
                stale: 'analysis' in source ? source.analysis : 'stale' in source ? source.stale : undefined,
            }),
        },
        dirty: {
            $: () => dirty$,
            next: (waitingOn, _dest, source) => ({
                waitingOn,
                stale: 'analysis' in source ? source.analysis : 'stale' in source ? source.stale : undefined,
            }),
        },
        ready: {
            $: () => ready$,
            next: (_result, _dest, source) => ({ stale: source.stale }),
        },
        analyze: {
            $: () => from(evaluationService.evaluateFile(filesystem, qualifiedName)),
            next: (analysis) => ({ analysis }),
            error: (err, _dest, source) => ({ error: String(err), stale: source.stale }),
        },
        dispose: {
            $: () => dispose$,
            next: () => ({}),
        },
    })

    return { machine, request$, dispose$ }
}

export type WorkspaceFileMachine = ReturnType<typeof createFileMachine>['machine']
