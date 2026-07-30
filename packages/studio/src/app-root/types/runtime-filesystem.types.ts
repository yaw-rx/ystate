import type { Observable, Subject } from 'rxjs'
import type { RunningMachine } from '@yaw-rx/ystate'
import type * as monaco from 'monaco-editor'

/** `"workspace/file"` - the addressing scheme `RuntimeFilesystemService` and `SandboxService` key by. */
export type QualifiedName = `${string}/${string}`

/**
 * The import graph across every workspace, not scoped to one - workspaces
 * are folders, not evaluation boundaries, so a file in one workspace can
 * depend on a file in another. `imports` and `dependents` are inverses of
 * each other, kept as separate maps so lookups in either direction are O(1).
 */
export interface DependencyGraph {
    readonly imports: ReadonlyMap<QualifiedName, ReadonlySet<QualifiedName>>
    readonly dependents: ReadonlyMap<QualifiedName, ReadonlySet<QualifiedName>>
}

/**
 * One file, live: its Monaco model (the sole source of truth for its
 * current text) and its analysis machine (`state$`/`event$`/`status$`).
 * `request$` is how anything - a content edit, a dependency settling,
 * initial hydration - asks the machine to (re)analyze.
 */
export interface RuntimeFile {
    readonly qualifiedName: QualifiedName
    readonly workspace: string
    readonly name: string
    /** The live model, for anything that needs to attach it to an actual editor widget. */
    readonly model: monaco.editor.ITextModel
    /** `modelContent$(model)` (utils/model-content.ts) - the same content as `model`, as one shared multicast stream. What the dependency graph and anything else reacting to edits composes off. */
    readonly content$: Observable<string>
    readonly machine: RunningMachine
    readonly request$: Subject<void>
    /** Fires the machine's terminal `removed` node - the actual disposal mechanism, see `machines/workspace-file.machine.ts`. */
    readonly dispose$: Subject<void>
}

export interface RuntimeWorkspace {
    readonly name: string
    readonly files$: Observable<ReadonlyMap<string, RuntimeFile>>
}

/**
 * The dynamic tree, inflated once from a `SerializedFilesystem` and live
 * from then on. Every component binds here, never to the serialized side -
 * observables all the way down, the same as everything else this app's
 * bindings already handle.
 */
export interface RuntimeFilesystem {
    readonly workspaces$: Observable<ReadonlyMap<string, RuntimeWorkspace>>
    readonly dependencyGraph$: Observable<DependencyGraph>
}
