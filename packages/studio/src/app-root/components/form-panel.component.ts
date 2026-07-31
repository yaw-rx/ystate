import { Component, RxElement, state } from '@yaw-rx/core'
import * as monaco from 'monaco-editor'
import { map, tap, type Observable, type Subscription } from 'rxjs'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'

/**
 * A form's triad editor: three stacked Monaco editors over the form's three
 * live section models - template (html), script (the .ts content itself),
 * styles (css). Editing any writes straight to the model, the source of
 * truth the pool analysis and the run compiler both read.
 *
 * The two dividers between the sections are draggable: each sets the pixel
 * height of the section above it (the bottom section takes the remainder),
 * so all three are freely resizable.
 */
@Component({
    selector: 'form-panel',
    template: `
        <div class="section" [style.height]="templateHeight">
            <div class="section-label">template</div>
            <div #templateContainer class="editor"></div>
        </div>
        <div class="section" [style.height]="scriptHeight">
            <div class="section-label handle" onpointerdown="startResize($event, 0)">script</div>
            <div #scriptContainer class="editor"></div>
        </div>
        <div class="section fill">
            <div class="section-label handle" onpointerdown="startResize($event, 1)">styles</div>
            <div #stylesContainer class="editor"></div>
        </div>
    `,
    styles: `
        :host { display: flex; flex-direction: column; height: 100%; }
        .section { display: flex; flex-direction: column; min-height: 0; flex-shrink: 0; }
        .section.fill { flex: 1; }
        .section-label {
            flex-shrink: 0;
            font-family: var(--font-mono);
            font-size: 0.6rem;
            text-transform: uppercase;
            letter-spacing: var(--tracking);
            color: var(--dim);
            padding: 0.35rem 0.75rem;
            background: var(--bg-1);
            border-top: 1px solid var(--border);
        }
        /* The header IS the resize handle - grab a section's title bar and
           drag to move its top boundary. Big, obvious, un-coverable (it
           sits above the editor, not over Monaco's overlays). */
        .section-label.handle {
            cursor: row-resize;
            user-select: none;
            touch-action: none;
        }
        .section-label.handle::before {
            content: '⋯ ';
            color: var(--border);
        }
        .section-label.handle:hover {
            color: var(--accent);
            background: var(--bg-4);
        }
        .editor { flex: 1; min-height: 0; overflow: hidden; }
    `,
})
export class FormPanel extends RxElement {
    @state file: RuntimeFile | null = null
    // Pixel heights of the first two sections; the third fills the rest.
    @state heights: [number, number] = [220, 220]

    templateContainer!: HTMLDivElement
    scriptContainer!: HTMLDivElement
    stylesContainer!: HTMLDivElement
    private editors: monaco.editor.IStandaloneCodeEditor[] = []
    private ro: ResizeObserver | undefined
    private subs: Subscription[] = []

    get templateHeight$(): Observable<string> {
        return this.heights$.pipe(map(h => `${h[0]}px`))
    }

    get scriptHeight$(): Observable<string> {
        return this.heights$.pipe(map(h => `${h[1]}px`))
    }

    override onRender(): void {
        const template = this.makeEditor(this.templateContainer)
        const script = this.makeEditor(this.scriptContainer)
        const styles = this.makeEditor(this.stylesContainer)
        this.editors = [template, script, styles]

        // Each container resizes when its section height changes; relayout
        // that editor rather than tracking heights a second time.
        this.ro = new ResizeObserver(() => this.editors.forEach(e => e.layout()))
        for (const c of [this.templateContainer, this.scriptContainer, this.stylesContainer]) this.ro.observe(c)

        this.subs.push(this.file$.pipe(
            tap(file => {
                if (!file?.sections) return
                template.setModel(file.sections.template.model)
                script.setModel(file.model)
                styles.setModel(file.sections.styles.model)
            }),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
        this.ro?.disconnect()
        this.editors.forEach(e => e.dispose())
        this.editors = []
    }

    startResize(e: PointerEvent, index: 0 | 1): void {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)
        const startY = e.clientY
        const startH = this.heights[index]

        const onMove = (ev: PointerEvent) => {
            const next: [number, number] = [...this.heights]
            next[index] = Math.max(60, startH + (ev.clientY - startY))
            this.heights = next
        }
        const onUp = () => {
            target.removeEventListener('pointermove', onMove)
            target.removeEventListener('pointerup', onUp)
        }
        target.addEventListener('pointermove', onMove)
        target.addEventListener('pointerup', onUp)
    }

    private makeEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
        return monaco.editor.create(container, {
            theme: 'vs-dark',
            fontSize: 13,
            fontFamily: 'monospace',
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: false,
            tabSize: 2,
        })
    }
}
