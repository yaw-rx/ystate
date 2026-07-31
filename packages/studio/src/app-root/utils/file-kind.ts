import type { FileKind } from '../types/serialized-filesystem.types.js'

/**
 * A form (`<name>.form`) is a distinct thing from a ts file, not a ts file
 * with extra parts: it is a triad (template/script/styles) evaluated in its
 * own sandbox, and it is NEVER part of the ts collection pool. A ts file
 * (`<name>.ts`) is a concept the collection compiles and the forms import
 * from. Keeping the two kinds fully separate here is what lets their
 * analysis, sandboxes, and terminals stay decoupled.
 */
export function fileKindOf(name: string): FileKind | undefined {
    if (name.endsWith('.form')) return 'form'
    if (name.endsWith('.ts')) return 'ts-file'
    return undefined
}
