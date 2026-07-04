import { Component, RxElement, state } from '@yaw-rx/core'
import { RxIf } from '@yaw-rx/core/directives/rx-if'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { map, tap, type Observable, type Subscription } from 'rxjs'
import type { SandboxResult, ClosureResult, ClosureIssue, MachineSetValidationIssue } from '../services/sandbox.service.js'

interface OutputEntry {
    key: string
    label: string
    success: boolean
    issues: ClosureIssue[]
}

interface DetailEntry {
    key: string
    label: string
    success: boolean
    failure: boolean
    icon: string
    kind: string
    issues: string[]
}

@Component({
    selector: 'output-panel',
    directives: [RxIf, RxFor],
    template: `
        <div class="status-bar">
            <span class="status">
                <span rx-if="hasFailures" class="error">✗ </span>
                <span rx-if="allOk" class="success">✓ </span>
                <span class="error">{{failText}}</span>
                <span class="success">{{okText}}</span>
                <span class="warn">{{warnText}}</span>
            </span>
            <button class="toggle" [class.expanded]="expanded" onclick="onToggle">
                <span class="toggle-icon">&#9650;</span>
            </button>
        </div>
        <div class="details" [style.display]="detailsDisplay">
            <div rx-if="showError" class="issue">{{errorText}}</div>
            <div rx-for="entry of detailEntries by key">
                <div class="entry" [class.success]="entry.success" [class.failure]="entry.failure">{{entry.icon}} {{entry.label}} {{entry.kind}}</div>
                <div rx-for="issue of entry.issues">
                    <div class="issue">· {{issue}}</div>
                </div>
            </div>
            <div rx-for="warning of warnings">
                <div class="warning">· {{warning}}</div>
            </div>
        </div>
    `,
    styles: `
        :host {
            display: flex;
            flex-direction: column;
            background: var(--bg-1);
            overflow: hidden;
            flex-shrink: 0;
        }
        .status-bar {
            display: flex;
            align-items: center;
            height: 28px;
            font-family: var(--font-mono);
            font-size: 0.75rem;
            flex-shrink: 0;
            background: var(--bg-2);
        }
        .status {
            flex: 1;
            color: var(--dim);
            padding: 0 12px;
        }
        .status .error { color: var(--error); }
        .status .success { color: var(--success); }
        .status .warn { color: var(--warn); }
        .toggle {
            background: none;
            border: none;
            border-left: 1px solid var(--border);
            color: var(--dim);
            cursor: pointer;
            padding: 0 8px;
            margin-left: 8px;
            height: 100%;
            display: flex;
            align-items: center;
            transition: background 0.1s, color 0.1s;
            flex-shrink: 0;
        }
        .toggle:hover {
            color: var(--text);
            background: var(--bg-4);
        }
        .toggle-icon {
            font-size: 0.7rem;
            transition: transform 0.15s;
            display: inline-block;
        }
        .toggle.expanded .toggle-icon {
            transform: rotate(180deg);
        }
        .details {
            overflow: auto;
            font-family: var(--font-mono);
            font-size: 0.75rem;
            line-height: 1.8;
            padding: 4px 12px;
            flex: 1;
        }
        .entry {
            padding-left: 12px;
        }
        .entry.success { color: var(--success); }
        .entry.failure { color: var(--error); }
        .issue {
            color: var(--error);
            padding-left: 24px;
            white-space: pre-wrap;
        }
        .warning {
            color: var(--warn);
            padding-left: 12px;
            white-space: pre-wrap;
        }
    `,
})
export class OutputPanel extends RxElement {
    @state sandboxResult: SandboxResult | null = null
    @state expanded = false
    @state hasFailures = false
    @state allOk = false
    @state failText = ''
    @state okText = ''
    @state warnText = ''
    @state showError = false
    @state errorText = ''
    @state detailEntries: DetailEntry[] = []
    @state warnings: string[] = []
    private subs: Subscription[] = []

    get detailsDisplay(): Observable<string> {
        return this.expanded$.pipe(map((exp: boolean) => exp ? '' : 'none'))
    }

    override onInit(): void {
        this.subs.push(this.sandboxResult$.pipe(
            tap((r: SandboxResult | null) => this.updateFromResult(r)),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
    }

    onToggle(): void {
        this.dispatchEvent(new CustomEvent('toggle-output', { bubbles: true, composed: true }))
    }

    private updateFromResult(result: SandboxResult | null): void {
        if (!result) {
            this.hasFailures = false
            this.allOk = false
            this.failText = ''
            this.okText = ''
            this.warnText = ''
            this.showError = false
            this.errorText = ''
            this.detailEntries = []
            this.warnings = []
            return
        }

        if (result.ok === false) {
            this.hasFailures = true
            this.allOk = false
            this.failText = 'Evaluation error'
            this.okText = ''
            this.warnText = ''
            this.showError = true
            this.errorText = result.error
            this.detailEntries = []
            this.warnings = []
            return
        }

        this.showError = false
        this.errorText = ''

        const entries = this.buildEntries(result.closureResults)
        const failures = entries.filter(e => !e.success)
        const successes = entries.filter(e => e.success)

        const failParts: string[] = []
        const graphFailures = failures.filter(e => result.graphKinds[e.key] !== 'machine')
        const machineFailures = failures.filter(e => result.graphKinds[e.key] === 'machine')
        if (graphFailures.length > 0) {
            const n = graphFailures.reduce((sum, e) => sum + e.issues.length, 0)
            failParts.push(`${n} graph closure issue${n !== 1 ? 's' : ''}`)
        }
        if (machineFailures.length > 0) {
            const n = machineFailures.reduce((sum, e) => sum + e.issues.length, 0)
            failParts.push(`${n} machine closure issue${n !== 1 ? 's' : ''}`)
        }

        const okParts: string[] = []
        if (successes.length > 0) {
            const machines = successes.filter(e => result.graphKinds[e.key] === 'machine').length
            const graphs = successes.length - machines
            if (machines > 0) okParts.push(`${machines} machine${machines !== 1 ? 's' : ''} closed`)
            if (graphs > 0) okParts.push(`${graphs} graph${graphs !== 1 ? 's' : ''} closed`)
        }

        this.hasFailures = failParts.length > 0
        this.allOk = failParts.length === 0 && okParts.length > 0
        this.failText = failParts.length > 0
            ? failParts.join(', ') + (okParts.length > 0 ? ', ' : '')
            : ''
        this.okText = okParts.join(', ')

        const hasWarnings = entries.some(e => {
            const cr = result.closureResults[e.key]
            return cr.success === true && cr.warnings.length > 0
        })
        this.warnText = hasWarnings ? ' with warnings' : ''

        this.detailEntries = entries.map(e => ({
            key: e.key,
            label: e.label,
            success: e.success,
            failure: !e.success,
            icon: e.success ? '✓' : '✗',
            kind: e.success ? 'closed' : 'failed',
            issues: e.issues.map(i => this.formatIssue(i)),
        }))

        this.warnings = entries.flatMap(e => {
            const cr = result.closureResults[e.key]
            return cr.success === true ? cr.warnings.map(w => this.formatWarning(w)) : []
        })
    }

    private buildEntries(results: Record<string, ClosureResult>): OutputEntry[] {
        return Object.entries(results).map(([key, result]) => {
            const sep = key.indexOf(':')
            const label = sep === -1 ? key : `${key.slice(0, sep).replace(/\.ts$/, '')} (${key.slice(sep + 1)})`
            return {
                key,
                label,
                success: result.success,
                issues: result.success === false ? result.issues : [],
            }
        })
    }

    private formatIssue(issue: ClosureIssue): string {
        switch (issue.kind) {
            case 'missing-dep':
                return `Edge '${issue.edge}': dep '${issue.dep}' not in K. Available: {${issue.availableDeps.join(', ')}}`
            case 'missing-dep-node':
                return `Edge '${issue.edge}': node '${issue.node}' not in dep '${issue.dep}'. Available: {${issue.availableNodes.join(', ')}}`
            case 'missing-target':
                return `Edge '${issue.edge}': target '${issue.node}' not in V' at ${issue.formattedNamespace}. Available: {${issue.availableNodes.join(', ')}}`
            case 'missing-source':
                return `Edge '${issue.edge}': source '${issue.node}' not in V at ${issue.formattedNamespace}. Available: {${issue.availableNodes.join(', ')}}`
            case 'namespace-collision':
                return `Namespace collision: node '${issue.node}' in ${issue.formattedNamespace} already from ${issue.formattedExistingNamespace}`
            case 'multiple-graphs':
                return `Closure produced ${issue.subgraphs.length} disjoint graphs instead of 1:\n` + issue.subgraphs.map(sg => `    V = {${sg.nodes.join(', ')}}`).join('\n')
            case 'incomplete-transition':
                return `Transition '${issue.transition}' missing required field '${issue.field}' at ${issue.formattedNamespace}`
            case 'missing-transition':
                return `Edge '${issue.edge}': transition '${issue.transition}' not in δ at ${issue.formattedNamespace}`
            case 'missing-handler':
                return `Edge '${issue.edge}': transition '${issue.transition}' missing '${issue.direction}' handler at ${issue.formattedNamespace}`
            case 'malformed-edge-on':
                return `Edge '${issue.edge}': malformed on field '${issue.on}'`
            case 'missing-namespace-transitions':
                return `Edge '${issue.edge}': no transitions at ${issue.formattedNamespace}`
        }
    }

    private formatWarning(warning: MachineSetValidationIssue): string {
        switch (warning.kind) {
            case 'missing-handler':
                return `Transition '${warning.transition}' at ${warning.formattedNamespace} missing optional handlers: {${warning.handlers.join(', ')}}`
            case 'unused-transition':
                return `Transition '${warning.transition}' at ${warning.formattedNamespace} is implemented but no edge references it`
        }
    }
}
