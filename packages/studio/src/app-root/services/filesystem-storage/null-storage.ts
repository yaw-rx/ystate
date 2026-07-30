import { Injectable } from '@yaw-rx/core'
import type { SerializedWorkspace, SerializedDependencyGraph } from '../../types/serialized-filesystem.types.js'
import { FilesystemStorage } from '../filesystem-storage.js'

/**
 * A `FilesystemStorage` that persists nothing - every workspace is a fresh
 * `default-workspaces.ts` seed on load, every save/delete is a no-op.
 * Swapped in for `LocalStorageFilesystemStorage` so the app never touches
 * `localStorage`, avoiding the consent/cookie-banner requirement that
 * writing to browser storage would otherwise trigger.
 */
@Injectable()
export class NullFilesystemStorage extends FilesystemStorage {
    async loadAll(): Promise<SerializedWorkspace[]> {
        return []
    }

    async saveWorkspace(_workspace: SerializedWorkspace): Promise<void> {}

    async deleteWorkspace(_name: string): Promise<void> {}

    async saveDependencyGraph(_graph: SerializedDependencyGraph): Promise<void> {}

    async loadDependencyGraph(): Promise<SerializedDependencyGraph | null> {
        return null
    }
}
