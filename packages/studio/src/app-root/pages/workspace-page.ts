import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { Router } from '@yaw-rx/core/router'
import { type Observable, type Subscription, map, tap, filter, distinctUntilChanged, skip, debounceTime } from 'rxjs'
import { WorkspaceService, type Workspace } from '../services/workspace.service.js'
import type { SandboxResult, ClosureResult, GraphKind } from '../services/sandbox.service.js'
import { WorkspaceEvaluationService } from '../services/workspace-evaluation.service.js'
import { ElkLayoutService, type LayoutResult } from '../services/elk-layout.service.js'
import type { CodePanel } from '../components/code-panel.component.js'
import '../components/graph-canvas.component.js'
import '../components/code-panel.component.js'

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
            [library]="library"
            [workspace]="activeWorkspace"
            [sandboxResult]="sandboxResult"
            [style.width]="codePanelWidthStyle"
            [(contentVersion)]="contentVersion"
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
    @Inject(WorkspaceService) private readonly workspace!: WorkspaceService
    @Inject(WorkspaceEvaluationService) private readonly evaluation!: WorkspaceEvaluationService

    codePanel!: CodePanel

    @state layoutResult: LayoutResult | null = null
    @state library: Workspace[] = []
    @state activeWorkspace = ''
    @state codePanelWidth = 420
    @state sandboxResult: SandboxResult | null = null
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}
    @state contentVersion = 0
    private subs: Subscription[] = []

    get codePanelWidthStyle$(): Observable<string> {
        return this.codePanelWidth$.pipe(map((w: number) => `${w}px`))
    }

    private readonly elkLayout = new ElkLayoutService()
    private evalGeneration = 0

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
            tap((name: string) => this.loadWorkspace(name)),
        ).subscribe())

        this.subs.push(this.contentVersion$.pipe(
            skip(1),
            debounceTime(100),
            tap(() => this.handleContentChange()),
        ).subscribe())
    }

    private handleContentChange(): void {
        const ws = this.workspace.getWorkspace(this.activeWorkspace)
        if (!ws || !this.codePanel) return

        // Sync live editor content back into the workspace's own file objects
        // first, so evaluate(ws) always reads the same authoritative content
        // regardless of which trigger called it.
        for (const file of ws.files) {
            if (this.workspace.kindOf(file.name) !== 'concept') continue
            const live = this.codePanel.getContent(file.name)
            if (live !== undefined) file.content = live
        }

        this.evaluateAndLayout(ws)
    }

    private async loadWorkspace(name: string): Promise<void> {
        const ws = this.workspace.getWorkspace(name)
        if (!ws) return

        this.library = this.workspace.library
        this.activeWorkspace = name

        await this.evaluateAndLayout(ws)
    }

    private async evaluateAndLayout(ws: Workspace): Promise<void> {
        const gen = ++this.evalGeneration
        const result = await this.evaluation.evaluate(ws)
        this.workspace.library$.touch()
        if (gen !== this.evalGeneration) return

        this.sandboxResult = result

        if (!result.ok) return

        this.graphKinds = result.graphKinds
        this.transitionKeys = result.transitionKeys
        this.closureResults = result.closureResults
        this.layoutResult = await this.elkLayout.layout(result.graphs)
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
    }
}
