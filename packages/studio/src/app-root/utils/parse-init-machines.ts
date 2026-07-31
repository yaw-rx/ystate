import ts from 'typescript'

/**
 * The names of the running machines a form's `init` returns, read
 * statically from the source - `export const init = () => ({ heater: ... })`
 * yields `['heater']`. Handles both the concise object body
 * `() => ({ ... })` and a block body with a `return { ... }`.
 *
 * This is the static counterpart to what actually runs on Play: the keys of
 * init's returned object literal are exactly the machine names, knowable
 * without executing anything.
 */
export function parseInitMachines(script: string): string[] {
    const source = ts.createSourceFile('form.ts', script, ts.ScriptTarget.ES2022, true)

    let initArrow: ts.ArrowFunction | undefined
    ts.forEachChild(source, node => {
        if (!ts.isVariableStatement(node)) return
        const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
        if (!isExported) return
        for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === 'init' && decl.initializer && ts.isArrowFunction(decl.initializer)) {
                initArrow = decl.initializer
            }
        }
    })
    if (!initArrow) return []

    const objectLiteral = returnedObjectLiteral(initArrow)
    if (!objectLiteral) return []

    return objectLiteral.properties
        .map(p => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) ? p.name.text : undefined)
        .filter((name): name is string => name !== undefined)
}

/** The object literal init returns, whether via concise body `() => ({...})` or `return {...}` in a block. */
function returnedObjectLiteral(arrow: ts.ArrowFunction): ts.ObjectLiteralExpression | undefined {
    const body = arrow.body
    if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) return body.expression
    if (ts.isObjectLiteralExpression(body)) return body
    if (ts.isBlock(body)) {
        for (const stmt of body.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) {
                const expr = ts.isParenthesizedExpression(stmt.expression) ? stmt.expression.expression : stmt.expression
                if (ts.isObjectLiteralExpression(expr)) return expr
            }
        }
    }
    return undefined
}
