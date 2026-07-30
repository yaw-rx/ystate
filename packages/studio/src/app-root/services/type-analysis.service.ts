import { Injectable } from '@yaw-rx/core'
import { define } from '@yaw-rx/ystate'
import { Subject } from 'rxjs'
import * as monaco from 'monaco-editor'
import ts from 'typescript'
import type { QualifiedName } from '../types/runtime-filesystem.types.js'
import { toModelUri } from '../utils/model-uri.js'
import { splitQualifiedName } from '../utils/qualified-name.js'
import { logMachineFailures } from '../utils/log-machine-failures.js'

export type StaticBrand = 'graph-set' | 'machine' | 'observable' | 'behavior-subject' | 'function' | 'class' | 'const' | 'other'

export interface StaticExportInfo {
    name: string
    brand: StaticBrand
    displayParts: ts.SymbolDisplayPart[]
    documentation: ts.SymbolDisplayPart[]
}

export interface FileDiagnostic {
    message: string
    line: number
    column: number
    category: 'error' | 'warning' | 'suggestion' | 'message'
}

export interface StaticFileManifest {
    diagnostics: FileDiagnostic[]
    exports: StaticExportInfo[]
}

// Maps a type's own name (as it appears in a checker-resolved display part) to
// the domain-level brand it represents. Matched against the resolved type, so
// aliases/re-exports still resolve correctly - this is not string-matching the
// source code, it's reading the checker's own output.
const SPECIAL_TYPE_BRANDS: Record<string, StaticBrand> = {
    Observable: 'observable',
    Subject: 'observable',
    ReplaySubject: 'observable',
    BehaviorSubject: 'behavior-subject',
    IncidenceGraphSetMixin: 'graph-set',
    IncidenceGraphSet: 'graph-set',
    IncidenceMachineMixin: 'machine',
    IncidenceMachine: 'machine',
}

const DIAGNOSTIC_CATEGORY: Record<number, FileDiagnostic['category']> = {
    [ts.DiagnosticCategory.Warning]: 'warning',
    [ts.DiagnosticCategory.Error]: 'error',
    [ts.DiagnosticCategory.Suggestion]: 'suggestion',
    [ts.DiagnosticCategory.Message]: 'message',
}

// monaco-editor's own .d.ts marks `monaco.languages.typescript` as a
// deprecated stub type (matches the `as any` cast code-panel.component.ts
// already uses for the same namespace) - the real shape at runtime is
// documented in monaco.d.ts's TypeScriptWorker interface, reproduced here.
interface TypeScriptWorkerClient {
    getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]>
    getSemanticDiagnostics(fileName: string): Promise<ts.Diagnostic[]>
    getNavigationTree(fileName: string): Promise<ts.NavigationTree | undefined>
    getQuickInfoAtPosition(fileName: string, position: number): Promise<ts.QuickInfo | undefined>
}

interface MonacoTypeScriptLanguage {
    getTypeScriptWorker(): Promise<(...uris: monaco.Uri[]) => Promise<TypeScriptWorkerClient>>
}

const tsLanguage = (): MonacoTypeScriptLanguage =>
    (monaco.languages as unknown as { typescript: MonacoTypeScriptLanguage }).typescript

const TYPESCRIPT_NOT_REGISTERED = 'TypeScript not registered!'

/**
 * Monaco registers the TypeScript language service lazily, triggered by the
 * first `'typescript'` model ever created (RuntimeFilesystemService creates
 * that model before this service's first `check()` call always runs) - but
 * the registration itself is async (a dynamic import of its own worker
 * mode), and `getTypeScriptWorker()` exposes no promise for "registration
 * finished," only this one rejection reason if called before it's done.
 * Cold start races this: the model that triggers registration and the
 * first `check()` call happen close enough together that registration
 * hasn't always finished yet. Since it always does finish (it's already in
 * flight), this is a real one-time async precondition to wait out, not an
 * arbitrary retry - narrowly scoped to this exact rejection, nothing else.
 */
async function waitForTypeScriptWorker(): ReturnType<MonacoTypeScriptLanguage['getTypeScriptWorker']> {
    const startedAt = performance.now()
    for (let attempt = 1; ; attempt++) {
        try {
            const worker = await tsLanguage().getTypeScriptWorker()
            console.log(`[type-analysis] getTypeScriptWorker ready after ${attempt} attempt(s), ${Math.round(performance.now() - startedAt)}ms`)
            return worker
        } catch (e) {
            if (e !== TYPESCRIPT_NOT_REGISTERED) {
                console.error('[type-analysis] getTypeScriptWorker rejected with an unexpected reason', e)
                throw e
            }
            if (attempt === 1 || attempt % 20 === 0) {
                console.log(`[type-analysis] still waiting on TypeScript registration, attempt ${attempt}, ${Math.round(performance.now() - startedAt)}ms elapsed`)
            }
            await new Promise(resolve => setTimeout(resolve, 0))
        }
    }
}

function classifyBrand(syntaxKind: string, displayParts: ts.SymbolDisplayPart[]): StaticBrand {
    // Check what the declaration itself IS before ever looking at what its
    // type mentions. A `function foo() {}` declaration is caught by
    // syntaxKind, but most functions here are `const foo = () => ...`,
    // which the navigation tree reports as a plain const - so also check
    // whether the type immediately after `:` opens with `(`, i.e. the
    // declaration's own type is a function type. Only once neither of
    // those hold do we scan for a special return/value type name -
    // otherwise a function returning an Observable would have "Observable"
    // found in its own return-type annotation and get misclassified as
    // one, regardless of what the export itself actually is.
    if (syntaxKind === ts.ScriptElementKind.functionElement) return 'function'
    if (syntaxKind === ts.ScriptElementKind.classElement) return 'class'

    const colonIndex = displayParts.findIndex(p => p.kind === 'punctuation' && p.text === ':')
    if (colonIndex !== -1) {
        const next = displayParts.slice(colonIndex + 1).find(p => p.text.trim() !== '')
        if (next?.text === '(') return 'function'
    }

    for (const part of displayParts) {
        if ((part.kind === 'className' || part.kind === 'interfaceName' || part.kind === 'aliasName') && part.text in SPECIAL_TYPE_BRANDS) {
            return SPECIAL_TYPE_BRANDS[part.text]
        }
    }
    return 'const'
}

function formatDiagnostic(
    model: monaco.editor.ITextModel,
    d: { start?: number; messageText: string | ts.DiagnosticMessageChain; category: number },
): FileDiagnostic {
    const message = typeof d.messageText === 'string' ? d.messageText : ts.flattenDiagnosticMessageText(d.messageText, '\n')
    const pos = d.start != null ? model.getPositionAt(d.start) : { lineNumber: 1, column: 1 }
    return {
        message,
        line: pos.lineNumber,
        column: pos.column,
        category: DIAGNOSTIC_CATEGORY[d.category] ?? 'message',
    }
}

async function analyzeFile(
    client: TypeScriptWorkerClient,
    model: monaco.editor.ITextModel,
    uriString: string,
): Promise<StaticFileManifest> {
    const [syntactic, semantic, navTree] = await Promise.all([
        client.getSyntacticDiagnostics(uriString),
        client.getSemanticDiagnostics(uriString),
        client.getNavigationTree(uriString) as Promise<ts.NavigationTree | undefined>,
    ])

    const diagnostics = [...syntactic, ...semantic].map(d => formatDiagnostic(model, d))
    const exports: StaticExportInfo[] = []

    for (const item of navTree?.childItems ?? []) {
        if (!item.kindModifiers.split(',').includes('export')) continue
        const span = item.nameSpan ?? item.spans[0]
        if (!span) continue

        const quickInfo = await client.getQuickInfoAtPosition(uriString, span.start) as ts.QuickInfo | undefined
        if (!quickInfo) continue

        const displayParts = quickInfo.displayParts ?? []
        exports.push({
            name: item.text,
            brand: classifyBrand(item.kind, displayParts),
            displayParts,
            documentation: quickInfo.documentation ?? [],
        })
    }

    return { diagnostics, exports }
}

/**
 * The Monaco TS worker's health and queue, as seen from our side - we
 * never get a raw `Worker` reference to it (constructed internally by
 * Monaco's own `WorkerManager`), so unlike `sandbox-worker.machine.ts`
 * there is no native 'error' event to listen to. "Failed" is inferred
 * from one of our own requests rejecting, not a crash we directly saw.
 *
 * The queue lives in node data (`checking`/`failed` both carry
 * `queue: QualifiedName[]`) - real observability into what's actually in
 * flight. What can't live in the data: *which* edge fires - a fixed-target
 * edge can't route to `checking` vs `idle` based on data a `next` handler
 * computes, so `check()` below owns the queue and decides that itself,
 * inside this module's closure, not leaked out to a caller.
 */
const checkerTopology = define({
    nodes: {
        idle: {},
        checking: { queue: [] as QualifiedName[] },
        failed: { error: '', queue: [] as QualifiedName[] },
    },
    edges: {
        start: { from: 'idle', to: 'checking', on: 'job.next' },
        restart: { from: 'checking', to: 'checking', on: 'job.next' },
        resume: { from: 'failed', to: 'checking', on: 'job.next' },
        finishFromChecking: { from: 'checking', to: 'idle', on: 'idle.next' },
        finishFromFailed: { from: 'failed', to: 'idle', on: 'idle.next' },
        fail: { from: 'checking', to: 'failed', on: 'failure.next' },
    },
})

/**
 * The compile-time half of export analysis, and the full ownership of
 * talking to Monaco's ts.worker (via getTypeScriptWorker()) - no second
 * language service, no duplicated lib/extraLib bootstrapping. `check()` is
 * the only operation exposed; a caller never touches the worker client,
 * the navigation tree, or classification directly. Requires a model to
 * already exist for the file being checked - RuntimeFilesystemService
 * creates one before ever calling this (see docs/filesystem-runtime.md §6).
 */
@Injectable()
export class TypeAnalysisService {
    private readonly job$ = new Subject<QualifiedName[]>()
    private readonly idle$ = new Subject<void>()
    private readonly failure$ = new Subject<{ error: string; queue: QualifiedName[] }>()
    private readonly queue = new Set<QualifiedName>()

    // Memoized once the wait actually succeeds - every check() after the
    // first reuses it instead of re-waiting. A genuine (non-registration)
    // failure clears it so the next call gets a fresh attempt rather than a
    // permanently-poisoned promise.
    private workerFactory: ReturnType<typeof waitForTypeScriptWorker> | undefined

    private getTypeScriptWorkerFactory(): ReturnType<typeof waitForTypeScriptWorker> {
        if (!this.workerFactory) {
            this.workerFactory = waitForTypeScriptWorker().catch(e => {
                this.workerFactory = undefined
                throw e
            })
        }
        return this.workerFactory
    }

    private readonly machine = checkerTopology.implement({
        job: { $: () => this.job$, next: (q) => ({ queue: q }) },
        idle: { $: () => this.idle$, next: () => ({}) },
        failure: { $: () => this.failure$, next: (payload) => ({ error: payload.error, queue: payload.queue }) },
    })

    readonly runningMachine = this.machine.close().start('idle')
    private readonly failureLog = logMachineFailures('type-checker', this.runningMachine.state$, 'failed')

    async check(qualifiedName: QualifiedName): Promise<StaticFileManifest> {
        this.queue.add(qualifiedName)
        this.job$.next([...this.queue])

        try {
            const { workspace, file } = splitQualifiedName(qualifiedName)
            const uri = toModelUri(workspace, file)
            const model = monaco.editor.getModel(uri)
            if (!model) return { diagnostics: [], exports: [] }

            console.log(`[type-analysis] check(${qualifiedName}) waiting on getTypeScriptWorkerFactory`)
            const getWorker = await this.getTypeScriptWorkerFactory()
            console.log(`[type-analysis] check(${qualifiedName}) waiting on getWorker(uri)`)
            const client = await getWorker(uri)
            console.log(`[type-analysis] check(${qualifiedName}) waiting on analyzeFile`)
            const result = await analyzeFile(client, model, uri.toString())
            console.log(`[type-analysis] check(${qualifiedName}) done`)

            this.queue.delete(qualifiedName)
            if (this.queue.size === 0) this.idle$.next()
            else this.job$.next([...this.queue])

            return result
        } catch (e) {
            this.queue.delete(qualifiedName)
            this.failure$.next({ error: e instanceof Error ? e.message : String(e), queue: [...this.queue] })
            throw e
        }
    }
}
