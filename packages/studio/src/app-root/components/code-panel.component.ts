import { Component, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import * as monaco from 'monaco-editor'
import type { Observable } from 'rxjs'
import { map, combineLatest, distinctUntilChanged } from 'rxjs'
import type { Workspace, WorkspaceFile } from '../services/workspace.service.js'
import dtsBundle from 'virtual:dts-bundle'

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
    @state library: Workspace[] = []
    @state workspace = ''
    @state activeTab = ''
    @state activeFiles: WorkspaceFile[] = []

    editorContainer!: HTMLDivElement
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private models = new Map<string, monaco.editor.ITextModel>()
    private ro: ResizeObserver | undefined
    private static tsConfigured = false

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

        combineLatest([this.library$, this.workspace$]).subscribe(
            ([library, workspace]) => {
                this.rebuildModels(library)
                const ws = library.find(w => w.name === workspace)
                this.activeFiles = ws?.files ?? []
                if (!this.activeTab && this.activeFiles.length > 0) {
                    this.activeTab = this.activeFiles[0].name
                }
            },
        )

        this.activeTab$.pipe(distinctUntilChanged()).subscribe((tab: string) => {
            const key = `${this.workspace}/${tab}`
            const model = this.models.get(key)
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
        const key = `${this.workspace}/${fileName}`
        return this.models.get(key)?.getValue()
    }

    private rebuildModels(library: Workspace[]): void {
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
