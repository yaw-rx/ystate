import type { QualifiedName } from '../types/runtime-filesystem.types.js'

/** The one place a `QualifiedName` gets split back into its workspace/file parts. */
export function splitQualifiedName(name: QualifiedName): { workspace: string; file: string } {
    const slash = name.indexOf('/')
    return { workspace: name.slice(0, slash), file: name.slice(slash + 1) }
}

/** The one place a workspace/file pair gets joined into a `QualifiedName`. */
export function toQualifiedName(workspace: string, file: string): QualifiedName {
    return `${workspace}/${file}`
}
