import { map, type Observable } from 'rxjs'
import type { RuntimeWorkspace, DependencyGraph, QualifiedName } from '../types/runtime-filesystem.types.js'
import type { SerializedDependencyGraph } from '../types/serialized-filesystem.types.js'
import { flattenFiles$ } from './flatten-files.js'
import { parseImports } from './import-graph.js'
import { hashContent } from './content-hash.js'

interface ImportCacheEntry {
    content: string
    imports: QualifiedName[]
}

/**
 * The reactive composition behind `RuntimeFilesystem.dependencyGraph$`.
 * Owns a real content-keyed cache, closure-scoped to this one call (there
 * is exactly one `RuntimeFilesystemService` instance, so exactly one of
 * these caches exists) - re-parsing every file's imports on every single
 * edit to any file, anywhere, is the same "redo everything from scratch"
 * problem `moduleCache` fixes in `sandbox.worker.ts`, and this is the same
 * fix: only a file whose content actually changed gets re-parsed, every
 * other file's edges are reused untouched.
 *
 * `seed`, if given, pre-warms this cache from a previous session's
 * persisted graph (see `SerializedDependencyGraph`'s doc comment) -
 * checked per file against `seed.contentHashes`, so a file whose content
 * doesn't match what the seed was computed against just parses fresh
 * instead of trusting stale edges.
 */
export function deriveDependencyGraph$(
    workspaces$: Observable<ReadonlyMap<string, RuntimeWorkspace>>,
    seed?: SerializedDependencyGraph,
): Observable<DependencyGraph> {
    const cache = new Map<QualifiedName, ImportCacheEntry>()

    return flattenFiles$(workspaces$).pipe(
        map((files): DependencyGraph => {
            const available = new Set<QualifiedName>(files.map(f => f.name))

            // Prune first: a file no longer in the pool stops being cached.
            for (const name of cache.keys()) if (!available.has(name)) cache.delete(name)

            for (const file of files) {
                const cached = cache.get(file.name)
                if (cached && cached.content === file.content) continue

                // Only ever consulted the first time this file is seen
                // (`!cached`) - once the cache has its own live entry, the
                // content comparison above takes over and the seed is
                // irrelevant, exactly as it should be: a one-time
                // startup optimization, not an ongoing source of truth.
                if (!cached && seed?.contentHashes[file.name] === hashContent(file.content)) {
                    cache.set(file.name, { content: file.content, imports: seed.imports[file.name] ?? [] })
                    continue
                }

                cache.set(file.name, { content: file.content, imports: parseImports(file.name, file.content, available) as QualifiedName[] })
            }

            const imports = new Map<QualifiedName, Set<QualifiedName>>()
            const dependents = new Map<QualifiedName, Set<QualifiedName>>()
            for (const name of available) {
                imports.set(name, new Set())
                dependents.set(name, new Set())
            }
            for (const name of available) {
                for (const dep of cache.get(name)!.imports) {
                    imports.get(name)!.add(dep)
                    dependents.get(dep)?.add(name)
                }
            }

            return { imports, dependents }
        }),
    )
}
