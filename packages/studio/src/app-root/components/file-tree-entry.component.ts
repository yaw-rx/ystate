import { Component, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { RxIf } from '@yaw-rx/core/directives/rx-if'
import { type Observable, type Subscription, map, first, tap } from 'rxjs'
import { isAnalyzedWorkspaceFile, type WorkspaceFile, type ExportRecord } from '../services/workspace.service.js'
import type { StaticBrand } from '../services/type-analysis.service.js'
import entryStyles from './file-tree-entry.css'

const cssVar = (name: string): string => `var(--${name})`

const BRAND_VAR_NAME: Record<StaticBrand, string> = {
    'graph-set': 'brand-graph-set',
    machine: 'brand-machine',
    observable: 'brand-observable',
    'behavior-subject': 'brand-behavior-subject',
    function: 'brand-function',
    class: 'brand-class',
    const: 'brand-const',
    other: 'brand-other',
}

// Display order within a file's export list - every brand gets a distinct
// rank, no ties: consts first, then functions, then graph-sets, machines
// strictly last.
const BRAND_ORDER: Record<StaticBrand, number> = {
    const: 0,
    observable: 1,
    'behavior-subject': 2,
    function: 3,
    class: 4,
    other: 5,
    'graph-set': 6,
    machine: 7,
}

const TOKEN_VAR_NAME: Record<string, string> = {
    keyword: 'token-keyword',
    className: 'token-type',
    interfaceName: 'token-type',
    aliasName: 'token-type',
    enumName: 'token-type',
    typeParameterName: 'token-type',
    parameterName: 'token-param',
    propertyName: 'token-param',
    localName: 'token-param',
    functionName: 'token-function-name',
    methodName: 'token-function-name',
    stringLiteral: 'token-string',
    numericLiteral: 'token-number',
}

interface DisplayPartView {
    text: string
    color: string
}

interface ExportRow {
    key: string
    name: string
    brand: StaticBrand
    color: string
    isGraphSet: boolean
    isMachine: boolean
    isObservable: boolean
    isBehaviorSubject: boolean
    isFunction: boolean
    isClass: boolean
    isConst: boolean
    hasError: boolean
    hasWarning: boolean
    parts: DisplayPartView[]
    docsText: string
}

@Component({
    selector: 'file-tree-entry',
    directives: [RxFor, RxIf],
    styles: entryStyles,
    template: `
        <div class="file-row" onclick="toggle">
            <span class="chevron" [class.open]="expanded" rx-if="hasExports">&#9656;</span>
            <span class="file-name">{{fileName}}</span>
            <span rx-if="hasDiagnosticErrors"><span class="file-diag-badge" title="file has compiler errors">!</span></span>
        </div>
        <div rx-if="expanded">
            <ul class="exports" rx-for="row of exportRows by key">
                <li>
                    <div class="export-row" [class.error]="row.hasError" [class.warn]="row.hasWarning" onpointerenter="enterRow($event, row.key)" onpointerleave="leaveRow">
                        <svg class="badge" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" [style.color]="row.color">
                            <g rx-if="row.isGraphSet">
                                <circle cx="18" cy="5" r="3" />
                                <circle cx="6" cy="12" r="3" />
                                <circle cx="18" cy="19" r="3" />
                                <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
                                <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
                            </g>
                            <g rx-if="row.isMachine">
                                <path d="M12 20v2" />
                                <path d="M12 2v2" />
                                <path d="M17 20v2" />
                                <path d="M17 2v2" />
                                <path d="M2 12h2" />
                                <path d="M2 17h2" />
                                <path d="M2 7h2" />
                                <path d="M20 12h2" />
                                <path d="M20 17h2" />
                                <path d="M20 7h2" />
                                <path d="M7 20v2" />
                                <path d="M7 2v2" />
                                <rect x="4" y="4" width="16" height="16" rx="2" />
                                <rect x="8" y="8" width="8" height="8" rx="1" />
                            </g>
                            <g rx-if="row.isObservable">
                                <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                                <circle cx="12" cy="12" r="3" />
                            </g>
                            <g rx-if="row.isBehaviorSubject">
                                <path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
                                <path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
                                <path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
                                <path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
                                <circle cx="12" cy="12" r="2" />
                            </g>
                            <g rx-if="row.isFunction">
                                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                                <path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3" />
                                <path d="M9 11.2h5.7" />
                            </g>
                            <g rx-if="row.isClass">
                                <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
                                <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
                            </g>
                            <g rx-if="row.isConst">
                                <path d="M12 2v20" />
                                <circle cx="12" cy="12" r="7" />
                            </g>
                        </svg>
                        <span class="export-name">{{row.name}}</span>
                        <div class="tooltip" [class.visible]="isHovered(row.key)" [style.left]="tooltipLeft" [style.top]="tooltipTop" onpointerenter="enterTooltip" onpointerleave="leaveTooltip">
                            <div class="sig">
                                <span rx-for="part of row.parts"><span class="tok" [style.color]="part.color">{{part.text}}</span></span>
                            </div>
                            <div rx-if="row.docsText"><div class="docs">{{row.docsText}}</div></div>
                        </div>
                    </div>
                </li>
            </ul>
        </div>
    `,
})
export class FileTreeEntry extends RxElement {
    @state file!: WorkspaceFile
    @state workspaceName = ''
    // Seeds the initial value of `expanded` once (see onInit) - a parent
    // re-render mustn't stomp a manual toggle, so this isn't `expanded`
    // itself, just its starting point.
    @state startExpanded = false
    @state expanded = false
    @state tooltipX = 0
    @state tooltipY = 0
    // Which row's tooltip is open, by key ('' = none).
    @state hoveredRowKey = ''
    // Not @state: nothing in the template binds to this directly, it's only
    // consulted synchronously inside leaveRow().
    private overTooltip = false
    private subs: Subscription[] = []

    get tooltipLeft$(): Observable<string> {
        return this.tooltipX$.pipe(map(x => `${x}px`))
    }

    get tooltipTop$(): Observable<string> {
        return this.tooltipY$.pipe(map(y => `${y}px`))
    }

    isHovered(key: string): Observable<boolean> {
        return this.hoveredRowKey$.pipe(map(k => k === key))
    }

    // Anchored so the cursor's entry point is already inside the tooltip's
    // box the instant it appears (negative offset, not +N) - moving into
    // the tooltip is then never a "travel across a gap," it's already true,
    // so there's no window where neither element is hovered and nothing
    // needs a timer to bridge.
    enterRow(e: PointerEvent, key: string): void {
        this.tooltipX = e.clientX - 12
        this.tooltipY = e.clientY - 12
        this.hoveredRowKey = key
    }

    leaveRow(): void {
        if (!this.overTooltip) this.hoveredRowKey = ''
    }

    enterTooltip(): void {
        this.overTooltip = true
    }

    leaveTooltip(): void {
        this.overTooltip = false
        this.hoveredRowKey = ''
    }

    override onInit(): void {
        this.subs.push(this.startExpanded$.pipe(
            first(v => v === true),
            tap(() => { this.expanded = true }),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
    }

    get fileName$(): Observable<string> {
        return this.file$.pipe(map(f => f.name))
    }

    get hasExports$(): Observable<boolean> {
        return this.file$.pipe(map(f => this.exportsOf(f).length > 0))
    }

    get hasDiagnosticErrors$(): Observable<boolean> {
        return this.file$.pipe(map(f => this.errorDiagnosticCount(f) > 0))
    }

    get exportRows$(): Observable<ExportRow[]> {
        return this.file$.pipe(map(f => this.exportsOf(f)
            .map(r => this.toRow(f.name, r))
            .sort((a, b) => BRAND_ORDER[a.brand] - BRAND_ORDER[b.brand])))
    }

    toggle(): void {
        this.expanded = !this.expanded
    }

    private exportsOf(file: WorkspaceFile): ExportRecord[] {
        return isAnalyzedWorkspaceFile(file) ? file.analysis.exports : []
    }

    private errorDiagnosticCount(file: WorkspaceFile): number {
        return isAnalyzedWorkspaceFile(file) ? file.analysis.diagnostics.filter(d => d.category === 'error').length : 0
    }

    // Runtime is ground truth for anything a guard can check on the actual
    // executed value - graph-set/machine (isIncidenceGraphSetMixin/
    // isIncidenceMachineMixin) and function (typeof value === 'function')
    // are all guard-detected, so they win over the checker's hover text.
    // That text can't be trusted for this: an *unimplemented* graph-set's
    // own `.implement()` method has `IncidenceMachineMixin` as its declared
    // return type, and a function returning an Observable has "Observable"
    // in its own signature - naive token matching on displayParts finds
    // those names regardless of what the export itself actually is.
    // Static brand only fills in what runtime can't distinguish: Observable
    // vs BehaviorSubject (both guard-detect as plain 'observable'), or
    // what runtime has no sharper answer for (a 'plain-value' - class
    // instance, const, other).
    private effectiveBrand(record: ExportRecord): StaticBrand {
        const runtime = record.runtime
        console.log(`[effectiveBrand] ${record.name} runtime=`, runtime, 'static.brand=', record.static.brand)
        if (runtime.status !== 'evaluated') return record.static.brand

        switch (runtime.kind) {
            case 'graph-set':
            case 'machine':
            case 'function':
                return runtime.kind
            case 'observable':
                return record.static.brand === 'behavior-subject' ? 'behavior-subject' : 'observable'
            case 'plain-value':
                return record.static.brand
        }
    }

    // Checker output often opens/closes with blank-text parts (a leading
    // newline, trailing whitespace) - real formatting inside the signature
    // is kept, only the dead space at the very start/end is dropped.
    private trimmedParts(parts: readonly { text: string; kind: string }[]): DisplayPartView[] {
        let start = 0
        let end = parts.length
        while (start < end && parts[start]!.text.trim() === '') start++
        while (end > start && parts[end - 1]!.text.trim() === '') end--
        return parts.slice(start, end).map(p => ({ text: p.text, color: cssVar(TOKEN_VAR_NAME[p.kind] ?? 'text') }))
    }

    private toRow(fileName: string, record: ExportRecord): ExportRow {
        const runtime = record.runtime
        const hasError = runtime.status === 'unevaluated'
            || (runtime.status === 'evaluated' && runtime.closure?.success === false)
        const hasWarning = runtime.status === 'evaluated' && runtime.closure?.success === true && runtime.closure.warnings.length > 0
        const brand = this.effectiveBrand(record)

        return {
            key: `${this.workspaceName}/${fileName}:${record.name}`,
            name: record.name,
            brand,
            color: cssVar(BRAND_VAR_NAME[brand]),
            isGraphSet: brand === 'graph-set',
            isMachine: brand === 'machine',
            isObservable: brand === 'observable',
            isBehaviorSubject: brand === 'behavior-subject',
            isFunction: brand === 'function',
            isClass: brand === 'class',
            isConst: brand === 'const' || brand === 'other',
            hasError,
            hasWarning,
            parts: this.trimmedParts(record.static.displayParts),
            docsText: record.static.documentation.map(p => p.text).join(''),
        }
    }
}
