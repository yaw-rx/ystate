import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { type Observable, type Subscription, map, tap, combineLatest, switchMap, of } from 'rxjs'
import { RuntimeFilesystemService } from '../services/runtime-filesystem.service.js'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'
import type { FileAnalysis, FormAnalysis, FormAttachment } from '../types/serialized-filesystem.types.js'
import type { SandboxResult, ClosureResult, GraphKind } from '../services/sandbox.service.js'
import type { FormReport } from './output-panel.component.js'
import { fileKindOf } from '../utils/file-kind.js'
import './file-editor.component.js'
import './form-panel.component.js'
import './output-panel.component.js'

const cssVar = (name: string): string => `var(--${name})`

// How each attachment kind binds in a yaw template - the full "rules" set:
// data (subscribed), signal (also a .next target), handler (event), static
// (bound once), blueprint (not bindable, only an init() input).
const BINDING_LABEL: Record<FormAttachment['kind'], string> = {
    observable: 'data',
    'behavior-subject': 'data + signal',
    function: 'handler',
    'plain-value': 'static',
    machine: 'blueprint',
    'graph-set': 'blueprint',
    'running-machine': 'machine',
}

/**
 * The edit region of the RHS (matches app-root.ts's sketch): one tab row
 * over every file in the workspace - ts files and forms side by side. The
 * active tab decides the editor: a ts file shows a single `file-editor`, a
 * form shows the triad `form-panel`. One terminal at the bottom shows the
 * active file's analysis - closure results for a ts file, the same for a
 * form's script (a form is a .ts file too).
 *
 * Play swaps this whole region out for the run host (see workspace-page);
 * this component knows nothing about running.
 */
@Component({
    selector: 'code-panel',
    directives: [RxFor],
    template: `
        <div class="tabs">
            <div class="tab-scroll">
                <div class="tab-list" rx-for="file of files by name">
                    <div class="tab-slot">
                        <button class="tab" [class.active]="isActiveTab(file.name)" [style.display]="tabButtonDisplay(file.name)" onclick="selectTab(file.name)" ondblclick="startRename($event, file.name)">{{file.name}}</button>
                        <span class="tab-edit" [style.display]="tabInputDisplay(file.name)">
                            <input class="tab-input" [value]="baseOf(file.name)" oninput="autosize($event)" onkeydown="onRenameKey($event, file.name)" onblur="cancelEdit" />
                            <span class="tab-ext">{{extOf(file.name)}}</span>
                        </span>
                    </div>
                </div>
                <span class="tab-edit" [style.display]="draftDisplay">
                    <input #draftInput class="tab-input" oninput="autosize($event)" onkeydown="onNewKey($event)" onblur="cancelEdit" placeholder="name" />
                    <span class="tab-ext">{{draftExt}}</span>
                </span>
            </div>
            <div class="add-tab">
                <button class="tab-add" onclick="toggleMenu" title="New file">+</button>
                <div class="add-menu" [style.display]="menuDisplay">
                    <button class="add-menu-item" onclick="newFile('ts-file')">ts file</button>
                    <button class="add-menu-item" onclick="newFile('form')">form</button>
                </div>
            </div>
        </div>
        <div class="body">
            <file-editor [style.display]="tsDisplay" [file]="activeFile"></file-editor>
            <form-panel [style.display]="formDisplay" [file]="activeFile"></form-panel>
        </div>
        <output-panel [sandboxResult]="terminalResult" [formReports]="formReports"></output-panel>
    `,
    styles: `
        :host { display: flex; flex-direction: column; height: 100%; background: var(--bg-2); }
        .tabs { display: flex; border-bottom: var(--border-width) solid var(--border); background: var(--bg-1); flex-shrink: 0; }
        /* Tabs scroll horizontally with no visible scrollbar; the + stays pinned. */
        .tab-scroll { display: flex; overflow-x: auto; scrollbar-width: none; min-width: 0; }
        .tab-scroll::-webkit-scrollbar { display: none; }
        .tab-list { display: flex; }
        .tab-slot { display: flex; }
        .tab { background: none; border: none; border-right: var(--border-width) solid var(--border); color: var(--dim); font-family: var(--font-mono); font-size: 0.75rem; padding: 0.5rem 1rem; cursor: pointer; white-space: nowrap; transition: color 0.1s, background 0.1s; }
        .tab:hover { color: var(--text); background: var(--bg-4); }
        .tab.active { color: var(--accent); background: var(--bg-3); border-bottom: 2px solid var(--accent); }
        /* Editable base + immutable extension shown as a blue suffix. The
           input auto-grows to its content (see autosize), so nothing is
           hidden and there's a sensible minimum width. */
        .tab-edit { display: inline-flex; align-items: center; background: var(--bg-3); border: 1px solid var(--accent); padding: 0 0.5rem; }
        .tab-input { background: none; border: none; color: var(--text); font-family: var(--font-mono); font-size: 0.75rem; padding: 0.4rem 0; min-width: 4ch; outline: none; }
        .tab-ext { color: var(--accent); font-family: var(--font-mono); font-size: 0.75rem; white-space: nowrap; }
        .add-tab { position: relative; flex-shrink: 0; border-left: var(--border-width) solid var(--border); }
        .tab-add { background: none; border: none; color: var(--dim); font-size: 1rem; line-height: 1; padding: 0.4rem 0.7rem; cursor: pointer; }
        .tab-add:hover { color: var(--accent); background: var(--bg-4); }
        .add-menu { position: absolute; top: 100%; right: 0; z-index: 10; background: var(--bg-1); border: var(--border-width) solid var(--border); border-radius: var(--radius-sm); display: flex; flex-direction: column; min-width: 6rem; }
        .add-menu-item { background: none; border: none; color: var(--text); font-family: var(--font-mono); font-size: 0.72rem; text-align: left; padding: 0.4rem 0.7rem; cursor: pointer; }
        .add-menu-item:hover { background: var(--bg-4); color: var(--accent); }
        .body { flex: 1; min-height: 0; min-width: 0; display: flex; }
        .body > * { flex: 1; min-height: 0; min-width: 0; }
    `,
})
export class CodePanel extends RxElement {
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService

    @state workspaceName = ''
    @state activeTab = ''
    @state files: RuntimeFile[] = []
    @state activeFile: RuntimeFile | null = null
    @state terminalResult: SandboxResult | null = null
    @state formReports: FormReport[] = []
    // Inline tab editing: '' none, a file name when renaming it, '__new__'
    // when naming a new file (its kind held in draftKind).
    @state editing = ''
    @state draftKind = ''
    @state menuOpen = false
    draftInput!: HTMLInputElement
    private subs: Subscription[] = []

    override onInit(): void {
        // Tab list: every file in the workspace, ts and form alike.
        this.subs.push(this.filesForWorkspace$.pipe(
            tap(files => {
                this.files = files
                if (!this.activeTab && files.length > 0) this.activeTab = files[0].name
            }),
        ).subscribe())

        this.subs.push(combineLatest([this.files$, this.activeTab$]).pipe(
            map(([files, tab]) => files.find(f => f.name === tab) ?? null),
            tap(file => { this.activeFile = file }),
        ).subscribe())

        // One terminal, mode by active tab: a ts tab shows that file's
        // closures; a form tab shows the whole form pool report. Exactly
        // one of the two inputs is populated, so the panel renders one view.
        this.subs.push(this.activeFile$.pipe(
            switchMap(file => {
                if (!file) return of({ ts: null as SandboxResult | null, forms: [] as FormReport[] })
                if (fileKindOf(file.name) === 'form') {
                    return this.formPoolReports$.pipe(map(forms => ({ ts: null as SandboxResult | null, forms })))
                }
                return file.machine.state$.pipe(map(s => ({ ts: this.terminalFor(file, s), forms: [] as FormReport[] })))
            }),
            tap(({ ts, forms }) => { this.terminalResult = ts; this.formReports = forms }),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
    }

    isActiveTab(name: string): Observable<boolean> {
        return this.activeTab$.pipe(map(t => t === name))
    }

    selectTab(name: string): void {
        this.activeTab = name
    }

    // --- Tab add / rename ---

    /** The immutable extension (`.ts` or `.form`) - a rename edits only the base, never the kind. */
    extOf(name: string): string {
        return name.endsWith('.form') ? '.form' : '.ts'
    }

    baseOf(name: string): string {
        return name.slice(0, -this.extOf(name).length)
    }

    get draftExt$(): Observable<string> {
        return this.draftKind$.pipe(map(k => k === 'form' ? '.form' : '.ts'))
    }

    /** Grow the input to fit its text (with a small minimum) so nothing is clipped. */
    autosize(e: Event): void {
        const input = e.target as HTMLInputElement
        input.style.width = `${Math.max(4, input.value.length + 1)}ch`
    }

    tabButtonDisplay(name: string): Observable<string> {
        return this.editing$.pipe(map(e => e === name ? 'none' : ''))
    }

    tabInputDisplay(name: string): Observable<string> {
        return this.editing$.pipe(map(e => e === name ? '' : 'none'))
    }

    get draftDisplay$(): Observable<string> {
        return this.editing$.pipe(map(e => e === '__new__' ? '' : 'none'))
    }

    get menuDisplay$(): Observable<string> {
        return this.menuOpen$.pipe(map(o => o ? '' : 'none'))
    }

    toggleMenu(): void {
        this.menuOpen = !this.menuOpen
    }

    newFile(kind: string): void {
        this.draftKind = kind
        this.editing = '__new__'
        this.menuOpen = false
        // The draft input is a single reused element - clear whatever was
        // typed last so a new file never starts with a stale name.
        requestAnimationFrame(() => {
            this.draftInput.value = ''
            this.focusInput(this.draftInput)
        })
    }

    startRename(e: Event, name: string): void {
        this.editing = name
        // The rename input is this tab's own sibling - reach it from the
        // clicked tab, not a host-wide query.
        const slot = (e.currentTarget as HTMLElement).parentElement
        requestAnimationFrame(() => this.focusInput(slot?.querySelector('input')))
    }

    private focusInput(input: HTMLInputElement | null | undefined): void {
        if (!input) return
        input.focus()
        input.select()
        input.style.width = `${Math.max(4, input.value.length + 1)}ch`
    }

    cancelEdit(): void {
        this.editing = ''
        this.menuOpen = false
    }

    onRenameKey(e: KeyboardEvent, oldName: string): void {
        if (e.key === 'Escape') { this.cancelEdit(); return }
        if (e.key !== 'Enter') return
        const base = (e.target as HTMLInputElement).value.trim()
        this.editing = ''
        if (!base) return
        const newName = base + this.extOf(oldName)
        if (newName === oldName) return
        this.filesystem.renameFile(this.workspaceName, oldName, newName)
        if (this.activeTab === oldName) this.activeTab = newName
    }

    onNewKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') { this.cancelEdit(); return }
        if (e.key !== 'Enter') return
        const base = (e.target as HTMLInputElement).value.trim()
        this.editing = ''
        if (!base) return
        const name = base + (this.draftKind === 'form' ? '.form' : '.ts')
        this.filesystem.addFile(this.workspaceName, name)
        this.activeTab = name
    }

    // 'flex'/'block', not overriding each component's own :host display with
    // a wrong value - form-panel is a flex column, so hiding must toggle
    // between its real display and 'none', never 'block'.
    get tsDisplay$(): Observable<string> {
        return this.activeFile$.pipe(map(f => f && fileKindOf(f.name) === 'ts-file' ? 'block' : 'none'))
    }

    get formDisplay$(): Observable<string> {
        return this.activeFile$.pipe(map(f => f && fileKindOf(f.name) === 'form' ? 'flex' : 'none'))
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
            map(files => [...files.values()].filter(f => fileKindOf(f.name) !== undefined)),
        )
    }

    /**
     * A ts file's analysis as a SandboxResult the terminal renders. The ONLY
     * error here is a runtime evaluation failure (the `failed` node - the
     * sandbox threw, e.g. a reference error). Compile-time diagnostics are a
     * separate concern (Monaco's own red squiggles) and must NEVER block the
     * closure results: a type error must not hide the machine/graph closure
     * report. Otherwise the closures are shown as-is.
     */
    private terminalFor(file: RuntimeFile, s: { node: string; data: unknown }): SandboxResult {
        const data = s.data as { analysis?: FileAnalysis; stale?: FileAnalysis; error?: string }
        if (s.node === 'failed') return { ok: false, error: data.error ?? 'evaluation failed' }

        const analysis = data.analysis ?? data.stale
        const closureResults: Record<string, ClosureResult> = {}
        const graphKinds: Record<string, GraphKind> = {}
        for (const record of analysis?.exports ?? []) {
            const runtime = record.runtime
            if (runtime.status !== 'evaluated') continue
            if (runtime.kind !== 'graph-set' && runtime.kind !== 'machine') continue
            const key = `${file.name}:${record.name}`
            graphKinds[key] = runtime.kind
            if (runtime.closure) closureResults[key] = runtime.closure
        }
        return { ok: true, runtimeKinds: {}, graphs: {}, graphKinds, transitionKeys: {}, closureResults }
    }

    /** The whole form pool - every form in the workspace and its analysis - for the form-tab terminal view. */
    private get formPoolReports$(): Observable<FormReport[]> {
        return this.files$.pipe(
            switchMap(files => {
                const forms = files.filter(f => fileKindOf(f.name) === 'form')
                if (forms.length === 0) return of<FormReport[]>([])
                return combineLatest(forms.map(f => f.machine.state$.pipe(map(s => this.formReportFor(f, s)))))
            }),
        )
    }

    private formReportFor(file: RuntimeFile, s: { node: string; data: unknown }): FormReport {
        const data = s.data as { analysis?: FormAnalysis; stale?: FormAnalysis }
        const analysis = data.analysis ?? data.stale
        if (!analysis) return { name: file.name, color: cssVar('dim'), viable: true, errors: [], machines: [], attachments: [] }

        const errors = analysis.diagnostics
            .filter(d => d.category === 'error')
            .map(d => `${d.line}:${d.column} ${d.message}`)
        const attachments = analysis.attachments.map(a =>
            `${a.name} · ${a.kind} · ${BINDING_LABEL[a.kind]}${a.reactive ? ' (reactive)' : ''}`,
        )

        // Traffic light: red if broken (errors/blocked, unviable), yellow if
        // viable but running no machines (a warning, not an error - a form
        // that only wires observables is fine), green otherwise.
        const broken = !!analysis.blocked || errors.length > 0
        const color = broken ? cssVar('error') : analysis.machines.length === 0 ? cssVar('warn') : cssVar('success')

        return { name: file.name, color, viable: !broken, blocked: analysis.blocked, errors, machines: analysis.machines, attachments }
    }
}
