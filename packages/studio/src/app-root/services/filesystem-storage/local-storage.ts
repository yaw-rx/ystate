import { Injectable } from '@yaw-rx/core'
import type { SerializedWorkspace, SerializedDependencyGraph } from '../../types/serialized-filesystem.types.js'
import { FilesystemStorage, StorageDeserializationError, StorageSerializationError } from '../filesystem-storage.js'

const KEY_PREFIX = 'yaw-studio:workspace:'
const INDEX_KEY = 'yaw-studio:workspace-names'
const DEPENDENCY_GRAPH_KEY = 'yaw-studio:dependency-graph'

function parse<T>(key: string, raw: string): T {
    try {
        return JSON.parse(raw) as T
    } catch (e) {
        throw new StorageDeserializationError(key, e)
    }
}

function stringify(key: string, value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch (e) {
        throw new StorageSerializationError(key, e)
    }
}

function indexOf(): string[] {
    const raw = localStorage.getItem(INDEX_KEY)
    return raw ? parse<string[]>(INDEX_KEY, raw) : []
}

function writeIndex(names: string[]): void {
    localStorage.setItem(INDEX_KEY, stringify(INDEX_KEY, names))
}

@Injectable()
export class LocalStorageFilesystemStorage extends FilesystemStorage {
    async loadAll(): Promise<SerializedWorkspace[]> {
        return indexOf().flatMap(name => {
            const raw = localStorage.getItem(KEY_PREFIX + name)
            return raw ? [parse<SerializedWorkspace>(KEY_PREFIX + name, raw)] : []
        })
    }

    async saveWorkspace(workspace: SerializedWorkspace): Promise<void> {
        localStorage.setItem(KEY_PREFIX + workspace.name, stringify(KEY_PREFIX + workspace.name, workspace))
        const names = indexOf()
        if (!names.includes(workspace.name)) writeIndex([...names, workspace.name])
    }

    async deleteWorkspace(name: string): Promise<void> {
        localStorage.removeItem(KEY_PREFIX + name)
        writeIndex(indexOf().filter(n => n !== name))
    }

    async saveDependencyGraph(graph: SerializedDependencyGraph): Promise<void> {
        localStorage.setItem(DEPENDENCY_GRAPH_KEY, stringify(DEPENDENCY_GRAPH_KEY, graph))
    }

    async loadDependencyGraph(): Promise<SerializedDependencyGraph | null> {
        const raw = localStorage.getItem(DEPENDENCY_GRAPH_KEY)
        return raw ? parse<SerializedDependencyGraph>(DEPENDENCY_GRAPH_KEY, raw) : null
    }
}
