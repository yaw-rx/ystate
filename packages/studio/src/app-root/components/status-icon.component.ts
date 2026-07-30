import { Component, RxElement, state } from '@yaw-rx/core'
import { RxIf } from '@yaw-rx/core/directives/rx-if'
import { type Observable, map } from 'rxjs'

export type StatusIconKind = 'analyzing' | 'blocked' | 'failed' | 'ok'

/**
 * One glyph per file-analysis outcome, shared by file-tree-entry (per file,
 * finer-grained: analyzing/blocked/failed only, nothing shown once clean)
 * and side-bar (per workspace, rolled up via utils/file-status.ts's
 * worstTier - always shown, including 'ok', so a workspace reads as
 * settled-and-clean at a glance rather than just "not currently showing a
 * problem").
 */
@Component({
    selector: 'status-icon',
    directives: [RxIf],
    template: `
        <svg class="status-icon" [class.analyzing]="isAnalyzing" [class.blocked]="isBlocked" [class.failed]="isFailed" [class.ok]="isOk"
             width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <g rx-if="isAnalyzing">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </g>
            <g rx-if="isBlocked">
                <circle cx="12" cy="12" r="10" />
                <line x1="10" x2="10" y1="15" y2="9" />
                <line x1="14" x2="14" y1="15" y2="9" />
            </g>
            <g rx-if="isFailed">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" x2="12" y1="8" y2="12" />
                <line x1="12" x2="12.01" y1="16" y2="16" />
            </g>
            <g rx-if="isOk">
                <circle cx="12" cy="12" r="10" />
                <path d="m9 12 2 2 4-4" />
            </g>
        </svg>
    `,
    styles: `
        :host {
            display: inline-flex;
        }
        .status-icon {
            flex-shrink: 0;
        }
        .status-icon.analyzing {
            color: var(--accent);
            animation: status-icon-spin 0.8s linear infinite;
            transform-origin: center;
        }
        .status-icon.blocked {
            color: var(--warn);
        }
        .status-icon.failed {
            color: var(--error);
        }
        .status-icon.ok {
            color: var(--success);
        }
        @keyframes status-icon-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
    `,
})
export class StatusIcon extends RxElement {
    @state kind: StatusIconKind = 'ok'

    get isAnalyzing$(): Observable<boolean> {
        return this.kind$.pipe(map(k => k === 'analyzing'))
    }

    get isBlocked$(): Observable<boolean> {
        return this.kind$.pipe(map(k => k === 'blocked'))
    }

    get isFailed$(): Observable<boolean> {
        return this.kind$.pipe(map(k => k === 'failed'))
    }

    get isOk$(): Observable<boolean> {
        return this.kind$.pipe(map(k => k === 'ok'))
    }
}
