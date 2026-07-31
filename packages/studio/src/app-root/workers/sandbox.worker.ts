import type { IncidenceGraphSet, IncidenceGraphSetMixin, IncidenceMachineMixin, EdgeDef, NodeData, TransitionDef, DepNodeRef } from '@yaw-rx/ystate'
import { IncidenceGraphSetClosureError, IncidenceMachineClosureError } from '@yaw-rx/ystate'
import type { SandboxCommand, SandboxResponse, SerializedEdge, SerializedGraphSet, GraphKind, ClosureResult, WorkspaceFile, RuntimeKind } from '../services/sandbox.service.js'
import type { QualifiedName } from '../types/runtime-filesystem.types.js'
import { parseImports, buildExecutionOrder } from '../utils/import-graph.js'
import { BUILTIN_MODULES, transpile, rewriteRequires, executeModule } from '../utils/execute-module.js'
import { isObservable } from '../guards/is-observable.js'
import { isIncidenceGraphSetMixin } from '../guards/is-incidence-graph-set-mixin.js'
import { isIncidenceMachineMixin } from '../guards/is-incidence-machine-mixin.js'

// --- Per-file execution cache ---

/**
 * One file's last-executed result, kept across `evaluate` calls. `content`
 * is the invalidation key - exact source last executed against, compared
 * directly rather than hashed (see docs/filesystem-runtime.md §4: at this
 * app's scale, direct comparison is simpler and has zero collision risk).
 * Everything else is what a fresh execution would otherwise have to redo:
 * the module's exports and every export's classification.
 */
interface FileExecutionCache {
    content: string
    exports: Record<string, unknown>
    runtimeKinds: Record<string, RuntimeKind>
    graphs: Record<string, SerializedGraphSet>
    graphKinds: Record<string, GraphKind>
    transitionKeys: Record<string, string[]>
}
const moduleCache = new Map<QualifiedName, FileExecutionCache>()

/** The live value behind a 'graph-set'/'machine' classified export - exactly what isIncidenceGraphSetMixin/isIncidenceMachineMixin narrow to, for handleClose(). */
type LiveGraphValue =
    | IncidenceGraphSetMixin<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef>>>>
    | IncidenceMachineMixin<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>
const liveExports = new Map<string, LiveGraphValue>()

// --- Serialization ---

function serializeGraphSet(obj: unknown): SerializedGraphSet | null {
    if (!obj || typeof obj !== 'object') return null

    const candidate = obj as Record<string, unknown>

    if (!('nodes' in candidate) || !('edges' in candidate)) return null

    const gs = candidate as unknown as IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef<Record<string, NodeData>>>>

    const edges: Record<string, SerializedEdge> = {}
    for (const [name, edge] of Object.entries(gs.edges)) {
        const to = typeof edge.to === 'string'
            ? edge.to
            : { __brand: 'depNodeRef' as const, dep: (edge.to as DepNodeRef).dep, node: (edge.to as DepNodeRef).node }
        edges[name] = { from: edge.from, to, on: edge.on }
    }

    const deps: Record<string, SerializedGraphSet> = {}
    if (gs.deps) {
        for (const [name, dep] of Object.entries(gs.deps)) {
            const serialized = serializeGraphSet(dep)
            if (serialized) deps[name] = serialized
        }
    }

    return {
        nodes: structuredClone(gs.nodes),
        edges,
        deps,
    }
}

// Every export gets classified as exactly one RuntimeKind - never skipped,
// never null. 'plain-value' is a real classification, not an absence of one.
function detectKind(value: unknown): RuntimeKind {
    if (typeof value === 'function') return 'function'
    if (isIncidenceGraphSetMixin(value)) return 'graph-set'
    if (isIncidenceMachineMixin(value)) return 'machine'
    if (isObservable(value)) return 'observable'
    return 'plain-value'
}

// --- Command handlers ---

/** Merges every requested file's (cached-or-fresh) per-export data into one qualified-name-keyed aggregate. */
function mergeAggregate(files: readonly { name: QualifiedName }[]): Extract<SandboxResponse, { command: 'evaluate' }> & { id: number } {
    const runtimeKinds: Record<string, RuntimeKind> = {}
    const graphs: Record<string, SerializedGraphSet> = {}
    const graphKinds: Record<string, GraphKind> = {}
    const transitionKeys: Record<string, string[]> = {}

    for (const file of files) {
        const entry = moduleCache.get(file.name)
        if (!entry) continue
        for (const [exportName, kind] of Object.entries(entry.runtimeKinds)) runtimeKinds[`${file.name}:${exportName}`] = kind
        for (const [exportName, g] of Object.entries(entry.graphs)) graphs[`${file.name}:${exportName}`] = g
        for (const [exportName, gk] of Object.entries(entry.graphKinds)) graphKinds[`${file.name}:${exportName}`] = gk
        for (const [exportName, tk] of Object.entries(entry.transitionKeys)) transitionKeys[`${file.name}:${exportName}`] = tk
    }

    return { id: 0, command: 'evaluate', runtimeKinds, graphs, graphKinds, transitionKeys }
}

function handleEvaluate(files: WorkspaceFile[]): Extract<SandboxResponse, { command: 'evaluate' }> & { id: number } {
    const tsFiles = files.filter(f => f.name.endsWith('.ts'))
    const available = new Set<QualifiedName>(tsFiles.map(f => f.name))

    // Prune first: a file no longer in the pool stops being cached, not leaked forever.
    for (const name of moduleCache.keys()) if (!available.has(name)) moduleCache.delete(name)
    for (const key of liveExports.keys()) if (!available.has(key.slice(0, key.lastIndexOf(':')) as QualifiedName)) liveExports.delete(key)

    const ordered = buildExecutionOrder(tsFiles)
    const dirty = new Set<QualifiedName>()
    const modules: Record<string, unknown> = { ...BUILTIN_MODULES }

    for (const file of ordered) {
        const cached = moduleCache.get(file.name)
        const dependencyDirty = parseImports(file.name, file.content, available).some(dep => dirty.has(dep as QualifiedName))
        const directlyDirty = !cached || cached.content !== file.content

        if (!directlyDirty && !dependencyDirty) {
            modules[file.name] = cached.exports
            continue
        }

        dirty.add(file.name)
        const js = rewriteRequires(transpile(file.name, file.content), file.name, available)
        const exports = executeModule(js, modules)
        modules[file.name] = exports

        for (const key of liveExports.keys()) if (key.startsWith(`${file.name}:`)) liveExports.delete(key)

        const runtimeKinds: Record<string, RuntimeKind> = {}
        const graphs: Record<string, SerializedGraphSet> = {}
        const graphKinds: Record<string, GraphKind> = {}
        const transitionKeys: Record<string, string[]> = {}

        for (const [exportName, value] of Object.entries(exports)) {
            const kind = detectKind(value)
            runtimeKinds[exportName] = kind

            if (kind === 'graph-set' || kind === 'machine') {
                liveExports.set(`${file.name}:${exportName}`, value as LiveGraphValue)
                graphKinds[exportName] = kind
                const serialized = serializeGraphSet(value)
                if (serialized) graphs[exportName] = serialized
                if (kind === 'machine') {
                    const obj = value as Record<string, unknown>
                    transitionKeys[exportName] = Object.keys(obj.transitions as Record<string, unknown>)
                }
            }
        }

        moduleCache.set(file.name, { content: file.content, exports, runtimeKinds, graphs, graphKinds, transitionKeys })
    }

    return mergeAggregate(ordered)
}

function handleClose(key: string): ClosureResult {
    const value = liveExports.get(key)
    if (!value) throw new Error(`Export '${key}' has no close() method`)
    try {
        const closed = value.close()
        const warnings = 'validate' in closed ? closed.validate() : []
        return { success: true, warnings }
    } catch (e) {
        if (e instanceof IncidenceGraphSetClosureError) {
            return { success: false, issues: e.issues }
        }
        if (e instanceof IncidenceMachineClosureError) {
            return { success: false, issues: e.issues }
        }
        throw e
    }
}

// --- Message dispatch ---

self.onmessage = (event: MessageEvent<SandboxCommand>) => {
    const msg = event.data
    try {
        switch (msg.command) {
            case 'evaluate': {
                const result = handleEvaluate(msg.files)
                self.postMessage({ ...result, id: msg.id } satisfies SandboxResponse)
                break
            }
            case 'close': {
                const result = handleClose(msg.key)
                self.postMessage({ id: msg.id, command: 'close', key: msg.key, result } satisfies SandboxResponse)
                break
            }
        }
    } catch (e) {
        // Message only, no stack: the code that threw is transpiled,
        // require-rewritten, and eval'd - stack line numbers point into
        // that garbled intermediate, not the user's source, so they'd
        // only mislead.
        self.postMessage({ id: msg.id, command: 'error', error: e instanceof Error ? e.message : String(e) } satisfies SandboxResponse)
    }
}
