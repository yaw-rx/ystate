import type { RuntimeKind, GraphKind, ClosureResult, SerializedGraphSet } from '../services/sandbox.service.js'
import type { StaticExportInfo, FileDiagnostic } from '../services/type-analysis.service.js'
import type { QualifiedName } from './runtime-filesystem.types.js'

/** The only two things a file in the ecosystem can be: a form (html+css+ts bundle) or a plain .ts file exporting concepts. */
export type FileKind = 'ts-file' | 'form'

/** The lifecycle node a workspace file's analysis machine can occupy - `removed` is its terminal node (see machines/workspace-file.machine.ts). */
export type WorkspaceFileNode = 'unanalyzed' | 'analyzing' | 'analyzed' | 'failed' | 'removed'

/**
 * The JSON-safe form of `DependencyGraph` (which is `Map`/`Set`-keyed, not
 * serializable directly) - filesystem-level, spans every workspace, so it
 * doesn't belong to any one `SerializedWorkspace` record.
 *
 * `contentHashes` is what makes this genuinely reusable, not just an
 * export: `derive-dependency-graph.ts`'s in-session cache trusts a
 * persisted file's edges only if `hashContent(currentContent) ===
 * contentHashes[name]` - self-validating per file, so it never depends on
 * this record and a workspace's own persistence machine having saved at
 * the same moment. A mismatched or missing file just gets re-parsed once;
 * nothing else is discarded.
 */
export interface SerializedDependencyGraph {
    imports: Record<QualifiedName, QualifiedName[]>
    dependents: Record<QualifiedName, QualifiedName[]>
    contentHashes: Record<QualifiedName, string>
}

/**
 * What the sandbox found for an export at runtime. `evaluated` splits by
 * kind: `graph-set`/`machine` carry `serialized`/`closure` (optional only
 * because serialization or closure can itself fail on an otherwise-live
 * value), while `observable`/`function`/`plain-value` never have them at
 * all - not "usually absent," structurally absent. `type-only` is an
 * `export type`/`export interface`: resolved statically but erased at
 * emit, so no runtime value ever existed for it.
 *
 * There is no "unevaluated" variant: a `FileAnalysis` only ever exists as
 * the result of a successful `analyze` transition (see
 * `machines/workspace-file.machine.ts`) - if evaluation fails, the file's
 * machine goes to `failed` with a file-level `error`, not a `FileAnalysis`
 * full of per-export placeholders. `stale` on `analyzing`/`failed` is
 * always a genuinely-succeeded past `FileAnalysis`.
 */
export type ExportRuntimeInfo =
    | { status: 'evaluated'; kind: 'graph-set'; serialized?: SerializedGraphSet; closure?: ClosureResult }
    | { status: 'evaluated'; kind: 'machine'; serialized?: SerializedGraphSet; closure?: ClosureResult; transitionKeys?: string[] }
    | { status: 'evaluated'; kind: Exclude<RuntimeKind, GraphKind> }
    | { status: 'type-only' }

/**
 * One classified export of a workspace file: what the checker resolves for
 * it statically (signature and brand, independent of whether the code ever
 * runs) alongside what actually happened when it was evaluated.
 */
export interface ExportRecord {
    name: string
    static: StaticExportInfo
    runtime: ExportRuntimeInfo
}

/** The analysis of a single workspace file: its compiler diagnostics and its classified exports. */
export interface FileAnalysis {
    diagnostics: FileDiagnostic[]
    exports: ExportRecord[]
}

export interface ElementMetadata {
    x?: number
    y?: number
    comment?: string
    annotations?: Record<string, string>
}

/** One per workspace, never rendered as a file in the tree - not part of `files`. */
export interface WorkspaceManifest {
    name: string
    concepts: string[]
    metadata: Record<string, ElementMetadata>
}

/**
 * A workspace file as persisted: content plus the last-known analysis
 * status/result. This is a hydration source, not something any component
 * binds to directly - the runtime filesystem is what's live.
 */
export interface SerializedWorkspaceFile {
    name: string
    content: string
    status: WorkspaceFileNode
    analysis?: FileAnalysis
    error?: string
}

export interface SerializedWorkspace {
    name: string
    manifest: WorkspaceManifest
    files: SerializedWorkspaceFile[]
}

/**
 * The full persisted shape - every workspace plus the filesystem-level
 * dependency graph. `FilesystemStorage` never reads or writes this as one
 * unit (workspaces are stored one record each, the graph separately) -
 * this type is the whole-picture view, e.g. for exporting everything as a
 * single downloadable snapshot.
 */
export interface SerializedFilesystem {
    workspaces: SerializedWorkspace[]
    dependencyGraph: SerializedDependencyGraph
}
