import * as monaco from 'monaco-editor'
import ts from 'typescript'
import type { Workspace } from './workspace.service.js'
import { toModelUri } from '../utils/model-uri.js'

export type StaticBrand = 'graph-set' | 'machine' | 'observable' | 'behavior-subject' | 'function' | 'class' | 'const' | 'other'

export interface StaticExportInfo {
    name: string
    brand: StaticBrand
    displayParts: ts.SymbolDisplayPart[]
    documentation: ts.SymbolDisplayPart[]
}

export interface FileDiagnostic {
    message: string
    line: number
    column: number
    category: 'error' | 'warning' | 'suggestion' | 'message'
}

export interface StaticFileManifest {
    diagnostics: FileDiagnostic[]
    exports: StaticExportInfo[]
}

// Maps a type's own name (as it appears in a checker-resolved display part) to
// the domain-level brand it represents. Matched against the resolved type, so
// aliases/re-exports still resolve correctly - this is not string-matching the
// source code, it's reading the checker's own output.
const SPECIAL_TYPE_BRANDS: Record<string, StaticBrand> = {
    Observable: 'observable',
    Subject: 'observable',
    ReplaySubject: 'observable',
    BehaviorSubject: 'behavior-subject',
    IncidenceGraphSetMixin: 'graph-set',
    IncidenceGraphSet: 'graph-set',
    IncidenceMachineMixin: 'machine',
    IncidenceMachine: 'machine',
}

const DIAGNOSTIC_CATEGORY: Record<number, FileDiagnostic['category']> = {
    [ts.DiagnosticCategory.Warning]: 'warning',
    [ts.DiagnosticCategory.Error]: 'error',
    [ts.DiagnosticCategory.Suggestion]: 'suggestion',
    [ts.DiagnosticCategory.Message]: 'message',
}

type TypeScriptWorkerClient = Awaited<ReturnType<Awaited<ReturnType<typeof monaco.languages.typescript.getTypeScriptWorker>>>>

/**
 * The compile-time half of export analysis. Talks directly to the same
 * ts.worker Monaco's editor already runs (via getTypeScriptWorker()) - no
 * second language service, no duplicated lib/extraLib bootstrapping. Requires
 * a model to already exist for every file being analyzed (code-panel.component.ts
 * creates one per file for the whole library, not just the active workspace).
 */
export class TypeAnalysisService {
    async analyzeWorkspace(ws: Workspace): Promise<Record<string, StaticFileManifest>> {
        const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
        const manifests: Record<string, StaticFileManifest> = {}

        for (const file of ws.files) {
            if (!file.name.endsWith('.ts')) continue
            const uri = toModelUri(ws.name, file.name)
            const model = monaco.editor.getModel(uri)
            if (!model) continue
            const client = await getWorker(uri)
            manifests[file.name] = await this.analyzeFile(client, model, uri.toString())
        }

        return manifests
    }

    private async analyzeFile(
        client: TypeScriptWorkerClient,
        model: monaco.editor.ITextModel,
        uriString: string,
    ): Promise<StaticFileManifest> {
        const [syntactic, semantic, navTree] = await Promise.all([
            client.getSyntacticDiagnostics(uriString),
            client.getSemanticDiagnostics(uriString),
            client.getNavigationTree(uriString) as Promise<ts.NavigationTree | undefined>,
        ])

        const diagnostics = [...syntactic, ...semantic].map(d => this.formatDiagnostic(model, d))
        console.log(`[TypeAnalysisService] ${uriString}`, diagnostics)
        const exports: StaticExportInfo[] = []

        for (const item of navTree?.childItems ?? []) {
            if (!item.kindModifiers.split(',').includes('export')) continue
            const span = item.nameSpan ?? item.spans[0]
            if (!span) continue

            const quickInfo = await client.getQuickInfoAtPosition(uriString, span.start) as ts.QuickInfo | undefined
            if (!quickInfo) continue

            const displayParts = quickInfo.displayParts ?? []
            exports.push({
                name: item.text,
                brand: this.classifyBrand(item.kind, displayParts),
                displayParts,
                documentation: quickInfo.documentation ?? [],
            })
        }

        return { diagnostics, exports }
    }

    private classifyBrand(syntaxKind: string, displayParts: ts.SymbolDisplayPart[]): StaticBrand {
        for (const part of displayParts) {
            if ((part.kind === 'className' || part.kind === 'interfaceName' || part.kind === 'aliasName') && part.text in SPECIAL_TYPE_BRANDS) {
                return SPECIAL_TYPE_BRANDS[part.text]
            }
        }
        if (syntaxKind === ts.ScriptElementKind.functionElement) return 'function'
        if (syntaxKind === ts.ScriptElementKind.classElement) return 'class'
        return 'const'
    }

    private formatDiagnostic(
        model: monaco.editor.ITextModel,
        d: { start?: number; messageText: string | ts.DiagnosticMessageChain; category: number },
    ): FileDiagnostic {
        const message = typeof d.messageText === 'string' ? d.messageText : ts.flattenDiagnosticMessageText(d.messageText, '\n')
        const pos = d.start != null ? model.getPositionAt(d.start) : { lineNumber: 1, column: 1 }
        return {
            message,
            line: pos.lineNumber,
            column: pos.column,
            category: DIAGNOSTIC_CATEGORY[d.category] ?? 'message',
        }
    }
}
