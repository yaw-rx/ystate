import { Component, RxElement, state } from '@yaw-rx/core'
import * as monaco from 'monaco-editor'
import { tap, type Subscription } from 'rxjs'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'

/**
 * One Monaco editor bound to a single file's model. The active-file swap
 * lives in the parent (code-panel); this just attaches whatever `file` it
 * is given. A plain ts file uses one of these; a form's script uses one
 * inside the triad (form-panel).
 */
@Component({
    selector: 'file-editor',
    template: `<div #container class="container"></div>`,
    styles: `
        :host { display: block; height: 100%; }
        .container { width: 100%; height: 100%; overflow: hidden; }
    `,
})
export class FileEditor extends RxElement {
    @state file: RuntimeFile | null = null

    container!: HTMLDivElement
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private ro: ResizeObserver | undefined
    private subs: Subscription[] = []

    override onRender(): void {
        this.editor = monaco.editor.create(this.container, {
            theme: 'vs-dark',
            fontSize: 13,
            fontFamily: 'monospace',
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: false,
            tabSize: 2,
        })
        this.ro = new ResizeObserver(() => this.editor?.layout())
        this.ro.observe(this.container)

        this.subs.push(this.file$.pipe(
            // Clear to null when there's no file (e.g. mid-rename, when the
            // old file is gone from the map before the new tab is active) so
            // the editor never holds a just-disposed model.
            tap(file => this.editor?.setModel(file?.model ?? null)),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
        this.ro?.disconnect()
        this.editor?.dispose()
    }
}
