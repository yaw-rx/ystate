import { Component, RxElement, state } from '@yaw-rx/core'
import type { SandboxResult, ClosureResult, ClosureIssue } from '../services/sandbox.service.js'

interface OutputEntry {
    key: string
    label: string
    success: boolean
    issues: ClosureIssue[]
}

@Component({
    selector: 'output-panel',
    template: `
        <div class="status-bar">
            <span #statusText class="status"></span>
            <button #toggleBtn class="toggle" onclick="onToggle">&#9650;</button>
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
            padding: 0 12px;
            font-family: var(--font-mono);
            font-size: 0.75rem;
            flex-shrink: 0;
        }
        .status {
            flex: 1;
        }
        .toggle {
            background: none;
            border: none;
            color: var(--dim);
            cursor: pointer;
            font-size: 0.55rem;
            padding: 2px 4px;
            transition: transform 0.15s;
            flex-shrink: 0;
        }
        .toggle:hover {
            color: var(--text);
        }
        .toggle.expanded {
            transform: rotate(180deg);
        }
        .details {
            overflow: auto;
            font-family: var(--font-mono);
            font-size: 0.75rem;
            line-height: 1.6;
            padding: 0 12px;
            flex: 1;
        }
        .entry-header {
            padding: 4px 0;
            font-weight: bold;
        }
        .entry-header.success { color: #5b5; }
        .entry-header.failure { color: #c55; }
        .issue {
            color: #c55;
            padding-left: 16px;
            white-space: pre-wrap;
        }
    `,
})
export class OutputPanel extends RxElement {
    @state sandboxResult: SandboxResult | null = null
    @state expanded = false

    statusText!: HTMLSpanElement
    toggleBtn!: HTMLButtonElement
    details!: HTMLDivElement

    override onRender(): void {
        this.sandboxResult$.subscribe(r => this.renderResult(r))
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

    private renderResult(result: SandboxResult | null): void {
        this.details.innerHTML = ''

        if (!result) {
            this.statusText.textContent = ''
            this.statusText.style.color = ''
            return
        }

        if (!result.ok) {
            this.statusText.textContent = '✗ Evaluation error'
            this.statusText.style.color = '#c55'
            const div = document.createElement('div')
            div.className = 'issue'
            div.textContent = result.error
            this.details.appendChild(div)
            return
        }

        const entries = this.buildEntries(result.closureResults)
        const failures = entries.filter(e => !e.success)

        if (failures.length === 0) {
            const machines = entries.filter(e => result.graphKinds[e.key] === 'machine').length
            const graphs = entries.length - machines
            const parts: string[] = []
            if (machines > 0) parts.push(`${machines} machine${machines !== 1 ? 's' : ''} closed`)
            if (graphs > 0) parts.push(`${graphs} graph${graphs !== 1 ? 's' : ''} closed`)
            this.statusText.textContent = `✓ ${parts.join(', ')}`
            this.statusText.style.color = '#5b5'
        } else {
            const n = failures.reduce((sum, e) => sum + e.issues.length, 0)
            this.statusText.textContent = `✗ ${n} closure issue${n !== 1 ? 's' : ''}`
            this.statusText.style.color = '#c55'
        }

        for (const entry of entries) {
            const header = document.createElement('div')
            header.className = `entry-header ${entry.success ? 'success' : 'failure'}`
            header.textContent = `${entry.success ? '✓' : '✗'} ${entry.label}`
            this.details.appendChild(header)

            for (const issue of entry.issues) {
                const div = document.createElement('div')
                div.className = 'issue'
                div.textContent = this.formatIssue(issue)
                this.details.appendChild(div)
            }
        }
    }

    private buildEntries(results: Record<string, ClosureResult>): OutputEntry[] {
        return Object.entries(results).map(([key, result]) => {
            const sep = key.indexOf(':')
            const label = sep === -1 ? key : `${key.slice(sep + 1)} (${key.slice(0, sep).replace(/\.ts$/, '')})`
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
                return `edge '${issue.edge}': dep '${issue.dep}' not in K. Available: {${issue.availableDeps.join(', ')}}`
            case 'missing-dep-node':
                return `edge '${issue.edge}': node '${issue.node}' not in dep '${issue.dep}'. Available: {${issue.availableNodes.join(', ')}}`
            case 'missing-target':
                return `edge '${issue.edge}': target '${issue.node}' not in V'. Available: {${issue.availableNodes.join(', ')}}`
            case 'missing-source':
                return `edge '${issue.edge}': source '${issue.node}' not in V. Available: {${issue.availableNodes.join(', ')}}`
            case 'namespace-collision':
                return `namespaceFunctor collision: node '${issue.node}' in '${issue.namespace}' already from '${issue.existingNamespace}'`
            case 'multiple-graphs':
                return `closure produced ${issue.graphs.length} disjoint graphs instead of 1`
            case 'missing-transition':
                return `edge '${issue.edge}': transition '${issue.transition}' not in δ at namespace '${issue.namespace}'`
            case 'missing-handler':
                return `edge '${issue.edge}': transition '${issue.transition}' missing '${issue.direction}' handler at '${issue.namespace}'`
            case 'malformed-edge-on':
                return `edge '${issue.edge}': malformed on field '${issue.on}'`
            case 'missing-namespace-transitions':
                return `edge '${issue.edge}': no transitions at namespace '${issue.namespace}'`
        }
    }
}
