import { Component, RxElement, state } from '@yaw-rx/core'
import { RxIf } from '@yaw-rx/core/directives/rx-if'
import type { SandboxResult, ClosureResult, ClosureIssue, MachineSetValidationIssue } from '../services/sandbox.service.js'

interface OutputEntry {
    key: string
    label: string
    success: boolean
    issues: ClosureIssue[]
}

@Component({
    selector: 'output-panel',
    directives: [RxIf],
    template: `
        <div class="status-bar">
            <span class="status">
                <span rx-if="hasFailures" class="error">✗ </span>
                <span rx-if="allOk" class="success">✓ </span>
                <span class="error">{{failText}}</span>
                <span class="success">{{okText}}</span>
                <span class="warn">{{warnText}}</span>
            </span>
            <button #toggleBtn class="toggle" onclick="onToggle">
                <span class="toggle-icon">&#9650;</span>
            </button>
        </div>
        <div #details class="details"></div>
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
        }
        .status {
            flex: 1;
            color: #888;
            padding: 0 12px;
        }
        .status .error { color: #c55; }
        .status .success { color: #5b5; }
        .status .warn { color: #da0; }
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
        .entry.success { color: #5b5; }
        .entry.failure { color: #c55; }
        .issue {
            color: #c55;
            padding-left: 24px;
            white-space: pre-wrap;
        }
        .warning {
            color: #da0;
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

    toggleBtn!: HTMLButtonElement
    details!: HTMLDivElement

    override onRender(): void {
        this.sandboxResult$.subscribe(r => this.updateStatus(r))
        this.sandboxResult$.subscribe(r => this.renderDetails(r))
        this.expanded$.subscribe((exp: boolean) => {
            this.details.style.display = exp ? '' : 'none'
            if (exp) {
                this.toggleBtn.classList.add('expanded')
            } else {
                this.toggleBtn.classList.remove('expanded')
            }
        })
    }

    onToggle(): void {
        this.dispatchEvent(new CustomEvent('toggle-output', { bubbles: true, composed: true }))
    }

    private updateStatus(result: SandboxResult | null): void {
        if (!result) {
            this.hasFailures = false
            this.allOk = false
            this.failText = ''
            this.okText = ''
            this.warnText = ''
            return
        }

        if (!result.ok) {
            this.hasFailures = true
            this.allOk = false
            this.failText = 'Evaluation error'
            this.okText = ''
            this.warnText = ''
            return
        }

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
            return cr.success && cr.warnings.length > 0
        })
        this.warnText = hasWarnings ? ' with warnings' : ''
    }

    private renderDetails(result: SandboxResult | null): void {
        this.details.innerHTML = ''
        if (!result) return

        if (!result.ok) {
            const div = document.createElement('div')
            div.className = 'issue'
            div.textContent = result.error
            this.details.appendChild(div)
            return
        }

        const entries = this.buildEntries(result.closureResults)
        const allWarnings = entries.flatMap(e => {
            const cr = result.closureResults[e.key]
            return cr.success ? cr.warnings : []
        })

        for (const entry of entries) {
            const div = document.createElement('div')
            div.className = `entry ${entry.success ? 'success' : 'failure'}`
            const kind = entry.success ? 'closed' : 'failed'
            div.textContent = `${entry.success ? '✓' : '✗'} ${entry.label} ${kind}`
            this.details.appendChild(div)

            for (const issue of entry.issues) {
                const issueDiv = document.createElement('div')
                issueDiv.className = 'issue'
                issueDiv.textContent = `· ${this.formatIssue(issue)}`
                this.details.appendChild(issueDiv)
            }
        }

        for (const warning of allWarnings) {
            const div = document.createElement('div')
            div.className = 'warning'
            div.textContent = `· ${this.formatWarning(warning)}`
            this.details.appendChild(div)
        }
    }

    private buildEntries(results: Record<string, ClosureResult>): OutputEntry[] {
        return Object.entries(results).map(([key, result]) => {
            const sep = key.indexOf(':')
            const label = sep === -1 ? key : `${key.slice(0, sep).replace(/\.ts$/, '')} (${key.slice(sep + 1)})`
            return {
                key,
                label,
                success: result.success,
                issues: result.success ? [] : result.issues,
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
