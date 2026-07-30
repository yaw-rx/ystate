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
    const withTs = joined.endsWith('.ts') ? joined : joined.replace(/\.js$/, '') + '.ts'
    return available.has(withTs) ? withTs : undefined
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
