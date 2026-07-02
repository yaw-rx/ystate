import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { Router } from '@yaw-rx/core/router'
import { type Observable, map, distinctUntilChanged } from 'rxjs'
import { WorkspaceService, type WorkspaceFile } from '../services/workspace.service.js'
import { SandboxService } from '../services/sandbox.service.js'
import { ElkLayoutService, type LayoutResult } from '../services/elk-layout.service.js'
import '../components/graph-canvas.component.js'
import '../components/code-panel.component.js'

@Component({
    selector: 'workspace-page',
    template: `
        <graph-canvas class="canvas-area" [layout]="layoutResult"></graph-canvas>
        <div class="divider" onpointerdown="startResize"></div>
        <code-panel class="code-area" [files]="workspaceFiles" [style.width]="codePanelWidthStyle"></code-panel>
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

    @state layoutResult: LayoutResult | null = null
    @state workspaceFiles: WorkspaceFile[] = []
    @state codePanelWidth = 420

    get codePanelWidthStyle$(): Observable<string> {
        return this.codePanelWidth$.pipe(map((w: number) => `${w}px`))
    }

    private readonly sandbox = new SandboxService()
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
        this.router.route$.pipe(
            map((route: string) => {
                const prefix = '/workspace/'
                return route.startsWith(prefix) ? route.slice(prefix.length) : ''
            }),
            distinctUntilChanged(),
        ).subscribe((name: string) => {
            if (name) this.loadWorkspace(name)
        })
    }

    private async loadWorkspace(name: string): Promise<void> {
        const ws = this.workspace.getWorkspace(name)
        if (!ws) return

        this.workspaceFiles = ws.files

        const conceptFiles = ws.files.filter(
            f => this.workspace.kindOf(f.name) === 'concept',
        )

        try {
            const result = await this.sandbox.evaluate(conceptFiles)
            this.layoutResult = await this.elkLayout.layout(result.exports)
        } catch (e) {
            console.error('Sandbox evaluation failed:', e)
        }
    }

    override onDestroy(): void {
        this.sandbox.dispose()
    }
}
