import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { Router } from '@yaw-rx/core/router'
import { type Observable, type Subscription, combineLatest, from, map, tap, filter, distinctUntilChanged, switchMap, of, catchError, EMPTY } from 'rxjs'
import type { RunningMachineSet } from '@yaw-rx/ystate'
import { RuntimeFilesystemService } from '../services/runtime-filesystem.service.js'
import { FormRunService } from '../services/form-run.service.js'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'
import type { FileAnalysis } from '../types/serialized-filesystem.types.js'
import type { SerializedGraphSet, ClosureResult, GraphKind } from '../services/sandbox.service.js'
import { ElkLayoutService, type LayoutResult } from '../services/elk-layout.service.js'
import { fileKindOf } from '../utils/file-kind.js'
import { analysisHasErrors } from '../utils/file-status.js'
import '../components/graph-canvas.component.js'
import '../components/code-panel.component.js'
import '../components/form-run-host.component.js'

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
            [runningMachines]="runningMachines"
        ></graph-canvas>
        <div class="divider" onpointerdown="startResize"></div>
        <div class="rhs" [style.width]="codePanelWidthStyle">
            <div class="rhs-toolbar">
                <button class="run-toggle" [class.running]="running" [disabled]="runDisabled" onclick="toggleRun">{{runLabel}}</button>
            </div>
            <code-panel class="fill" [style.display]="editorDisplay" [workspaceName]="activeWorkspace"></code-panel>
            <form-run-host class="fill" [style.display]="runDisplay" [workspaceName]="activeWorkspace" [playing]="running"></form-run-host>
        </div>
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
            width: 6px;
            cursor: col-resize;
            background: var(--border);
            transition: background 0.1s;
            flex-shrink: 0;
            touch-action: none;
            position: relative;
            z-index: 2;
        }
        .divider:hover, .divider.active {
            background: var(--accent);
        }
        .rhs {
            flex-shrink: 0;
            min-width: 200px;
            max-width: 80%;
            display: flex;
            flex-direction: column;
        }
        .rhs-toolbar {
            flex-shrink: 0;
            background: var(--bg-1);
            border-bottom: var(--border-width) solid var(--border);
        }
        /* min-width:0 lets the editor panels shrink with the RHS instead of
           holding their content's intrinsic width (which overflows on shrink). */
        .fill { flex: 1; min-height: 0; min-width: 0; }
        .run-toggle {
            background: none;
            border: none;
            color: var(--success);
            font-family: var(--font-mono);
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: var(--tracking);
            padding: 0.5rem 1rem;
            cursor: pointer;
        }
        .run-toggle.running { color: var(--error); }
        .run-toggle:disabled { color: var(--dim); cursor: not-allowed; }
        .run-toggle:not(:disabled):hover { background: var(--bg-4); }
    `,
})
export class WorkspacePage extends RxElement {
    @Inject(Router) private readonly router!: Router
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService
    @Inject(FormRunService) private readonly formRun!: FormRunService

    @state layoutResult: LayoutResult | null = null
    @state activeWorkspace = ''
    @state codePanelWidth = 420
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}

    // Play/Stop. `running` swaps only the RHS (editor <-> form host) via
    // display, mutually exclusive; the ELK canvas is never swapped, only
    // driven by runningMachines. Each RHS region owns its own terminal.
    @state running = false
    @state runningMachines: RunningMachineSet[] = []
    private subs: Subscription[] = []

    get codePanelWidthStyle$(): Observable<string> {
        return this.codePanelWidth$.pipe(map((w: number) => `${w}px`))
    }

    get editorDisplay$(): Observable<string> {
        return this.running$.pipe(map(r => r ? 'none' : 'flex'))
    }

    get runDisplay$(): Observable<string> {
        return this.running$.pipe(map(r => r ? 'flex' : 'none'))
    }

    get runLabel$(): Observable<string> {
        return this.running$.pipe(map(r => r ? '■ stop' : '▶ play'))
    }

    /** Play is enabled only when the workspace has a form and every file is settled with no errors (analysis or closure) - init() would otherwise throw closing a broken machine. Stop is always enabled. */
    get runDisabled$(): Observable<boolean> {
        return combineLatest([this.running$, this.canRun$]).pipe(map(([running, canRun]) => running ? false : !canRun))
    }

    private get canRun$(): Observable<boolean> {
        return this.activeWorkspaceFiles$.pipe(
            switchMap(files => {
                const entries = [...files.values()]
                const hasForm = entries.some(f => fileKindOf(f.name) === 'form')
                if (!hasForm) return of(false)
                return combineLatest(entries.map(f => f.machine.state$.pipe(
                    map(s => s.node === 'analyzed' && !analysisHasErrors((s.data as { analysis?: FileAnalysis }).analysis)),
                ))).pipe(map(oks => oks.every(Boolean)))
            }),
        )
    }

    private get activeWorkspaceFiles$(): Observable<ReadonlyMap<string, RuntimeFile>> {
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
        )
    }

    toggleRun(): void {
        this.running = !this.running
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

        // The running machines drive the ELK animation. They arrive via the
        // service (not a DOM event) - see FormRunService.runningMachines$.
        this.subs.push(this.formRun.runningMachines$.pipe(
            tap(machines => { this.runningMachines = machines }),
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
            tap(({ graphKinds, transitionKeys, closureResults }) => {
                // Feeds the ELK canvas only. Per-file closure/error terminals
                // live in code-panel (edit) and form-run-host (run).
                this.graphKinds = graphKinds
                this.transitionKeys = transitionKeys
                this.closureResults = closureResults
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
                // Only ts files feed the ELK diagram - forms produce no
                // graph-set/machine exports (their analysis is FormAnalysis).
                const entries = [...files.values()].filter(f => fileKindOf(f.name) === 'ts-file')
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
