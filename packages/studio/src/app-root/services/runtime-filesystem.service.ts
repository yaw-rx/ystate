import { Injectable, state } from '@yaw-rx/core'
import * as monaco from 'monaco-editor'
import { BehaviorSubject, shareReplay, type Observable } from 'rxjs'
import type { RuntimeFilesystem, RuntimeWorkspace, RuntimeFile, RuntimeFormSection, DependencyGraph } from '../types/runtime-filesystem.types.js'
import type { SerializedWorkspace, SerializedWorkspaceFile, WorkspaceManifest, SerializedDependencyGraph } from '../types/serialized-filesystem.types.js'
import { WorkspaceEvaluationService } from './workspace-evaluation.service.js'
import { FilesystemStorage, FILESYSTEM_STORAGE } from './filesystem-storage.js'
import { createFileMachine } from '../machines/workspace-file.machine.js'
import { createPersistenceMachine } from '../machines/persistence.machine.js'
import { modelContent$ } from '../utils/model-content.js'
import { toModelUri, toSectionUri } from '../utils/model-uri.js'
import { toQualifiedName } from '../utils/qualified-name.js'
import { fileKindOf } from '../utils/file-kind.js'
import { deriveDependencyGraph$ } from '../utils/derive-dependency-graph.js'
import { toSerializedWorkspace$, toSerializedDependencyGraph$ } from '../utils/serialize-runtime.js'
import { logMachineFailures } from '../utils/log-machine-failures.js'
import { warmUpMonacoServices } from '../utils/warm-up-monaco.js'
import { configureTypeScript } from '../utils/configure-typescript.js'
import { defaultWorkspaces } from '../default-workspaces.js'

/**
 * What each hydrated node needs as its starting data, from the last-known
 * serialized status. Loosely typed on purpose: the four shapes are
 * verified by hand against `analysisTopology`'s own node declarations
 * (workspace-file.machine.ts), and threading a precise union through a
 * switch here wouldn't add real safety over that - `.start()`'s own
 * `initialNodeData` type still checks whatever ends up on each node.
 */
function initialNodeDataFor(file: SerializedWorkspaceFile): Record<string, unknown> {
    switch (file.status) {
        case 'analyzed': return { analyzed: { analysis: file.analysis } }
        case 'failed': return { failed: { error: file.error ?? '', stale: file.analysis } }
        case 'analyzing': return { analyzing: { stale: file.analysis } }
        case 'unanalyzed': return {}
        case 'removed': return {}
    }
}

/**
 * The one stateful service in this app's filesystem design. Owns the
 * runtime tree's `@state` directly and every mutation to it - there is no
 * separate serialized-side store anything subscribes to (see
 * docs/filesystem-runtime.md §1). `FilesystemStorage` is read exactly
 * once, in `onInit`, and otherwise only ever written to, by the
 * per-workspace and filesystem-level persistence machines.
 *
 * `workspaceMap` is a real mutable `Map`, mutated in place then announced
 * via `touch()` - `StateSubject.touch()` exists precisely for "a mutation
 * changed the contents without replacing the reference" (state.js).
 */
@Injectable([WorkspaceEvaluationService, FILESYSTEM_STORAGE])
export class RuntimeFilesystemService implements RuntimeFilesystem {
    @state private workspaceMap = new Map<string, RuntimeWorkspace>()
    private fileSubjects = new Map<string, BehaviorSubject<ReadonlyMap<string, RuntimeFile>>>()
    private manifests = new Map<string, WorkspaceManifest>()
    private workspacePersistence = new Map<string, ReturnType<typeof createPersistenceMachine<SerializedWorkspace>>>()

    // Assigned in onInit(), before anything else can run - both loadAll()
    // and loadDependencyGraph() have to resolve, together, before
    // dependencyGraph$ exists or a single workspace is hydrated. If
    // addWorkspace() ran first, files' machines would be built against a
    // filesystem with no dependencyGraph$ yet, and any dependency-graph
    // seed would race the first real emission instead of pre-warming it.
    dependencyGraph$!: Observable<DependencyGraph>
    private filesystemPersistence!: ReturnType<typeof createPersistenceMachine<SerializedDependencyGraph>>

    constructor(
        private readonly evaluation: WorkspaceEvaluationService,
        private readonly storage: FilesystemStorage,
    ) {
        // Order matters: compiler config must land before the TS worker
        // lifecycle (WorkerManager) is ever constructed, or configuring it
        // later disposes and orphans whatever worker analysis already
        // spawned - see configure-typescript.ts. Both must happen before
        // hydrateFile() ever creates a model - see warm-up-monaco.ts.
        configureTypeScript()
        warmUpMonacoServices()
    }

    // Not awaited by the injector (injector.js calls onInit() without
    // awaiting) - the runtime tree starts empty and populates once this
    // resolves. Correct for localStorage (resolves same tick) and for a
    // genuinely async backend alike.
    async onInit(): Promise<void> {
        const [workspaces, dependencyGraphSeed] = await Promise.all([
            this.storage.loadAll(),
            this.storage.loadDependencyGraph(),
        ])

        // shareReplay: every file's own upstreamSub subscribes to this
        // independently, plus the persistence machine below - without
        // multicasting, each one would drive its own independent pass over
        // flattenFiles$ while all reading/writing the *same* closure-owned
        // cache inside deriveDependencyGraph$, recomputing redundantly
        // instead of computing once and sharing the result.
        this.dependencyGraph$ = deriveDependencyGraph$(this.workspaces$, dependencyGraphSeed ?? undefined).pipe(
            shareReplay({ bufferSize: 1, refCount: true }),
        )
        this.filesystemPersistence = createPersistenceMachine(
            graph => this.storage.saveDependencyGraph(graph),
            toSerializedDependencyGraph$(this.workspaces$, this.dependencyGraph$),
        )
        logMachineFailures('filesystem-persistence', this.filesystemPersistence.runningMachine.state$, 'failed')

        // Hydrate EVERY workspace into the map first, kick analysis second.
        // A request fired during hydration samples flattenFiles$ against a
        // half-built filesystem: the workspace being added isn't in
        // workspaceMap yet (set/touch comes after hydrateFile), later
        // workspaces don't exist at all. The sandbox then evaluates an
        // empty/partial pool and returns ok with zero runtimeKinds - every
        // export silently classifies as 'type-only', so analysis "finishes"
        // with no graphs and no closure results anywhere, and nothing
        // re-runs until a manual edit. The kick must come strictly after
        // the last workspace lands in the map.
        const initial = workspaces.length > 0 ? workspaces : defaultWorkspaces
        const kicks = initial.flatMap(ws => this.hydrateWorkspace(ws))
        for (const kick of kicks) kick()
    }

    get workspaces$(): Observable<ReadonlyMap<string, RuntimeWorkspace>> {
        return this.workspaceMap$
    }

    addWorkspace(serialized: SerializedWorkspace): void {
        // Standalone add: the rest of the filesystem is already in the map,
        // so kicking immediately after this one workspace lands is the
        // complete-pool moment. Only onInit's batch hydration defers.
        for (const kick of this.hydrateWorkspace(serialized)) kick()
    }

    private hydrateWorkspace(serialized: SerializedWorkspace): Array<() => void> {
        if (this.workspaceMap.has(serialized.name)) return []

        this.manifests.set(serialized.name, serialized.manifest)

        const fileMap = new Map<string, RuntimeFile>()
        for (const file of serialized.files) fileMap.set(file.name, this.hydrateFile(serialized.name, file))

        const files$ = new BehaviorSubject<ReadonlyMap<string, RuntimeFile>>(fileMap)
        this.fileSubjects.set(serialized.name, files$)

        const runtimeWorkspace: RuntimeWorkspace = { name: serialized.name, files$: files$.asObservable() }
        this.workspaceMap.set(serialized.name, runtimeWorkspace)
        this.workspaceMap$.touch()

        const persistence = createPersistenceMachine(
            ws => this.storage.saveWorkspace(ws),
            toSerializedWorkspace$(runtimeWorkspace, serialized.manifest),
        )
        logMachineFailures(`workspace-persistence:${serialized.name}`, persistence.runningMachine.state$, 'failed')
        this.workspacePersistence.set(serialized.name, persistence)

        // 'unanalyzed' has never run and nothing else will ever trigger its
        // first request (content$'s skip(1) ignores the hydration echo, and
        // upstreams can't go dirty if they're equally unanalyzed).
        // 'analyzing' means a persisted run never completed - and worse,
        // .start('analyzing') already invoked analyze.$ against whatever
        // partial pool existed mid-hydration; the kick's restart edge tears
        // that stale in-flight run down synchronously, before its promise
        // can resolve, and re-runs against the full pool.
        const kicks: Array<() => void> = []
        for (const file of serialized.files) {
            if (file.status !== 'unanalyzed' && file.status !== 'analyzing') continue
            const hydrated = fileMap.get(file.name)!
            kicks.push(() => hydrated.request$.next())
        }
        return kicks
    }

    async removeWorkspace(name: string): Promise<void> {
        const files$ = this.fileSubjects.get(name)
        if (!files$) return
        for (const file of files$.value.values()) this.teardownFile(file)
        files$.complete()
        this.fileSubjects.delete(name)
        this.manifests.delete(name)

        this.workspacePersistence.get(name)?.dispose()
        this.workspacePersistence.delete(name)

        this.workspaceMap.delete(name)
        this.workspaceMap$.touch()

        await this.storage.deleteWorkspace(name)
    }

    private hydrateFile(workspaceName: string, serializedFile: SerializedWorkspaceFile): RuntimeFile {
        // The script model is always 'typescript' - a form's script is a
        // .ts file like any other (see file-kind.ts). Only the sibling
        // template/styles models carry html/css, and those are created
        // via hydrateSection with the language implied by their URI.
        const uri = toModelUri(workspaceName, serializedFile.name)
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(serializedFile.content, 'typescript', uri)
        const content$ = modelContent$(model)
        const { machine, request$, dispose$ } = createFileMachine(this.evaluation, this, workspaceName, serializedFile.name, content$)
        const running = machine.close().start(
            serializedFile.status,
            {},
            initialNodeDataFor(serializedFile) as any,
        )

        // A form carries two more live section models (template/styles)
        // alongside its script. Present exactly when the file is a form -
        // the same discriminant the tree and code panel key on.
        const sections = fileKindOf(serializedFile.name) === 'form'
            ? {
                template: this.hydrateSection(workspaceName, serializedFile.name, 'template', serializedFile.sections?.template ?? ''),
                styles: this.hydrateSection(workspaceName, serializedFile.name, 'styles', serializedFile.sections?.styles ?? ''),
            }
            : undefined

        // No analysis kick here - hydrateWorkspace collects the kicks and
        // they fire only once the whole filesystem is in the map, so an
        // analyze run never samples a partially-hydrated pool.
        logMachineFailures(toQualifiedName(workspaceName, serializedFile.name), running.state$, 'failed')

        return {
            qualifiedName: toQualifiedName(workspaceName, serializedFile.name),
            workspace: workspaceName,
            name: serializedFile.name,
            model,
            content$,
            sections,
            machine: running,
            request$,
            dispose$,
        }
    }

    private hydrateSection(workspaceName: string, fileName: string, section: 'template' | 'styles', content: string): RuntimeFormSection {
        const uri = toSectionUri(workspaceName, fileName, section)
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, section === 'template' ? 'html' : 'css', uri)
        return { model, content$: modelContent$(model) }
    }

    /** Drives the machine into its terminal `removed` node - see the doc comment on `analysisTopology` for why that's real disposal, not a leak. */
    private teardownFile(file: RuntimeFile): void {
        file.dispose$.next()
        file.model.dispose()
        file.sections?.template.model.dispose()
        file.sections?.styles.model.dispose()
    }
}
