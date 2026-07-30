import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import * as monaco from 'monaco-editor'
import type { Observable, Subscription } from 'rxjs'
import { map, tap, combineLatest, switchMap, distinctUntilChanged, of } from 'rxjs'
import { RuntimeFilesystemService } from '../services/runtime-filesystem.service.js'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'
import type { SandboxResult } from '../services/sandbox.service.js'
import { fileKindOf } from '../utils/file-kind.js'
import './output-panel.component.js'
import type { OutputPanel } from './output-panel.component.js'

@Component({
    selector: 'code-panel',
    directives: [RxFor],
    template: `
        <div class="tabs" rx-for="file of activeFiles by name">
            <button
                class="tab"
                [class.active]="isActiveTab(file.name)"
                onclick="selectTab(file.name)"
            >{{file.name}}</button>
        </div>
        <div #editorContainer class="editor-container"></div>
        <div class="output-divider" onpointerdown="startOutputResize"></div>
        <output-panel #outputPanel [sandboxResult]="sandboxResult" [expanded]="outputExpanded" [style.height]="outputPanelHeight"></output-panel>
    `,
    styles: `
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            background: var(--bg-2);
        }
        .tabs {
            display: flex;
            border-bottom: var(--border-width) solid var(--border);
            background: var(--bg-1);
            overflow-x: auto;
            flex-shrink: 0;
        }
        .tab {
            background: none;
            border: none;
            border-right: var(--border-width) solid var(--border);
            color: var(--dim);
            font-family: var(--font-mono);
            font-size: 0.75rem;
            padding: 0.5rem 1rem;
            cursor: pointer;
            white-space: nowrap;
            transition: color 0.1s, background 0.1s;
        }
        .tab:hover {
            color: var(--text);
            background: var(--bg-4);
        }
        .tab.active {
            color: var(--accent);
            background: var(--bg-3);
            border-bottom: 2px solid var(--accent);
        }
        .editor-container {
            flex: 1;
            overflow: hidden;
        }
        .output-divider {
            height: 4px;
            background: var(--bg-1);
            border-top: 1px solid var(--border);
            cursor: ns-resize;
            flex-shrink: 0;
            user-select: none;
        }
        .output-divider:hover {
            border-top-color: var(--accent);
        }
    `,
})
export class CodePanel extends RxElement {
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService

    @state workspaceName = ''
    @state activeTab = ''
    @state activeFiles: RuntimeFile[] = []
    @state sandboxResult: SandboxResult | null = null

    editorContainer!: HTMLDivElement
    outputPanel!: OutputPanel
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    @state outputExpanded = false;
    @state outputHeight = 200;
    private ro: ResizeObserver | undefined;
    private subs: Subscription[] = [];

    override onRender(): void {
        this.editor = monaco.editor.create(this.editorContainer, {
            theme: 'vs-dark',
            language: 'typescript',
            fontSize: 13,
            fontFamily: 'monospace',
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: false,
            tabSize: 2,
        })

        this.ro = new ResizeObserver(() => this.editor?.layout())
        this.ro.observe(this.editorContainer)

        this.subs.push(this.filesForWorkspace$.pipe(
            tap((files: RuntimeFile[]) => {
                this.activeFiles = files
                if (!this.activeTab && files.length > 0) {
                    this.activeTab = files[0].name
                }
            }),
        ).subscribe())

        this.subs.push(combineLatest([this.activeFiles$, this.activeTab$]).pipe(
            map(([files, tab]) => files.find(f => f.name === tab)),
            distinctUntilChanged(),
            tap((file) => {
                if (file && this.editor) this.editor.setModel(file.model)
            }),
        ).subscribe())

        this.addEventListener('toggle-output', () => this.toggleOutput());
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
        this.ro?.disconnect();
        this.editor?.dispose();
    }

    private get filesForWorkspace$(): Observable<RuntimeFile[]> {
        return this.workspaceName$.pipe(
            switchMap(name => {
                if (!name) return of<ReadonlyMap<string, RuntimeFile>>(new Map())
                return this.filesystem.workspaces$.pipe(
                    switchMap(workspaces => {
                        const ws = workspaces.get(name)
                        return ws ? ws.files$ : of<ReadonlyMap<string, RuntimeFile>>(new Map())
                    }),
                )
            }),
            map(files => [...files.values()].filter(f => fileKindOf(f.name) === 'ts-file')),
        )
    }

    get outputPanelHeight(): Observable<string> {
        return combineLatest([this.outputExpanded$, this.outputHeight$]).pipe(
            map(([exp, h]: [boolean, number]) => exp ? `${h}px` : ''),
        )
    }

    isActiveTab(name: string): Observable<boolean> {
        return this.activeTab$.pipe(map(t => t === name))
    }

    selectTab(name: string): void {
        this.activeTab = name
    }

    private layoutEditor(): void {
        requestAnimationFrame(() => this.editor?.layout())
    }

    private toggleOutput(): void {
        this.outputExpanded = !this.outputExpanded
        if (this.outputExpanded && this.outputHeight < 200) {
            this.outputHeight = 200
        }
        this.layoutEditor()
    }

    startOutputResize(e: PointerEvent): void {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)
        const wasCollapsed = !this.outputExpanded
        if (wasCollapsed) {
            this.outputExpanded = true
            this.outputHeight = 28
        }
        const startY = e.clientY
        const startH = wasCollapsed ? 28 : this.outputHeight

        const onMove = (ev: PointerEvent) => {
            this.outputHeight = Math.max(28, startH + (startY - ev.clientY))
            this.layoutEditor()
        }
        const onUp = () => {
            target.removeEventListener('pointermove', onMove)
            target.removeEventListener('pointerup', onUp)
            if (this.outputHeight <= 28) {
                this.outputExpanded = false
            }
            this.layoutEditor()
        }
        target.addEventListener('pointermove', onMove)
        target.addEventListener('pointerup', onUp)
    }
}
