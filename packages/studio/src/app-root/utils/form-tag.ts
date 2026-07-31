import type { DependencyGraph, QualifiedName } from '../types/runtime-filesystem.types.js'
import type { FlatFile } from './flatten-files.js'
import { hashContent } from './content-hash.js'

/**
 * The content-addressed custom-element tag for a form. It is the shared
 * invalidation key between two caches: this tag registry (a defined custom
 * element can never be redefined) and LiveModulesService's execution cache.
 *
 * The key is the form's own three sections PLUS the content of every file
 * in its transitive import closure - because the generated component's
 * getters close over live module instances, and those instances change
 * whenever any upstream file's content changes, not just the form's own.
 * Keying on the form alone would let a stale class (closed over old
 * instances) be reused after an upstream edit. Per-file hashes are
 * concatenated (not hashed down again) so distinct upstream states can't
 * collapse to one 32-bit value.
 *
 * Names are sorted so traversal order never affects the tag.
 */
export function formTag(
    form: { qualifiedName: QualifiedName; script: string; template: string; styles: string },
    pool: readonly FlatFile[],
    graph: DependencyGraph,
): string {
    const contentByName = new Map(pool.map(f => [f.name, f.content]))

    // Transitive import closure of the form's script.
    const closure = new Set<QualifiedName>()
    const visit = (name: QualifiedName): void => {
        for (const dep of graph.imports.get(name) ?? []) {
            if (closure.has(dep)) continue
            closure.add(dep)
            visit(dep)
        }
    }
    visit(form.qualifiedName)

    const upstream = [...closure].sort()
        .map(name => `${name}:${hashContent(contentByName.get(name) ?? '')}`)
        .join('|')

    const own = [
        hashContent(form.script),
        hashContent(form.template),
        hashContent(form.styles),
    ].join('-')

    // A custom-element name must be lowercase, start with a letter, and
    // contain a hyphen. `form-` prefix + slug of the qualified name +
    // the hashes satisfies that; the qualified name is only for legibility
    // in devtools, the hashes carry the identity.
    const slug = form.qualifiedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return `form-${slug}-${own}-${hashContent(upstream)}`
}
