import { Injectable } from '@yaw-rx/core'
import { firstValueFrom } from 'rxjs'
import { TypeAnalysisService, type StaticBrand } from './type-analysis.service.js'
import type { FormAnalysis, FormAttachment, FormAttachmentKind, FileAnalysis } from '../types/serialized-filesystem.types.js'
import type { QualifiedName, RuntimeFile, RuntimeFilesystem } from '../types/runtime-filesystem.types.js'
import { splitQualifiedName } from '../utils/qualified-name.js'
import { analysisHasErrors } from '../utils/file-status.js'
import { parseInitMachines } from '../utils/parse-init-machines.js'

// Static export brand -> what the form's class gets, framed by how a yaw
// template can bind it: observables/subjects are data (and subjects are
// also signal targets), functions are handlers, everything concrete is a
// static value, machine/graph-set definitions are blueprints (not bindable,
// only usable as init() inputs).
const BRAND_TO_KIND: Record<StaticBrand, FormAttachmentKind> = {
    observable: 'observable',
    'behavior-subject': 'behavior-subject',
    function: 'function',
    machine: 'machine',
    'graph-set': 'graph-set',
    class: 'plain-value',
    const: 'plain-value',
    other: 'plain-value',
}

// Reactive = the view re-reads it on change (an observable/subject),
// vs a one-shot static value bound once.
const REACTIVE_KINDS = new Set<FormAttachmentKind>(['observable', 'behavior-subject'])

/**
 * A form's compile-time analysis, entirely separate from the ts collection's
 * sandbox. It reuses the TS checker (TypeAnalysisService) for the form
 * script's diagnostics and export brands, and reads init()'s returned keys
 * statically (parse-init-machines) for the running-machine names. Nothing
 * is executed here - running is the Play concern, handled elsewhere.
 *
 * If a ts dependency the form imports has errors, the form is `blocked` on
 * it and no form analysis runs: that ts error belongs on the ts file's own
 * terminal, never the form's.
 */
// Injected with only TypeAnalysisService - the filesystem is passed to
// analyze() (as it already is to WorkspaceEvaluationService.evaluateFile).
// Injecting RuntimeFilesystemService here would close a DI cycle
// (filesystem -> evaluation -> form-analysis -> filesystem).
@Injectable([TypeAnalysisService])
export class FormAnalysisService {
    constructor(
        private readonly typeAnalysis: TypeAnalysisService,
    ) {}

    async analyze(filesystem: RuntimeFilesystem, qualifiedName: QualifiedName): Promise<FormAnalysis> {
        const blocked = await this.firstBlockingDep(filesystem, qualifiedName)
        if (blocked) return { diagnostics: [], attachments: [], hasInit: false, machines: [], blocked }

        const form = await this.formFile(filesystem, qualifiedName)
        const machines = parseInitMachines(form?.model.getValue() ?? '')

        // Reuse the checker: brands + the form's own diagnostics. init is the
        // special export (its own icon, with its returned machines as
        // children), so it's held out of the flat attachment list and
        // reported via hasInit/machines instead.
        const manifest = await this.typeAnalysis.check(qualifiedName)
        const hasInit = manifest.exports.some(e => e.name === 'init')
        const attachments: FormAttachment[] = manifest.exports
            .filter(e => e.name !== 'init')
            .map(e => {
                const kind = BRAND_TO_KIND[e.brand]
                return { name: e.name, kind, reactive: REACTIVE_KINDS.has(kind) }
            })

        return { diagnostics: manifest.diagnostics, attachments, hasInit, machines }
    }

    /** The first imported ts file whose analysis has errors (failed evaluation or compiler errors) - the form waits on it rather than surfacing the cascade as its own. */
    private async firstBlockingDep(filesystem: RuntimeFilesystem, qualifiedName: QualifiedName): Promise<string | undefined> {
        const graph = await firstValueFrom(filesystem.dependencyGraph$)
        const imports = graph.imports.get(qualifiedName)
        if (!imports) return undefined

        for (const dep of imports) {
            const runtimeFile = await this.formFile(filesystem, dep)
            if (!runtimeFile) continue
            const state = await firstValueFrom(runtimeFile.machine.state$)
            const analysis = (state.data as { analysis?: FileAnalysis }).analysis
            if (state.node === 'failed' || (state.node === 'analyzed' && analysisHasErrors(analysis))) return dep
        }
        return undefined
    }

    private async formFile(filesystem: RuntimeFilesystem, qualifiedName: QualifiedName): Promise<RuntimeFile | undefined> {
        const { workspace, file } = splitQualifiedName(qualifiedName)
        const workspaces = await firstValueFrom(filesystem.workspaces$)
        const ws = workspaces.get(workspace)
        if (!ws) return undefined
        const files = await firstValueFrom(ws.files$)
        return files.get(file)
    }
}
