import { combineLatest, map, switchMap, of, type Observable } from 'rxjs'
import type { RuntimeWorkspace, QualifiedName } from '../types/runtime-filesystem.types.js'

export interface FlatFile {
    name: QualifiedName
    content: string
}

/**
 * Every file across every workspace, flat, live. Two dynamic-set levels -
 * which workspaces exist, which files exist within one - both tracked via
 * `switchMap`, so files or workspaces being added or removed is handled,
 * not just edits to a fixed set. Shared by `deriveDependencyGraph$` and
 * `WorkspaceEvaluationService.evaluateFile` so there is exactly one way
 * "the current pool of files" gets computed.
 */
export function flattenFiles$(workspaces$: Observable<ReadonlyMap<string, RuntimeWorkspace>>): Observable<FlatFile[]> {
    return workspaces$.pipe(
        switchMap(workspaces => {
            const perWorkspaceFiles$ = [...workspaces.values()].map(ws => ws.files$)
            return perWorkspaceFiles$.length === 0
                ? of([])
                : combineLatest(perWorkspaceFiles$).pipe(map(fileMaps => fileMaps.flatMap(files => [...files.values()])))
        }),
        switchMap(files => {
            if (files.length === 0) return of<FlatFile[]>([])
            return combineLatest(files.map(f => f.content$.pipe(map(content => ({ name: f.qualifiedName, content })))))
        }),
    )
}
