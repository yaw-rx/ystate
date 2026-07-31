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
        <div class="tabs" rx-for="file of files by name">
            <button class="tab" [class.active]="isActiveTab(file.name)" onclick="selectTab(file.name)">{{file.name}}</button>
        </div>
        <div class="body">
            <file-editor [style.display]="tsDisplay" [file]="activeFile"></file-editor>
            <form-panel [style.display]="formDisplay" [file]="activeFile"></form-panel>
        </div>
        <output-panel [sandboxResult]="terminalResult" [formReports]="formReports"></output-panel>
    `,
    styles: `
        :host { display: flex; flex-direction: column; height: 100%; background: var(--bg-2); }
        .tabs { display: flex; border-bottom: var(--border-width) solid var(--border); background: var(--bg-1); overflow-x: auto; flex-shrink: 0; }
        .tab { background: none; border: none; border-right: var(--border-width) solid var(--border); color: var(--dim); font-family: var(--font-mono); font-size: 0.75rem; padding: 0.5rem 1rem; cursor: pointer; white-space: nowrap; transition: color 0.1s, background 0.1s; }
        .tab:hover { color: var(--text); background: var(--bg-4); }
        .tab.active { color: var(--accent); background: var(--bg-3); border-bottom: 2px solid var(--accent); }
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
     * One file's analysis as a SandboxResult the terminal renders. A failed
     * evaluation or a compiler error (a form's type mistake, a broken
     * import) shows as `ok: false` with the messages - that's what "form
     * issues" are for a form, whose script has no machines to close.
     * Otherwise the machine/graph-set closures are shown.
     */
    private terminalFor(file: RuntimeFile, s: { node: string; data: unknown }): SandboxResult {
        const data = s.data as { analysis?: FileAnalysis; stale?: FileAnalysis; error?: string }
        if (s.node === 'failed') return { ok: false, error: data.error ?? 'analysis failed' }

        const analysis = data.analysis ?? data.stale
        const diagnosticErrors = (analysis?.diagnostics ?? []).filter(d => d.category === 'error')
        if (diagnosticErrors.length > 0) {
            return { ok: false, error: diagnosticErrors.map(d => `${file.name}:${d.line}:${d.column} - ${d.message}`).join('\n') }
        }

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
