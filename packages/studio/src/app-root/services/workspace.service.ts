import { Injectable, state } from '@yaw-rx/core';
import type { RuntimeKind, ClosureResult, SerializedGraphSet } from './sandbox.service.js'
import type { StaticExportInfo, FileDiagnostic } from './type-analysis.service.js'
import { WorkspaceEvaluationService } from './workspace-evaluation.service.js'

export type FileKind = 'concept' | 'form' | 'canvas' | 'manifest'

const EXT_KIND: Record<string, FileKind> = {
    '.ts': 'concept',
    '.html': 'form',
    '.svg': 'canvas',
    '.json': 'manifest',
}

/**
 * What the sandbox found for an export at runtime. `evaluated` is the normal
 * case - a live value was classified by guards, with `serialized`/`closure`
 * present for graph-set/machine. `type-only` is an `export type`/`export
 * interface`: the compiler resolved it statically but it was erased at emit,
 * so no runtime value ever existed for it - not a failure, a fact about the
 * declaration. `unevaluated` means the workspace's evaluation itself failed
 * (a syntax or top-level runtime error), so nothing in it ran at all.
 */
export type ExportRuntimeInfo =
    | { status: 'evaluated'; kind: RuntimeKind; serialized?: SerializedGraphSet; closure?: ClosureResult }
    | { status: 'type-only' }
    | { status: 'unevaluated'; error: string }

/**
 * One classified export of a workspace file: what the checker resolves for
 * it statically (signature and brand, independent of whether the code ever
 * runs) alongside what actually happened when it was evaluated.
 */
export interface ExportRecord {
    name: string
    static: StaticExportInfo
    runtime: ExportRuntimeInfo
}

/** The analysis of a single workspace file: its compiler diagnostics and its classified exports. */
export interface FileAnalysis {
    diagnostics: FileDiagnostic[]
    exports: ExportRecord[]
}

export interface WorkspaceFile {
    name: string
    content: string
}

/** A WorkspaceFile that has been through WorkspaceEvaluationService at least once. */
export interface AnalyzedWorkspaceFile extends WorkspaceFile {
    analysis: FileAnalysis
}

export function isAnalyzedWorkspaceFile(file: WorkspaceFile): file is AnalyzedWorkspaceFile {
    return 'analysis' in file
}

export interface ElementMetadata {
    x?: number
    y?: number
    comment?: string
    annotations?: Record<string, string>
}

export interface WorkspaceManifest {
    name: string
    concepts: string[]
    metadata: Record<string, ElementMetadata>
}

export interface Workspace {
    name: string
    manifest: WorkspaceManifest
    files: WorkspaceFile[]
}

function extOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot);
}

@Injectable([WorkspaceEvaluationService])
export class WorkspaceService {
    @state library: Workspace[] = []

    public constructor(private readonly evaluation: WorkspaceEvaluationService) {}

    kindOf(name: string): FileKind | undefined {
        return EXT_KIND[extOf(name)];
    }

    addToLibrary(workspace: Workspace): void {
        if (this.library.some(w => w.name === workspace.name)) return;
        this.library.push(workspace);
        this.library$.touch();
        this.analyze(workspace);
    }

    // Fire-and-forget: file list and models are already live via the touch()
    // above, analysis fills in moments later via its own touch(). Uniform
    // path - the debounced edit handler in workspace-page.ts calls the same
    // evaluate() on the same workspace object, not a separate lighter route.
    private analyze(workspace: Workspace): void {
        this.evaluation.evaluate(workspace)
            .then(() => this.library$.touch())
            .catch(e => console.error(`Analysis failed for workspace '${workspace.name}':`, e))
    }

    removeFromLibrary(name: string): void {
        const idx = this.library.findIndex(w => w.name === name);
        if (idx !== -1) {
            this.library.splice(idx, 1);
            this.library$.touch();
        }
    }

    getWorkspace(name: string): Workspace | undefined {
        return this.library.find(w => w.name === name);
    }
}
