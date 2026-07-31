import type ts from 'typescript'

type DisplayPart = ts.SymbolDisplayPart

const OPENERS = new Set(['{', '<', '('])
const CLOSERS = new Set(['}', '>', ')'])

/**
 * Given `init`'s type signature displayParts (`() => { heater:
 * RunningMachineSet<…>; cooler: … }`), returns each returned property's own
 * type as displayParts - so the tree can show each running machine's type
 * as its tooltip, the same way a ts export shows its signature. The machine
 * names and count come from the source AST (parse-init-machines); this only
 * supplies the per-name type slices, best-effort.
 */
export function initReturnTypes(parts: readonly DisplayPart[]): Record<string, DisplayPart[]> {
    const result: Record<string, DisplayPart[]> = {}

    // The return type object begins at the first `{` after `=>`.
    let i = parts.findIndex(p => p.text === '=>')
    if (i === -1) i = 0
    while (i < parts.length && parts[i]!.text !== '{') i++
    if (i >= parts.length) return result
    i++ // past the opening `{`

    let depth = 1
    while (i < parts.length && depth > 0) {
        const p = parts[i]!
        if (p.text === '{') { depth++; i++; continue }
        if (p.text === '}') { depth--; i++; continue }

        if (depth === 1 && p.kind === 'propertyName') {
            const name = p.text
            // Skip to the `:` that opens this property's type.
            let j = i + 1
            while (j < parts.length && !(parts[j]!.kind === 'punctuation' && parts[j]!.text === ':')) j++
            j++
            while (j < parts.length && parts[j]!.text.trim() === '') j++

            // Capture until the `;`/`,` separator (or `}`) at this nesting depth.
            const typeParts: DisplayPart[] = []
            let d = 0
            while (j < parts.length) {
                const q = parts[j]!
                if (OPENERS.has(q.text)) d++
                else if (CLOSERS.has(q.text)) { if (d === 0) break; d-- }
                else if (d === 0 && q.kind === 'punctuation' && (q.text === ';' || q.text === ',')) break
                typeParts.push(q)
                j++
            }
            result[name] = typeParts
            i = j
            continue
        }
        i++
    }
    return result
}
