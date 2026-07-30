import { Injectable } from '@yaw-rx/core'
import { firstValueFrom } from 'rxjs'
import { SandboxService, type SandboxResult } from './sandbox.service.js'
import { TypeAnalysisService } from './type-analysis.service.js'
import type { FileAnalysis, ExportRecord, ExportRuntimeInfo } from '../types/serialized-filesystem.types.js'
import type { RuntimeFilesystem, QualifiedName } from '../types/runtime-filesystem.types.js'
import { flattenFiles$ } from '../utils/flatten-files.js'

/**
 * The environment call a file's `analyze` transition invokes - the same
 * role `simulateLogin()` plays in auth.ts. Owns no state about which file
 * is being analyzed or what happens to the result; the machine (see
 * machines/workspace-file.machine.ts) owns the state transition, this only
 * runs the runtime pass (SandboxService) and the compile-time pass
 * (TypeAnalysisService) and merges them by export name.
 */
@Injectable([SandboxService, TypeAnalysisService])
export class WorkspaceEvaluationService {
    constructor(
        private readonly sandbox: SandboxService,
        private readonly typeAnalysis: TypeAnalysisService,
    ) {}

    async evaluateFile(filesystem: RuntimeFilesystem, qualifiedName: QualifiedName): Promise<FileAnalysis> {
        const pool = await firstValueFrom(flattenFiles$(filesystem.workspaces$))

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
