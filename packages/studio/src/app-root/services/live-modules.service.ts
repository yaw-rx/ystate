import { Injectable } from '@yaw-rx/core'
import type { QualifiedName } from '../types/runtime-filesystem.types.js'
import type { FlatFile } from '../utils/flatten-files.js'
import { parseImports, buildExecutionOrder } from '../utils/import-graph.js'
import { fileKindOf } from '../utils/file-kind.js'
import { BUILTIN_MODULES, transpile, rewriteRequires, executeModule } from '../utils/execute-module.js'

interface LiveModuleCacheEntry {
    /** The invalidation key - the exact source last executed. Same rule as the worker's moduleCache. */
    content: string
    exports: Record<string, unknown>
}

/**
 * The main-thread twin of the sandbox worker's execution loop, for Play.
 * The worker exists to *analyze* - classify exports, serialize graphs -
 * and its module instances live on the worker thread where no form can
 * bind them. A running form needs the real thing on the main thread:
 * the actual `BehaviorSubject` a slider writes into, the actual machine
 * definition `init()` starts.
 *
 * The cache's stability IS the form-tag contract: a form's custom-element
 * tag is content-addressed over its own sections plus every transitive
 * import's content (see create-form-component.ts). This cache is keyed by
 * exactly the same thing - per-file content plus dependency dirtiness - so
 * an unchanged tag always means the previously generated class still
 * closes over the instances this registry currently holds, and a changed
 * upstream re-executes precisely the files whose instances (and therefore
 * whose dependent form classes) went stale.
 */
@Injectable()
export class LiveModulesService {
    private readonly cache = new Map<QualifiedName, LiveModuleCacheEntry>()

    /**
     * Drop every cached module. The cache's invalidation key is content, but a
     * module's exports can hold *stopped* machine instances once a Play session
     * ends - content unchanged, yet the instances are dead and must not be
     * reused. Stop calls this so the next Play re-evaluates every closure and
     * gets fresh, running instances.
     */
    reset(): void {
        this.cache.clear()
    }

    /** Executes the pool (topological order, cached per file), returning every file's live exports. Includes forms - their scripts are real modules that import from the ts collection. */
    run(pool: readonly FlatFile[]): ReadonlyMap<QualifiedName, Record<string, unknown>> {
        const sources = pool.filter(f => fileKindOf(f.name) !== undefined)
        const available = new Set<QualifiedName>(sources.map(f => f.name))

        // Prune first: a file no longer in the pool stops being cached, not leaked forever.
        for (const name of this.cache.keys()) if (!available.has(name)) this.cache.delete(name)

        const ordered = buildExecutionOrder(sources)
        const dirty = new Set<QualifiedName>()
        const modules: Record<string, unknown> = { ...BUILTIN_MODULES }
        const registry = new Map<QualifiedName, Record<string, unknown>>()

        for (const file of ordered) {
            const cached = this.cache.get(file.name)
            const dependencyDirty = parseImports(file.name, file.content, available).some(dep => dirty.has(dep as QualifiedName))
            const directlyDirty = !cached || cached.content !== file.content

            if (!directlyDirty && !dependencyDirty) {
                modules[file.name] = cached.exports
                registry.set(file.name, cached.exports)
                continue
            }

            dirty.add(file.name)
            const js = rewriteRequires(transpile(file.name, file.content), file.name, available)
            const exports = executeModule(js, modules)
            modules[file.name] = exports
            this.cache.set(file.name, { content: file.content, exports })
            registry.set(file.name, exports)
        }

        return registry
    }
}
