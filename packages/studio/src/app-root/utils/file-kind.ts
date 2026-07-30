import type { FileKind } from '../types/serialized-filesystem.types.js'

const EXT_KIND: Record<string, FileKind> = {
    '.ts': 'ts-file',
}

export function fileKindOf(name: string): FileKind | undefined {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? undefined : EXT_KIND[name.slice(dot)]
}
