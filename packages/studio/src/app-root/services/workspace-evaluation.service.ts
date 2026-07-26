import { Injectable } from '@yaw-rx/core'
import { SandboxService, type SandboxResult } from './sandbox.service.js'
import { TypeAnalysisService } from './type-analysis.service.js'
import type { Workspace, ExportRecord, ExportRuntimeInfo, AnalyzedWorkspaceFile } from './workspace.service.js'

/**
 * The single entry point for analyzing a workspace: runs the runtime pass
 * (SandboxService, execution + guard classification + closure) and the
 * compile-time pass (TypeAnalysisService, the checker via Monaco's ts.worker)
 * for every one of its files, merges them by export name, and writes the
 * result onto each file's `analysis` in place. Called uniformly whenever a
 * workspace's files might have changed - on library add and on every
 * debounced edit - never a separate lighter path for either trigger.
 */
@Injectable()
export class WorkspaceEvaluationService {
    private readonly sandbox = new SandboxService()
    private readonly typeAnalysis = new TypeAnalysisService()

    async evaluate(ws: Workspace): Promise<SandboxResult> {
        const tsFiles = ws.files.filter(f => f.name.endsWith('.ts')).map(f => ({ name: f.name, content: f.content }))

        const [sandboxResult, staticManifests] = await Promise.all([
            this.sandbox.evaluate(tsFiles),
            this.typeAnalysis.analyzeWorkspace(ws),
        ])

        for (let i = 0; i < ws.files.length; i++) {
            const file = ws.files[i]
            const staticManifest = staticManifests[file.name]
            if (!staticManifest) continue // non-.ts files (form/canvas/manifest) carry no analysis

            const exports: ExportRecord[] = staticManifest.exports.map(staticInfo => ({
                name: staticInfo.name,
                static: staticInfo,
                runtime: this.runtimeInfoFor(sandboxResult, `${file.name}:${staticInfo.name}`),
            }))

            // Replace rather than mutate: WorkspaceFile has no `analysis` field
            // at all (see AnalyzedWorkspaceFile) - a file only ever becomes
            // analyzed by being swapped for a genuinely analyzed object.
            const analyzed: AnalyzedWorkspaceFile = { ...file, analysis: { diagnostics: staticManifest.diagnostics, exports } }
            ws.files[i] = analyzed
        }

        return sandboxResult
    }

    private runtimeInfoFor(sandboxResult: SandboxResult, key: string): ExportRuntimeInfo {
        if (!sandboxResult.ok) return { status: 'unevaluated', error: sandboxResult.error }

        const kind = sandboxResult.runtimeKinds[key]
        if (!kind) return { status: 'type-only' }

        return {
            status: 'evaluated',
            kind,
            serialized: sandboxResult.graphs[key],
            closure: sandboxResult.closureResults[key],
        }
    }

    dispose(): void {
        this.sandbox.dispose()
    }
}
