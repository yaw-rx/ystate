import { Injectable, state } from '@yaw-rx/core';

export type FileKind = 'concept' | 'form' | 'canvas' | 'manifest'

const EXT_KIND: Record<string, FileKind> = {
    '.ts': 'concept',
    '.html': 'form',
    '.svg': 'canvas',
    '.json': 'manifest',
}

export interface WorkspaceFile {
    name: string
    content: string
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

@Injectable()
export class WorkspaceService {
    @state library: Workspace[] = []

    kindOf(name: string): FileKind | undefined {
        return EXT_KIND[extOf(name)];
    }

    addToLibrary(workspace: Workspace): void {
        if (this.library.some(w => w.name === workspace.name)) return;
        this.library = [...this.library, workspace];
    }

    removeFromLibrary(name: string): void {
        this.library = this.library.filter(w => w.name !== name);
    }

    getWorkspace(name: string): Workspace | undefined {
        return this.library.find(w => w.name === name);
    }
}
