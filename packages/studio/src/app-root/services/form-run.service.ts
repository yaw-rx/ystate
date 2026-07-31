import { Injectable } from '@yaw-rx/core'
import { BehaviorSubject, firstValueFrom, type Observable } from 'rxjs'
import type { RunningMachineSet } from '@yaw-rx/ystate'
import { RuntimeFilesystemService } from './runtime-filesystem.service.js'
import { LiveModulesService } from './live-modules.service.js'
import type { RuntimeFile, DependencyGraph } from '../types/runtime-filesystem.types.js'
import { flattenFiles$, type FlatFile } from '../utils/flatten-files.js'
import { reachableFiles } from '../utils/import-graph.js'
import { fileKindOf } from '../utils/file-kind.js'
import { formTag } from '../utils/form-tag.js'
import { createFormComponent } from '../utils/create-form-component.js'

export interface PreparedForm {
    /** The form file's name, for the run host's tab label. */
    name: string
    /** The content-addressed custom-element tag to stamp. */
    tag: string
}

/**
 * Turns the forms of a workspace into runnable custom elements: samples the
 * whole pool once, executes it on the main thread (LiveModulesService), and
 * for each form computes its content-addressed tag and defines its element.
 *
 * This is the Play half. It touches no DOM - it only ensures the tags exist
 * and are backed by live module instances; the run host stamps them. Stop
 * needs nothing here: tearing down the stamped elements drives each form's
 * `onDestroy`, which stops its machines.
 */
@Injectable([RuntimeFilesystemService, LiveModulesService])
export class FormRunService {
    // The live running machines across all running forms, published here
    // rather than via a cross-component DOM event: hyphenated custom event
    // names don't survive yaw's template transform, and a shared observable
    // is the idiomatic way for the run host and the ELK canvas to agree on
    // what's running. Empty when nothing is playing.
    private readonly _runningMachines$ = new BehaviorSubject<RunningMachineSet[]>([])
    get runningMachines$(): Observable<RunningMachineSet[]> { return this._runningMachines$ }

    setRunningMachines(machines: RunningMachineSet[]): void {
        this._runningMachines$.next(machines)
    }

    constructor(
        private readonly filesystem: RuntimeFilesystemService,
        private readonly liveModules: LiveModulesService,
    ) {}

    async prepare(workspaceName: string): Promise<PreparedForm[]> {
        const [fullPool, graph, workspaces] = await Promise.all([
            firstValueFrom(flattenFiles$(this.filesystem.workspaces$)),
            firstValueFrom(this.filesystem.dependencyGraph$),
            firstValueFrom(this.filesystem.workspaces$),
        ])

        const ws = workspaces.get(workspaceName)
        if (!ws) return []
        const files = await firstValueFrom(ws.files$)

        // Isolate the run to this workspace: only its files and their
        // transitive imports execute. A sibling workspace that this one
        // doesn't import stays out of the pool, so its bugs can't break Play.
        const roots = [...files.values()].map(f => f.qualifiedName)
        const pool = reachableFiles(fullPool, roots)
        const registry = this.liveModules.run(pool)

        const forms = [...files.values()].filter(f => fileKindOf(f.name) === 'form')

        return forms.map(form => this.prepareOne(form, pool, graph, registry))
    }

    private prepareOne(
        form: RuntimeFile,
        pool: readonly FlatFile[],
        graph: DependencyGraph,
        registry: ReturnType<LiveModulesService['run']>,
    ): PreparedForm {
        // A form's live section content is the source of truth for the tag
        // and the component; read it synchronously from the models.
        const template = form.sections?.template.model.getValue() ?? ''
        const styles = form.sections?.styles.model.getValue() ?? ''
        const script = form.model.getValue()

        const tag = formTag({ qualifiedName: form.qualifiedName, script, template, styles }, pool, graph)
        const exports = registry.get(form.qualifiedName) ?? {}
        createFormComponent(tag, template, styles, exports)

        return { name: form.name, tag }
    }
}
