import { Injectable } from '@yaw-rx/core'
import { firstValueFrom } from 'rxjs'
import { SandboxService, type SandboxResult } from './sandbox.service.js'
import { TypeAnalysisService } from './type-analysis.service.js'
import { FormAnalysisService } from './form-analysis.service.js'
import type { FileAnalysis, FormAnalysis, ExportRecord, ExportRuntimeInfo } from '../types/serialized-filesystem.types.js'
import type { RuntimeFilesystem, QualifiedName } from '../types/runtime-filesystem.types.js'
import { flattenFiles$ } from '../utils/flatten-files.js'
import { fileKindOf } from '../utils/file-kind.js'

/**
 * The environment call a file's `analyze` transition invokes. It routes by
 * kind to keep the two domains decoupled:
 *
 * - A ts file is evaluated against the ts-collection pool (forms excluded):
 *   the runtime sandbox + the compile-time checker, merged by export name.
 *   A form's error can never reach here.
 * - A form is analysed entirely separately (FormAnalysisService) - its own
 *   checker pass, never the ts sandbox. A ts error can never reach there.
 */
@Injectable([SandboxService, TypeAnalysisService, FormAnalysisService])
export class WorkspaceEvaluationService {
    constructor(
        private readonly sandbox: SandboxService,
        private readonly typeAnalysis: TypeAnalysisService,
        private readonly formAnalysis: FormAnalysisService,
    ) {}

    async evaluateFile(filesystem: RuntimeFilesystem, qualifiedName: QualifiedName): Promise<FileAnalysis | FormAnalysis> {
        // Forms are a separate domain: their own analysis, never the ts pool.
        if (fileKindOf(qualifiedName) === 'form') {
            return this.formAnalysis.analyze(filesystem, qualifiedName)
        }

        // The ts collection pool - forms excluded, so a form's script is
        // never evaluated in the ts sandbox (which is what coupled their
        // errors together before).
        const pool = (await firstValueFrom(flattenFiles$(filesystem.workspaces$)))
            .filter(f => fileKindOf(f.name) === 'ts-file')

        // A pool that doesn't even contain the file being analyzed means the
        // filesystem was sampled mid-hydration. Evaluating anyway is worse
        // than failing: the sandbox returns ok with zero runtimeKinds and
        // every export silently classifies as 'type-only' - analysis looks
        // finished while carrying no graphs and no closure results. Throw
        // instead; the machine's analyze.error edge makes it a visible
        // 'failed', and the post-hydration kick re-runs it properly.
        if (!pool.some(f => f.name === qualifiedName)) {
            throw new Error(`Evaluation pool sampled before '${qualifiedName}' was hydrated - filesystem incomplete`)
        }

        const [sandboxResult, staticManifest] = await Promise.all([
            this.sandbox.evaluate(pool),
            this.typeAnalysis.check(qualifiedName),
        ])

        // A broken file anywhere in the pool (a genuine runtime error, not
        // just a type error - transpileModule strips types without
        // checking them) fails the whole pool's execution, same as it
        // always has. The machine's `analyze.error` handler is what turns
        // this into a graceful `failed` node carrying the last-known-good
        // `stale` forward - this method doesn't soften it.
        if (!sandboxResult.ok) throw new Error(sandboxResult.error)

        const exports: ExportRecord[] = staticManifest.exports.map(staticInfo => ({
            name: staticInfo.name,
            static: staticInfo,
            runtime: this.runtimeInfoFor(sandboxResult, `${qualifiedName}:${staticInfo.name}`),
        }))

        return { diagnostics: staticManifest.diagnostics, exports }
    }

    private runtimeInfoFor(sandboxResult: Extract<SandboxResult, { ok: true }>, key: string): ExportRuntimeInfo {
        const kind = sandboxResult.runtimeKinds[key]
        if (!kind) return { status: 'type-only' }

        if (kind === 'machine') {
            return {
                status: 'evaluated',
                kind,
                serialized: sandboxResult.graphs[key],
                closure: sandboxResult.closureResults[key],
                transitionKeys: sandboxResult.transitionKeys[key],
            }
        }
        if (kind === 'graph-set') {
            return { status: 'evaluated', kind, serialized: sandboxResult.graphs[key], closure: sandboxResult.closureResults[key] }
        }
        return { status: 'evaluated', kind }
    }

    dispose(): void {
        this.sandbox.dispose()
    }
}
