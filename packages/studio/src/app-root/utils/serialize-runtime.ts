import { combineLatest, switchMap, map, of, type Observable } from 'rxjs'
import type { DependencyGraph, QualifiedName, RuntimeWorkspace } from '../types/runtime-filesystem.types.js'
import type { SerializedWorkspace, SerializedWorkspaceFile, SerializedDependencyGraph, WorkspaceManifest, WorkspaceFileNode } from '../types/serialized-filesystem.types.js'
import { flattenFiles$ } from './flatten-files.js'
import { hashContent } from './content-hash.js'

/**
 * 'blocked' is live-only: it means "waiting on live upstream machines",
 * and those don't exist at hydration time - a cold-started file can't
 * meaningfully re-enter it (its waitingOn set would be stale fiction).
 * Persisted, a blocked run and an analyzing run are the same fact - a run
 * that never completed - and both hydrate as 'analyzing', which
 * RuntimeFilesystemService's post-hydration kick list re-runs. The
 * remaining nodes are exactly the serialized vocabulary.
 */
function toSerializedStatus(node: string): WorkspaceFileNode {
    return node === 'blocked' ? 'analyzing' : node as WorkspaceFileNode
}

/** The live serialized projection of one runtime workspace - every file's `content$` and `machine.state$`, recombined on any change. */
export function toSerializedWorkspace$(workspace: RuntimeWorkspace, manifest: WorkspaceManifest): Observable<SerializedWorkspace> {
    return workspace.files$.pipe(
        switchMap(files => {
            const entries = [...files.values()]
            return entries.length === 0
                ? of<SerializedWorkspaceFile[]>([])
                : combineLatest(entries.map(f => combineLatest([f.content$, f.machine.state$]).pipe(
                    map(([content, s]): SerializedWorkspaceFile => {
                        const data = s.data as { analysis?: unknown; stale?: unknown; error?: string }
                        return {
                            name: f.name,
                            content,
                            status: toSerializedStatus(s.node),
                            analysis: (data.analysis ?? data.stale) as SerializedWorkspaceFile['analysis'],
                            error: data.error,
                        }
                    }),
                )))
        }),
        map((files): SerializedWorkspace => ({ name: workspace.name, manifest, files })),
    )
}

function toEntries(map: ReadonlyMap<QualifiedName, ReadonlySet<QualifiedName>>): Record<QualifiedName, QualifiedName[]> {
    return Object.fromEntries([...map].map(([k, v]) => [k, [...v]]))
}

/**
 * The JSON-safe, self-validating projection of the live dependency graph -
 * `contentHashes` alongside the edges is what lets `deriveDependencyGraph$`
 * trust a persisted record per file on a future cold start (see
 * `SerializedDependencyGraph`'s doc comment).
 */
export function toSerializedDependencyGraph$(
    workspaces$: Observable<ReadonlyMap<string, RuntimeWorkspace>>,
    dependencyGraph$: Observable<DependencyGraph>,
): Observable<SerializedDependencyGraph> {
    return combineLatest([dependencyGraph$, flattenFiles$(workspaces$)]).pipe(
        map(([graph, files]): SerializedDependencyGraph => ({
            imports: toEntries(graph.imports),
            dependents: toEntries(graph.dependents),
            contentHashes: Object.fromEntries(files.map(f => [f.name, hashContent(f.content)])),
        })),
    )
}
