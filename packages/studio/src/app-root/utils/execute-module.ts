import ts from 'typescript'
import * as ystate from '@yaw-rx/ystate'
import * as rxjs from 'rxjs'
import type { QualifiedName } from '../types/runtime-filesystem.types.js'
import { resolveImportSpecifier } from './import-graph.js'

/**
 * The module-execution primitives shared by the sandbox worker (analysis:
 * classify exports, serialize graphs) and LiveModulesService (Play: real
 * instances the forms bind to). One transpile, one require-rewrite, one
 * executor - the two sides can never drift in how they turn pool source
 * into a live module.
 *
 * Each importer supplies its own `BUILTIN_MODULES`-equivalent instances by
 * bundle: the worker bundle and the main bundle each carry their own
 * ystate/rxjs, which is exactly right - a worker-side Subject could never
 * be handed to a main-thread form anyway.
 */
export const BUILTIN_MODULES: Record<string, unknown> = {
    '@yaw-rx/ystate': ystate,
    'rxjs': rxjs,
}

export function transpile(fileName: string, source: string): string {
    const result = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
        fileName,
    })
    return result.outputText
}

export function rewriteRequires(
    js: string,
    fromName: QualifiedName,
    available: ReadonlySet<QualifiedName>,
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

                const moduleName = BUILTIN_MODULES[specifier]
                    ? specifier
                    : resolveImportSpecifier(fromName, specifier, available)

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

export function executeModule(
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
