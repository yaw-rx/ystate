import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { Router } from '@yaw-rx/core/router'
import { type Observable, type Subscription, combineLatest, from, map, tap, filter, distinctUntilChanged, switchMap, of, catchError, EMPTY } from 'rxjs'
import { RuntimeFilesystemService } from '../services/runtime-filesystem.service.js'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'
import type { FileAnalysis } from '../types/serialized-filesystem.types.js'
import type { SerializedGraphSet, ClosureResult, GraphKind, SandboxResult } from '../services/sandbox.service.js'
import { ElkLayoutService, type LayoutResult } from '../services/elk-layout.service.js'
import '../components/graph-canvas.component.js'
import '../components/code-panel.component.js'

interface ActiveGraphData {
    graphs: Record<string, SerializedGraphSet>
    graphKinds: Record<string, GraphKind>
    transitionKeys: Record<string, string[]>
    closureResults: Record<string, ClosureResult>
    /** Evaluation errors from files sitting in 'failed' - one entry per failed file, deduplicated (a broken pool fails every file with the same error). */
    errors: string[]
}

/**
 * There is no manual evaluation trigger here anymore, and no
 * `evalGeneration` staleness guard - every file's machine drives its own
 * analysis autonomously (see machines/workspace-file.machine.ts), and this
 * page only derives the active workspace's graph-set/machine exports
 * reactively off `RuntimeFilesystemService`. The staleness problem
 * `evalGeneration` used to guard against is `switchMap`'s job now: a newer
 * `activeGraphData$` emission cancels whatever ELK layout call was still
 * in flight for the previous one, the same cancellation every other
 * machine/service in this app gets from `enter()`'s teardown.
 */
@Component({
    selector: 'workspace-page',
    template: `
        <graph-canvas class="canvas-area"
            [layout]="layoutResult"
            [closureResults]="closureResults"
            [graphKinds]="graphKinds"
            [transitionKeys]="transitionKeys"
        ></graph-canvas>
        <div class="divider" onpointerdown="startResize"></div>
        <code-panel #codePanel class="code-area"
            [workspaceName]="activeWorkspace"
            [sandboxResult]="sandboxResult"
            [style.width]="codePanelWidthStyle"
        ></code-panel>
    `,
    styles: `
        :host {
            display: flex;
            flex: 1;
            height: 100%;
        }
        .canvas-area {
            flex: 1;
            min-width: 0;
        }
        .divider {
            width: 5px;
            cursor: col-resize;
            background: var(--border);
            transition: background 0.1s;
            flex-shrink: 0;
        }
        .divider:hover, .divider.active {
            background: var(--accent);
        }
        .code-area {
            flex-shrink: 0;
            min-width: 200px;
            max-width: 80%;
        }
    `,
})
export class WorkspacePage extends RxElement {
    @Inject(Router) private readonly router!: Router
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService

    @state layoutResult: LayoutResult | null = null
    @state activeWorkspace = ''
    @state codePanelWidth = 420
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}
    // output-panel never reads runtimeKinds, only closureResults/graphKinds -
    // this is a real SandboxResult shape for it, just not a full one.
    @state sandboxResult: SandboxResult | null = null
    private subs: Subscription[] = []

    get codePanelWidthStyle$(): Observable<string> {
        return this.codePanelWidth$.pipe(map((w: number) => `${w}px`))
    }

    private readonly elkLayout = new ElkLayoutService()

    startResize(e: PointerEvent): void {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.classList.add('active')
        target.setPointerCapture(e.pointerId)
        const rect = this.getBoundingClientRect()

        const onMove = (ev: PointerEvent) => {
            const newWidth = rect.right - ev.clientX
            this.codePanelWidth = Math.max(200, Math.min(rect.width * 0.8, newWidth))
        }
        const onUp = () => {
            target.classList.remove('active')
            target.removeEventListener('pointermove', onMove)
            target.removeEventListener('pointerup', onUp)
        }
        target.addEventListener('pointermove', onMove)
        target.addEventListener('pointerup', onUp)
    }

    override onInit(): void {
        this.subs.push(this.router.route$.pipe(
            map((route: string) => {
                const prefix = '/workspace/'
                return route.startsWith(prefix) ? route.slice(prefix.length) : ''
            }),
            distinctUntilChanged(),
            filter((name: string) => name !== ''),
            tap((name: string) => { this.activeWorkspace = name }),
        ).subscribe())

        // Closure results and layout deliberately split: closure data
        // applies on EVERY emission, before and independent of ELK. A graph
        // that can't lay out (an edge referencing a commented-out node
        // throws JsonImportException inside ELK) still carries the closure
        // issues that explain exactly why - the canvas re-renders the
        // previous layout with the new issues (the missing node still
        // exists in the stale layout, flagged red by the fresh
        // missing-target/missing-source issues) and the output panel shows
        // them. Only layoutResult waits on ELK; a failed layout keeps the
        // previous one rather than killing the subscription.
        this.subs.push(this.activeGraphData$.pipe(
            tap(({ graphs, graphKinds, transitionKeys, closureResults, errors }) => {
                console.log(`[workspace-page] activeGraphData$ emitted: ${Object.keys(graphs).length} graph(s), ${errors.length} evaluation error(s), applying closure results`, { graphs, closureResults, errors })
                this.graphKinds = graphKinds
                this.transitionKeys = transitionKeys
                this.closureResults = closureResults
                // A failed evaluation (a syntax error breaks the whole
                // pool) surfaces in the terminal as ok:false, same as the
                // sandbox itself reporting it - not silently swallowed
                // while stale closure results play innocent underneath.
                this.sandboxResult = errors.length > 0
                    ? { ok: false, error: errors.join('\n\n') }
                    : { ok: true, runtimeKinds: {}, graphs, graphKinds, transitionKeys, closureResults }
            }),
            switchMap(data => from(this.elkLayout.layout(data.graphs)).pipe(
                catchError(e => {
                    console.error('[workspace-page] ELK layout failed, keeping previous layout (closure results already applied)', e)
                    return EMPTY
                }),
            )),
            tap(layout => {
                console.log('[workspace-page] elkLayout.layout resolved, applying layout')
                this.layoutResult = layout
            }),
        ).subscribe())
    }

    private get activeGraphData$(): Observable<ActiveGraphData> {
        return this.activeWorkspace$.pipe(
            switchMap(name => {
                if (!name) return of<ReadonlyMap<string, RuntimeFile>>(new Map())
                return this.filesystem.workspaces$.pipe(
                    switchMap(workspaces => {
                        const ws = workspaces.get(name)
                        return ws ? ws.files$ : of<ReadonlyMap<string, RuntimeFile>>(new Map())
                    }),
                )
            }),
            switchMap(files => {
                const entries = [...files.values()]
                return entries.length === 0
                    ? of<{ name: string; analysis: FileAnalysis | undefined; error: string | undefined }[]>([])
                    : combineLatest(entries.map(f => f.machine.state$.pipe(
                        map(s => {
                            const data = s.data as { analysis?: FileAnalysis; stale?: FileAnalysis; error?: string }
                            return {
                                name: f.name,
                                analysis: data.analysis ?? data.stale,
                                error: s.node === 'failed' ? data.error : undefined,
                            }
                        }),
                    )))
            }),
            map((fileAnalyses): ActiveGraphData => {
                const graphs: Record<string, SerializedGraphSet> = {}
                const graphKinds: Record<string, GraphKind> = {}
                const transitionKeys: Record<string, string[]> = {}
                const closureResults: Record<string, ClosureResult> = {}
                const errors = [...new Set(fileAnalyses.map(f => f.error).filter((e): e is string => !!e))]

                for (const { name, analysis } of fileAnalyses) {
                    if (!analysis) continue
                    for (const record of analysis.exports) {
                        const runtime = record.runtime
                        if (runtime.status !== 'evaluated') continue
                        if (runtime.kind !== 'graph-set' && runtime.kind !== 'machine') continue
                        const key = `${name}:${record.name}`
                        graphKinds[key] = runtime.kind
                        if (runtime.serialized) graphs[key] = runtime.serialized
                        if (runtime.closure) closureResults[key] = runtime.closure
                        if (runtime.kind === 'machine' && runtime.transitionKeys) transitionKeys[key] = runtime.transitionKeys
                    }
                }

                return { graphs, graphKinds, transitionKeys, closureResults, errors }
            }),
        )
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
    }
}
