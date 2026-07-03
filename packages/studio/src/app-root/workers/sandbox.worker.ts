import ts from 'typescript'
import * as ystate from '@yaw-rx/ystate'
import * as rxjs from 'rxjs'
import type { IncidenceGraphSet, EdgeDef, NodeData, DepNodeRef } from '@yaw-rx/ystate'
import { IncidenceGraphSetClosureError, IncidenceMachineClosureError } from '@yaw-rx/ystate'
import type { SandboxCommand, SandboxResponse, SerializedEdge, SerializedGraphSet, GraphKind, ClosureResult, WorkspaceFile } from '../services/sandbox.service.js'

const BUILTIN_MODULES: Record<string, unknown> = {
    '@yaw-rx/ystate': ystate,
    'rxjs': rxjs,
}

// --- Stateful exports ---

const liveExports = new Map<string, unknown>()

// --- Transpile / module helpers ---

function transpile(fileName: string, source: string): string {
    const result = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
        fileName,
    })
    return result.outputText
}

function rewriteRequires(
    js: string,
    workspaceModules: Map<string, unknown>,
): string {
    const sourceFile = ts.createSourceFile(
        'rewrite.js',
        js,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.JS,
    )

    const replacements: { start: number; end: number; text: string }[] = []

    ts.forEachChild(sourceFile, node => {
        if (!ts.isVariableStatement(node)) return
        for (const decl of node.declarationList.declarations) {
            if (
                decl.initializer &&
                ts.isCallExpression(decl.initializer) &&
                ts.isIdentifier(decl.initializer.expression) &&
                decl.initializer.expression.text === 'require' &&
                decl.initializer.arguments.length === 1 &&
                ts.isStringLiteral(decl.initializer.arguments[0])
            ) {
                const specifier = decl.initializer.arguments[0].text

                let moduleName: string | undefined
                if (BUILTIN_MODULES[specifier]) {
                    moduleName = specifier
                } else {
                    moduleName = resolveWorkspaceSpecifier(specifier, workspaceModules)
                }

                if (moduleName !== undefined) {
                    replacements.push({
                        start: decl.initializer.getStart(sourceFile),
                        end: decl.initializer.getEnd(),
                        text: `__modules[${JSON.stringify(moduleName)}]`,
                    })
                }
            }
        }
    })

    let result = js
    for (const r of replacements.reverse()) {
        result = result.slice(0, r.start) + r.text + result.slice(r.end)
    }
    return result
}

function resolveWorkspaceSpecifier(
    specifier: string,
    workspaceModules: Map<string, unknown>,
): string | undefined {
    const normalized = specifier
        .replace(/^\.\//, '')
        .replace(/\.js$/, '.ts')
        .replace(/\.ts$/, '.ts')

    if (workspaceModules.has(normalized)) return normalized

    const withExt = normalized.endsWith('.ts') ? normalized : normalized + '.ts'
    if (workspaceModules.has(withExt)) return withExt

    return undefined
}

function executeModule(
    js: string,
    modules: Record<string, unknown>,
): Record<string, unknown> {
    const moduleObj = { exports: {} as Record<string, unknown> }
    const require = (specifier: string) => {
        const resolved = modules[specifier]
        if (resolved !== undefined) return resolved
        throw new Error(`Module '${specifier}' not found`)
    }
    const fn = new Function('exports', 'module', '__modules', 'require', js)
    fn(moduleObj.exports, moduleObj, modules, require)
    return moduleObj.exports
}

function buildExecutionOrder(files: WorkspaceFile[]): WorkspaceFile[] {
    const byName = new Map(files.map(f => [f.name, f]))
    const order: WorkspaceFile[] = []
    const visited = new Set<string>()

    function visit(name: string): void {
        if (visited.has(name)) return
        visited.add(name)
        const file = byName.get(name)
        if (!file) return

        const sourceFile = ts.createSourceFile(
            name,
            file.content,
            ts.ScriptTarget.ES2022,
            true,
        )
        ts.forEachChild(sourceFile, node => {
            if (
                ts.isImportDeclaration(node) &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier)
            ) {
                const specifier = node.moduleSpecifier.text
                if (!BUILTIN_MODULES[specifier]) {
                    const resolved = resolveWorkspaceSpecifier(specifier, byName)
                    if (resolved) visit(resolved)
                }
            }
        })

        order.push(file)
    }

    for (const file of files) visit(file.name)
    return order
}

// --- Serialization ---

function serializeGraphSet(obj: unknown): SerializedGraphSet | null {
    if (!obj || typeof obj !== 'object') return null

    const candidate = obj as Record<string, unknown>

    if (!('nodes' in candidate) || !('edges' in candidate)) return null

    const gs = candidate as unknown as IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef<Record<string, NodeData>>>>

    const edges: Record<string, SerializedEdge> = {}
    for (const [name, edge] of Object.entries(gs.edges)) {
        const to = typeof edge.to === 'string'
            ? edge.to
            : { __brand: 'depNodeRef' as const, dep: (edge.to as DepNodeRef).dep, node: (edge.to as DepNodeRef).node }
        edges[name] = { from: edge.from, to, on: edge.on }
    }

    const deps: Record<string, SerializedGraphSet> = {}
    if (gs.deps) {
        for (const [name, dep] of Object.entries(gs.deps)) {
            const serialized = serializeGraphSet(dep)
            if (serialized) deps[name] = serialized
        }
    }

    return {
        nodes: structuredClone(gs.nodes),
        edges,
        deps,
    }
}

function detectKind(value: unknown): GraphKind | null {
    if (!value || typeof value !== 'object') return null
    const obj = value as Record<string, unknown>
    if (!('nodes' in obj) || !('edges' in obj)) return null
    if (typeof obj.implement === 'function') return 'graph-set'
    if ('transitions' in obj) return 'machine'
    return null
}

// --- Command handlers ---

function handleEvaluate(files: WorkspaceFile[]): Extract<SandboxResponse, { command: 'evaluate' }> & { id: number } {
    liveExports.clear()

    const tsFiles = files.filter(f => f.name.endsWith('.ts'))
    const workspaceModules = new Map(tsFiles.map(f => [f.name, f.content]))
    const ordered = buildExecutionOrder(tsFiles)
    const modules: Record<string, unknown> = { ...BUILTIN_MODULES }

    for (const file of ordered) {
        let js = transpile(file.name, file.content)
        js = rewriteRequires(js, workspaceModules)
        const fileExports = executeModule(js, modules)
        modules[file.name] = fileExports
    }

    const exports: Record<string, SerializedGraphSet> = {}
    const graphKinds: Record<string, GraphKind> = {}
    const transitionKeys: Record<string, string[]> = {}

    for (const file of ordered) {
        const fileExports = modules[file.name] as Record<string, unknown>
        for (const [exportName, value] of Object.entries(fileExports)) {
            const key = `${file.name}:${exportName}`
            const kind = detectKind(value)
            if (kind) {
                liveExports.set(key, value)
                graphKinds[key] = kind
                const serialized = serializeGraphSet(value)
                if (serialized) exports[key] = serialized
                if (kind === 'machine') {
                    const obj = value as Record<string, unknown>
                    transitionKeys[key] = Object.keys(obj.transitions as Record<string, unknown>)
                }
            }
        }
    }

    return { id: 0, command: 'evaluate', exports, graphKinds, transitionKeys }
}

function handleClose(key: string): ClosureResult {
    const value = liveExports.get(key)
    if (!value || typeof (value as any).close !== 'function') {
        throw new Error(`Export '${key}' has no close() method`)
    }
    try {
        const closed = (value as any).close()
        const warnings = typeof closed.validate === 'function' ? closed.validate() : []
        return { success: true, warnings }
    } catch (e) {
        if (e instanceof IncidenceGraphSetClosureError) {
            return { success: false, issues: e.issues }
        }
        if (e instanceof IncidenceMachineClosureError) {
            return { success: false, issues: e.issues }
        }
        throw e
    }
}

// --- Message dispatch ---

self.onmessage = (event: MessageEvent<SandboxCommand>) => {
    const msg = event.data
    try {
        switch (msg.command) {
            case 'evaluate': {
                const result = handleEvaluate(msg.files)
                self.postMessage({ ...result, id: msg.id } satisfies SandboxResponse)
                break
            }
            case 'close': {
                const result = handleClose(msg.key)
                self.postMessage({ id: msg.id, command: 'close', key: msg.key, result } satisfies SandboxResponse)
                break
            }
        }
    } catch (e) {
        self.postMessage({ id: msg.id, command: 'error', error: e instanceof Error ? e.message : String(e) } satisfies SandboxResponse)
    }
}
