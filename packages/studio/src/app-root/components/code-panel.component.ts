import { Component, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import * as monaco from 'monaco-editor'
import type { Observable, Subscription } from 'rxjs'
import { map, tap, combineLatest, distinctUntilChanged } from 'rxjs'
import type { Workspace, WorkspaceFile } from '../services/workspace.service.js'
import type { SandboxResult } from '../services/sandbox.service.js'
import dtsBundle from 'virtual:dts-bundle'
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
    @state library: Workspace[] = []
    @state workspace = ''
    @state activeTab = ''
    @state activeFiles: WorkspaceFile[] = []
    @state sandboxResult: SandboxResult | null = null

    editorContainer!: HTMLDivElement
    outputPanel!: OutputPanel
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private models = new Map<string, monaco.editor.ITextModel>()
    private modelDisposables: monaco.IDisposable[] = []
    @state outputExpanded = false;
    @state outputHeight = 200;
    @state contentVersion = 0;
    private ro: ResizeObserver | undefined;
    private subs: Subscription[] = [];
    private static tsConfigured = false;

    override onRender(): void {
        if (!CodePanel.tsConfigured) {
            CodePanel.tsConfigured = true
            CodePanel.configureTypeScript()
        }

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

        this.subs.push(combineLatest([this.library$, this.workspace$]).pipe(
            tap(([library, workspace]) => {
                this.rebuildModels(library)
                const ws = library.find(w => w.name === workspace)
                this.activeFiles = ws?.files ?? []
                if (!this.activeTab && this.activeFiles.length > 0) {
                    this.activeTab = this.activeFiles[0].name
                }
            }),
        ).subscribe())

        this.subs.push(this.activeTab$.pipe(
            distinctUntilChanged(),
            tap((tab: string) => {
                const key = `${this.workspace}/${tab}`
                const model = this.models.get(key)
                if (model && this.editor) this.editor.setModel(model)
            }),
        ).subscribe())

        this.addEventListener('toggle-output', () => this.toggleOutput());
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
        this.ro?.disconnect();
        this.editor?.dispose();
        for (const d of this.modelDisposables) d.dispose();
        this.modelDisposables = [];
        for (const model of this.models.values()) model.dispose();
        this.models.clear();
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

    getContent(fileName: string): string | undefined {
        const key = `${this.workspace}/${fileName}`
        return this.models.get(key)?.getValue()
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

    private rebuildModels(library: Workspace[]): void {
        for (const d of this.modelDisposables) d.dispose()
        this.modelDisposables = []
        for (const model of this.models.values()) model.dispose()
        this.models.clear()

        console.group('[code-panel] model registration')
        for (const ws of library) {
            for (const file of ws.files) {
                const key = `${ws.name}/${file.name}`
                const uri = monaco.Uri.parse(`file:///${key}`)
                const lang = file.name.endsWith('.html') ? 'html'
                    : file.name.endsWith('.json') ? 'json'
                    : 'typescript'
                const model = monaco.editor.createModel(file.content, lang, uri)
                this.models.set(key, model)
                this.modelDisposables.push(model.onDidChangeContent(() => this.contentVersion++))
                console.log(`model: ${uri.toString()} (${lang})`)
            }
        }
        console.log(`${this.models.size} models total`)
        console.groupEnd()
    }

    private static configureTypeScript(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tsLang = (monaco.languages as any).typescript
        const defaults = tsLang.typescriptDefaults

        defaults.setCompilerOptions({
            target: 9 /* ES2022 */,
            module: 199 /* NodeNext */,
            moduleResolution: 99 /* NodeNext */,
            strict: true,
            esModuleInterop: true,
            allowNonTsExtensions: true,
        })

        console.group('[code-panel] dts-bundle registration')
        let count = 0
        for (const [pkg, files] of Object.entries(dtsBundle)) {
            const paths = Object.keys(files)
            console.log(`${pkg}: ${paths.length} files`, paths.slice(0, 5))
            for (const [path, content] of Object.entries(files)) {
                defaults.addExtraLib(content, `file:///${path}`)
                count++
            }
        }
        console.log(`registered ${count} total .d.ts files`)
        console.groupEnd()
    }
}
