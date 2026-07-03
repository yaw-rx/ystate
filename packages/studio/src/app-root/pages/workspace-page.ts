import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { Router } from '@yaw-rx/core/router'
import { type Observable, map, distinctUntilChanged } from 'rxjs'
import { WorkspaceService, type Workspace } from '../services/workspace.service.js'
import { SandboxService, type SandboxResult, type ClosureResult, type GraphKind } from '../services/sandbox.service.js'
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

    codePanel!: CodePanel

    @state layoutResult: LayoutResult | null = null
    @state library: Workspace[] = []
    @state activeWorkspace = ''
    @state codePanelWidth = 420
    @state sandboxResult: SandboxResult | null = null
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}

    get codePanelWidthStyle$(): Observable<string> {
        return this.codePanelWidth$.pipe(map((w: number) => `${w}px`))
    }

    private readonly sandbox = new SandboxService()
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
        this.router.route$.pipe(
            map((route: string) => {
                const prefix = '/workspace/'
                return route.startsWith(prefix) ? route.slice(prefix.length) : ''
            }),
            distinctUntilChanged(),
        ).subscribe((name: string) => {
            if (name) this.loadWorkspace(name)
        })

        this.addEventListener('content-change', () => this.handleContentChange())
    }

    private handleContentChange(): void {
        const ws = this.workspace.getWorkspace(this.activeWorkspace)
        if (!ws || !this.codePanel) return

        const conceptFiles = ws.files
            .filter(f => this.workspace.kindOf(f.name) === 'concept')
            .map(f => ({ name: f.name, content: this.codePanel.getContent(f.name) ?? f.content }))

        this.evaluateAndLayout(conceptFiles)
    }

    private async loadWorkspace(name: string): Promise<void> {
        const ws = this.workspace.getWorkspace(name)
        if (!ws) return

        this.library = this.workspace.library
        this.activeWorkspace = name

        const conceptFiles = ws.files.filter(
            f => this.workspace.kindOf(f.name) === 'concept',
        )

        await this.evaluateAndLayout(conceptFiles)
    }

    private async evaluateAndLayout(files: { name: string; content: string }[]): Promise<void> {
        const gen = ++this.evalGeneration
        const result = await this.sandbox.evaluate(files)
        if (gen !== this.evalGeneration) return

        this.sandboxResult = result

        if (!result.ok) return

        this.graphKinds = result.graphKinds
        this.transitionKeys = result.transitionKeys
        this.closureResults = result.closureResults
        this.layoutResult = await this.elkLayout.layout(result.exports)
    }

    override onDestroy(): void {
        this.sandbox.dispose()
    }
}
