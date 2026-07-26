import { Injectable } from '@yaw-rx/core'
import * as monaco from 'monaco-editor'
import type { Subscription } from 'rxjs'
import { WorkspaceService, type Workspace } from './workspace.service.js'
import { toModelUri } from '../utils/model-uri.js'

/**
 * Owns the Monaco model for every file in every workspace in the library,
 * for the lifetime of the app - not scoped to whichever page happens to be
 * mounted. Subscribes to WorkspaceService.library$ directly in onInit(), so
 * models exist the moment a workspace is added, before any component that
 * displays it (CodePanel, SideBar) has ever rendered. This is what lets
 * TypeAnalysisService address a file's model regardless of whether its
 * workspace has ever been opened in the editor.
 */
@Injectable([WorkspaceService])
export class MonacoModelService {
    private models = new Map<string, monaco.editor.ITextModel>()
    private sub: Subscription | null = null

    public constructor(private readonly workspace: WorkspaceService) {}

    onInit(): void {
        this.sub = this.workspace.library$.subscribe(library => this.sync(library))
    }

    onDestroy(): void {
        this.sub?.unsubscribe()
        this.sub = null
        for (const model of this.models.values()) model.dispose()
        this.models.clear()
    }

    getModel(workspaceName: string, fileName: string): monaco.editor.ITextModel | undefined {
        return this.models.get(`${workspaceName}/${fileName}`)
    }

    // library$ fires far more often than the set of files actually changes -
    // e.g. every time analysis finishes and touches a file's `analysis`
    // field. Only create models for keys that are new and dispose ones
    // that are gone; an existing model is never written to from here.
    //
    // The model is the sole source of truth for a file's live content once
    // it exists - workspace-page.ts's debounced handler reads FROM the
    // model INTO file.content, never the reverse. evaluate() is async, so
    // by the time it resolves and touches library$ the user may have typed
    // further; file.content at that point is a stale snapshot from when
    // the debounce fired. Pushing it back into the model with setValue()
    // would overwrite what the user just typed and reset undo history and
    // cursor position. There is no case in this app where an existing
    // model's content legitimately needs to be overwritten from outside.
    private sync(library: Workspace[]): void {
        const seen = new Set<string>()

        for (const ws of library) {
            for (const file of ws.files) {
                const key = `${ws.name}/${file.name}`
                seen.add(key)

                if (this.models.has(key)) continue

                const uri = toModelUri(ws.name, file.name)
                const lang = file.name.endsWith('.html') ? 'html'
                    : file.name.endsWith('.json') ? 'json'
                    : 'typescript'
                this.models.set(key, monaco.editor.createModel(file.content, lang, uri))
            }
        }

        for (const [key, model] of this.models) {
            if (!seen.has(key)) {
                model.dispose()
                this.models.delete(key)
            }
        }
    }
}
