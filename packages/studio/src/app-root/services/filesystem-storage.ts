import type { SerializedWorkspace, SerializedDependencyGraph } from '../types/serialized-filesystem.types.js'

/**
 * The DI token for `FilesystemStorage` - a `symbol`, not the class itself.
 * `@yaw-rx/core`'s `Token` type is `Ctor<T> | symbol | string`, where
 * `Ctor<T> = new (...args) => T` requires genuine instantiability; an
 * `abstract class` can never satisfy that (you can never legally write
 * `new FilesystemStorage()`), so it can't be a DI token as typed. This
 * symbol is the token providers/injection sites use; `FilesystemStorage`
 * itself remains the type a constructor parameter is annotated with.
 */
export const FILESYSTEM_STORAGE = Symbol('FilesystemStorage')

/**
 * The port `RuntimeFilesystemService` persists and seeds through - granular
 * per-workspace, not one filesystem-sized blob, so a real adapter (IndexedDB,
 * a backend API) only ever reads/writes the one record that actually
 * changed. `RuntimeFilesystemService` depends on this abstraction, never a
 * concrete storage mechanism directly - swapping localStorage for something
 * real later is providing a different `useClass` in app-root.ts.
 *
 * `saveDependencyGraph`/`loadDependencyGraph` are self-validating, not a
 * blob export: `contentHashes` on `SerializedDependencyGraph` (see its own
 * doc comment) is what lets `derive-dependency-graph.ts` trust a persisted
 * file's edges per file, on a future cold start, without needing this
 * record and a workspace's own save to have landed at the same moment.
 */
export abstract class FilesystemStorage {
    abstract loadAll(): Promise<SerializedWorkspace[]>
    abstract saveWorkspace(workspace: SerializedWorkspace): Promise<void>
    abstract deleteWorkspace(name: string): Promise<void>
    abstract saveDependencyGraph(graph: SerializedDependencyGraph): Promise<void>
    abstract loadDependencyGraph(): Promise<SerializedDependencyGraph | null>
}

/** A stored record existed but couldn't be parsed back into its type. Thrown, never caught-and-logged inside a storage adapter - deciding what a corrupt record means is the caller's call, not the adapter's. */
export class StorageDeserializationError extends Error {
    constructor(key: string, cause: unknown) {
        super(`Failed to deserialize stored value at '${key}'`, { cause })
        this.name = 'StorageDeserializationError'
    }
}

/** A value couldn't be turned into its stored form (e.g. a circular structure, or the underlying store rejecting the write). */
export class StorageSerializationError extends Error {
    constructor(key: string, cause: unknown) {
        super(`Failed to serialize value for '${key}'`, { cause })
        this.name = 'StorageSerializationError'
    }
}
