import { Component, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import * as monaco from 'monaco-editor'
import type { Observable } from 'rxjs'
import { map, distinctUntilChanged } from 'rxjs'
import type { WorkspaceFile } from '../services/workspace.service.js'

@Component({
    selector: 'code-panel',
    directives: [RxFor],
    template: `
        <div class="tabs" rx-for="file of files by name">
            <button
                class="tab"
                [class.active]="isActiveTab(file.name)"
                onclick="selectTab(file.name)"
            >{{file.name}}</button>
        </div>
        <div #editorContainer class="editor-container"></div>
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
    `,
})
export class CodePanel extends RxElement {
    @state files: WorkspaceFile[] = []
    @state activeTab = ''

    editorContainer!: HTMLDivElement
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private models = new Map<string, monaco.editor.ITextModel>()
    private ro: ResizeObserver | undefined

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

        this.files$.subscribe(files => {
            this.syncModels(files)
            if (!this.activeTab && files.length > 0) {
                this.activeTab = files[0].name
            }
        })

        this.activeTab$.pipe(distinctUntilChanged()).subscribe((tab: string) => {
            const model = this.models.get(tab)
            if (model && this.editor) this.editor.setModel(model)
        })
    }

    override onDestroy(): void {
        this.ro?.disconnect()
        this.editor?.dispose()
        for (const model of this.models.values()) model.dispose()
        this.models.clear()
    }

    isActiveTab(name: string): Observable<boolean> {
        return this.activeTab$.pipe(map(t => t === name))
    }

    selectTab(name: string): void {
        this.activeTab = name
    }

    getContent(fileName: string): string | undefined {
        return this.models.get(fileName)?.getValue()
    }

    private syncModels(files: WorkspaceFile[]): void {
        const fileNames = new Set(files.map(f => f.name))

        for (const [name, model] of this.models) {
            if (!fileNames.has(name)) {
                model.dispose()
                this.models.delete(name)
            }
        }

        for (const file of files) {
            if (!this.models.has(file.name)) {
                const uri = monaco.Uri.parse(`file:///${file.name}`)
                const lang = file.name.endsWith('.html') ? 'html'
                    : file.name.endsWith('.json') ? 'json'
                    : 'typescript'
                const model = monaco.editor.createModel(file.content, lang, uri)
                this.models.set(file.name, model)
            }
        }
    }
}
