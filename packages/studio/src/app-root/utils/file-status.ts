import { type Observable, map } from 'rxjs'
import type { RuntimeFile } from '../types/runtime-filesystem.types.js'
import type { FileAnalysis } from '../types/serialized-filesystem.types.js'
import type { StatusIconKind } from '../components/status-icon.component.js'

/**
 * The single classifier for a file's health - file rows, workspace rollups,
 * and anything else showing status all derive from here, so no two views
 * can ever disagree about the same file. Every kind of problem collapses
 * into one 'failed': a machine-level failure (the pool didn't evaluate -
 * syntax errors land here), compiler diagnostics with errors, or any
 * export whose closure failed. The distinction between those lives in the
 * detail views (terminal output, export rows), not in the icon.
 */
export function analysisHasErrors(analysis: FileAnalysis | undefined): boolean {
    if (!analysis) return false
    if (analysis.diagnostics.some(d => d.category === 'error')) return true
    return analysis.exports.some(e =>
        e.runtime.status === 'evaluated'
        && (e.runtime.kind === 'graph-set' || e.runtime.kind === 'machine')
        && e.runtime.closure?.success === false,
    )
}

export function fileStatusIconKind$(file: RuntimeFile): Observable<StatusIconKind> {
    return file.machine.state$.pipe(map(s => {
        if (s.node === 'failed') return 'failed'
        if (s.node === 'blocked') return 'blocked'
        if (s.node === 'analyzing' || s.node === 'unanalyzed') return 'analyzing'
        if (s.node === 'analyzed' && analysisHasErrors((s.data as { analysis?: FileAnalysis }).analysis)) return 'failed'
        return 'ok'
    }))
}

/**
 * The coarse tier a workspace rolls its files up into - `error` outranks
 * `progress` outranks `ok`, so one broken or in-flight file anywhere in a
 * workspace is what the workspace-level icon shows. Derived from the icon
 * kind, never computed independently: blocked and analyzing both read as
 * "hasn't settled yet" at the rollup level even though the per-file icon
 * still distinguishes them.
 */
export type StatusTier = 'error' | 'progress' | 'ok'

const KIND_TIER: Record<StatusIconKind, StatusTier> = {
    failed: 'error',
    blocked: 'progress',
    analyzing: 'progress',
    ok: 'ok',
}

const TIER_RANK: Record<StatusTier, number> = { error: 0, progress: 1, ok: 2 }

export function fileStatusTier$(file: RuntimeFile): Observable<StatusTier> {
    return fileStatusIconKind$(file).pipe(map(kind => KIND_TIER[kind]))
}

export function worstTier(tiers: readonly StatusTier[]): StatusTier {
    let worst: StatusTier = 'ok'
    for (const t of tiers) if (TIER_RANK[t] < TIER_RANK[worst]) worst = t
    return worst
}
