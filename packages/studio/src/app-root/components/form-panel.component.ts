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
 * The three sections are sized by *proportion*, not fixed pixels: each is a
 * flex item with `flex-basis: 0` and a grow ratio, so the triad always fills
 * exactly its container and - crucially - shrinks with it. When the terminal
 * below grows and squeezes this panel, all three sections shrink together
 * rather than a fixed-height one overflowing under it.
 *
 * The two dividers between the sections are draggable: each redistributes the
 * grow ratio between the two sections it sits between, leaving the third
 * untouched.
 */
@Component({
    selector: 'form-panel',
    template: `
        <div #templateSection class="section" [style.flex-grow]="ratio0">
            <div class="section-label">template</div>
            <div #templateContainer class="editor"></div>
        </div>
        <div #scriptSection class="section" [style.flex-grow]="ratio1">
            <div class="section-label handle" onpointerdown="startResize($event, 1)">script</div>
            <div #scriptContainer class="editor"></div>
        </div>
        <div #stylesSection class="section" [style.flex-grow]="ratio2">
            <div class="section-label handle" onpointerdown="startResize($event, 2)">styles</div>
            <div #stylesContainer class="editor"></div>
        </div>
    `,
    styles: `
        :host { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
        .section { display: flex; flex-direction: column; min-height: 0; flex-basis: 0; }
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
    // Grow ratios for the three sections (relative, not pixels). Equal by
    // default; a drag shifts weight between two neighbours.
    @state ratios: [number, number, number] = [1, 1, 1]

    templateSection!: HTMLDivElement
    scriptSection!: HTMLDivElement
    stylesSection!: HTMLDivElement
    templateContainer!: HTMLDivElement
    scriptContainer!: HTMLDivElement
    stylesContainer!: HTMLDivElement
    private editors: monaco.editor.IStandaloneCodeEditor[] = []
    private ro: ResizeObserver | undefined
    private subs: Subscription[] = []

    get ratio0$(): Observable<string> {
        return this.ratios$.pipe(map(r => `${r[0]}`))
    }

    get ratio1$(): Observable<string> {
        return this.ratios$.pipe(map(r => `${r[1]}`))
    }

    get ratio2$(): Observable<string> {
        return this.ratios$.pipe(map(r => `${r[2]}`))
    }

    override onRender(): void {
        const template = this.makeEditor(this.templateContainer)
        const script = this.makeEditor(this.scriptContainer)
        const styles = this.makeEditor(this.stylesContainer)
        this.editors = [template, script, styles]

        // Each container resizes when its section's share changes (a drag)
        // or the whole panel resizes; just relayout that editor.
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

    /**
     * Drag the boundary at the top of section `index` (1 = script, 2 =
     * styles), moving weight between it and the section above. Works in real
     * pixels for the two neighbours, then converts back to grow ratios so the
     * split holds proportionally as the whole panel resizes.
     */
    startResize(e: PointerEvent, index: 1 | 2): void {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)

        const sections = [this.templateSection, this.scriptSection, this.stylesSection]
        const above = sections[index - 1]
        const below = sections[index]
        const startY = e.clientY
        const hAbove = above.getBoundingClientRect().height
        const totalH = hAbove + below.getBoundingClientRect().height
        const totalR = this.ratios[index - 1] + this.ratios[index]
        const MIN = 40

        const onMove = (ev: PointerEvent) => {
            // Redistribute only between the two neighbours; their combined
            // ratio (and every other section) stays put.
            const newAbove = Math.max(MIN, Math.min(totalH - MIN, hAbove + (ev.clientY - startY)))
            const rAbove = totalR * (newAbove / totalH)
            const next: [number, number, number] = [...this.ratios]
            next[index - 1] = rAbove
            next[index] = totalR - rAbove
            this.ratios = next
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
