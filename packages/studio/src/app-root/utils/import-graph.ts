import ts from 'typescript'

function dirnameOf(qualifiedName: string): string {
    const slash = qualifiedName.lastIndexOf('/')
    return slash === -1 ? '' : qualifiedName.slice(0, slash)
}

function joinPath(baseDir: string, specifier: string): string {
    const parts = baseDir ? baseDir.split('/') : []
    for (const part of specifier.split('/')) {
        if (part === '' || part === '.') continue
        else if (part === '..') parts.pop()
        else parts.push(part)
    }
    return parts.join('/')
}

/**
 * Resolves an import specifier written from `fromName` against the pool of
 * qualified names that actually exist. Relative paths cross workspace
 * boundaries the same way they'd cross any folder boundary (`../other/x.js`
 * from `ws/file.ts` resolves against `other/x.ts`) - workspaces are folders,
 * not an isolation boundary for module resolution. `.js`/extensionless
 * specifiers both normalize to the `.ts` source they compile from; there is
 * no separate build output in this app, source is what executes.
 */
export function resolveImportSpecifier(fromName: string, specifier: string, available: ReadonlySet<string>): string | undefined {
    const joined = joinPath(dirnameOf(fromName), specifier)
    // A form's script is a module too, keyed in the pool by the form's own
    // name: `./auth.form.js` -> `.../auth.form`. This is how one form imports
    // another's live instances (see default-workspaces checkout).
    const asForm = joined.replace(/\.js$/, '')
    if (asForm.endsWith('.form') && available.has(asForm)) return asForm
    // A ts module: `./x.js` or `./x` -> `.../x.ts`.
    const withTs = joined.endsWith('.ts') ? joined : joined.replace(/\.js$/, '') + '.ts'
    return available.has(withTs) ? withTs : undefined
}

/**
 * The `.js` specifier a file at `fromName` would write to import the file at
 * `toName` - the inverse of `resolveImportSpecifier`. Used to rewrite
 * imports when a file is renamed (`../other/x.ts` -> `../other/y.js`), so
 * dependents keep resolving to the moved file across both pools.
 */
export function relativeImportSpecifier(fromName: string, toName: string): string {
    const fromDir = dirnameOf(fromName).split('/').filter(Boolean)
    const toParts = toName.replace(/\.ts$/, '').split('/').filter(Boolean)
    let i = 0
    while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++
    const ups = fromDir.length - i
    const rel = [...Array<string>(ups).fill('..'), ...toParts.slice(i)].join('/')
    return `${rel.startsWith('.') ? '' : './'}${rel}.js`
}

/**
 * Rewrites every import/export specifier in `content` that resolves to
 * `oldTarget` so it points at `newTarget` instead - used when `oldTarget`
 * was renamed. `available` must include `oldTarget` (so the pre-rename
 * specifiers still resolve to it). Returns the content unchanged if nothing
 * referenced the renamed file.
 */
export function rewriteImportsTo(
    fromName: string,
    content: string,
    oldTarget: string,
    newTarget: string,
    available: ReadonlySet<string>,
): string {
    const sourceFile = ts.createSourceFile(fromName, content, ts.ScriptTarget.ES2022, true)
    const edits: { start: number; end: number; text: string }[] = []

    ts.forEachChild(sourceFile, node => {
        const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : undefined
        if (!specifier || !ts.isStringLiteral(specifier)) return
        if (resolveImportSpecifier(fromName, specifier.text, available) !== oldTarget) return
        // Replace the text inside the quotes only.
        edits.push({ start: specifier.getStart(sourceFile) + 1, end: specifier.getEnd() - 1, text: relativeImportSpecifier(fromName, newTarget) })
    })

    let result = content
    for (const e of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, e.start) + e.text + result.slice(e.end)
    return result
}

/**
 * The forward import edges parsed out of one file's content, restricted to
 * `available`. A specifier that isn't a relative path resolving into
 * `available` (a bare package name like `@yaw-rx/ystate` or `rxjs`, or a
 * typo) is silently not an edge - there's no separate built-in-module list
 * to maintain here, non-resolving specifiers are exactly the ones that
 * should produce no edge.
 */
export function parseImports(name: string, content: string, available: ReadonlySet<string>): string[] {
    const sourceFile = ts.createSourceFile(name, content, ts.ScriptTarget.ES2022, true)
    const imports: string[] = []
    ts.forEachChild(sourceFile, node => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const resolved = resolveImportSpecifier(name, node.moduleSpecifier.text, available)
            if (resolved) imports.push(resolved)
        }
    })
    return imports
}

/**
 * The subset of `pool` reachable from `roots` by following import edges - the
 * transitive closure. Used to scope a Play run to one workspace: its own files
 * plus whatever they actually import (which may cross into another workspace),
 * and nothing else. A workspace no root imports is left out entirely, so a bug
 * in an unrelated workspace can't break the run.
 */
export function reachableFiles<T extends { name: string; content: string }>(pool: readonly T[], roots: Iterable<string>): T[] {
    const byName = new Map(pool.map(f => [f.name, f]))
    const available = new Set(byName.keys())
    const seen = new Set<string>()
    const stack = [...roots]
    while (stack.length > 0) {
        const name = stack.pop()!
        const file = byName.get(name)
        if (!file || seen.has(name)) continue
        seen.add(name)
        for (const dep of parseImports(name, file.content, available)) stack.push(dep)
    }
    return pool.filter(f => seen.has(f.name))
}

/**
 * Topological execution order for a pool of files: depth-first over import
 * edges, so a file is always ordered after everything it imports. Used both
 * to decide sandbox execution order and, from the edges `parseImports`
 * finds along the way, to build the dependency graph.
 */
export function buildExecutionOrder<T extends { name: string; content: string }>(files: readonly T[]): T[] {
    const byName = new Map(files.map(f => [f.name, f]))
    const available = new Set(byName.keys())
    const order: T[] = []
    const visited = new Set<string>()

    function visit(name: string): void {
        if (visited.has(name)) return
        visited.add(name)
        const file = byName.get(name)
        if (!file) return
        for (const dep of parseImports(file.name, file.content, available)) visit(dep)
        order.push(file)
    }

    for (const file of files) visit(file.name)
    return order
}
