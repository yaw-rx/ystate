import { Component, Inject, RxElement, state } from '@yaw-rx/core';
import { type Observable, map, of, combineLatest, switchMap } from 'rxjs';
import { Router } from '@yaw-rx/core/router';
import { RxFor } from '@yaw-rx/core/directives/rx-for';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { RuntimeFilesystemService } from '../services/runtime-filesystem.service.js';
import type { RuntimeFile } from '../types/runtime-filesystem.types.js';
import { fileKindOf } from '../utils/file-kind.js';
import { fileStatusTier$, worstTier, type StatusTier } from '../utils/file-status.js';
import type { StatusIconKind } from './status-icon.component.js';
import './file-tree-entry.component.js';
import './status-icon.component.js';

interface LibraryWorkspaceView {
    name: string
    files: RuntimeFile[]
    statusIconKind: StatusIconKind
}

const TIER_ICON: Record<StatusTier, StatusIconKind> = {
    error: 'failed',
    progress: 'analyzing',
    ok: 'ok',
}

function workspaceStatusIconKind$(files: RuntimeFile[]): Observable<StatusIconKind> {
    if (files.length === 0) return of<StatusIconKind>('ok')
    return combineLatest(files.map(fileStatusTier$)).pipe(
        map(tiers => TIER_ICON[worstTier(tiers)]),
    )
}

@Component({
    selector: 'side-bar',
    directives: [RxFor, RxIf],
    template: `
        <div class="header">
            <span class="title">YState</span>
        </div>

        <section rx-if="hasCurrent" class="current">
            <div class="section-header">
                <span class="section-label">Workspace</span>
                <span class="current-name-row">
                    <status-icon [kind]="currentStatusIconKind"></status-icon>
                    <span class="current-name">{{currentName}}</span>
                </span>
            </div>
            <ul rx-for="file of currentFiles by name">
                <li>
                    <file-tree-entry [file]="file" [workspaceName]="currentName" [startExpanded]="alwaysTrue"></file-tree-entry>
                </li>
            </ul>
        </section>

        <section class="library">
            <div class="library-header">
                <span class="section-label">Library</span>
                <button class="new-ws-btn" onclick="startNewWorkspace" title="New workspace">+</button>
            </div>
            <input #wsInput class="ws-input" [style.display]="wsInputDisplay" onkeydown="onNewWorkspaceKey($event)" onblur="cancelNewWorkspace" placeholder="workspace name" />
            <div rx-for="ws of libraryWorkspaces by name" class="ws-entry">
                <div class="ws-header" onclick="toggleExpanded(ws.name)">
                    <span class="ws-chevron" [class.open]="isExpanded(ws.name)">&#9656;</span>
                    <status-icon [kind]="ws.statusIconKind"></status-icon>
                    <span>{{ws.name}}</span>
                    <button class="open-btn" onclick="openWorkspace(ws.name)">Open</button>
                </div>
                <div rx-if="isExpanded(ws.name)">
                    <ul rx-for="file of ws.files by name">
                        <li class="lib-file">
                            <file-tree-entry [file]="file" [workspaceName]="ws.name"></file-tree-entry>
                        </li>
                    </ul>
                </div>
            </div>
        </section>
    `,
    styles: `
        :host {
            display: flex;
            flex-direction: column;
            width: 240px;
            height: 100vh;
            background: var(--bg-2);
            border-right: var(--border-width) solid var(--border);
            font-family: var(--font-mono);
            font-size: 0.8rem;
            overflow-y: auto;
            user-select: none;
        }
        .header {
            padding: 1rem;
            border-bottom: var(--border-width) solid var(--border);
        }
        .title {
            color: var(--text);
            font-size: 0.85rem;
            font-weight: 700;
        }
        .current {
            border-bottom: var(--border-width) solid var(--border);
        }
        .section-header {
            display: flex;
            flex-direction: column;
            padding: 0.75rem 1rem 0.25rem;
        }
        .section-label {
            display: block;
            padding: 0.75rem 1rem 0.25rem;
            font-size: 0.65rem;
            text-transform: uppercase;
            letter-spacing: var(--tracking);
            color: var(--dim);
        }
        .section-header .section-label {
            padding: 0;
        }
        .library-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-right: 0.5rem;
        }
        .new-ws-btn {
            background: none;
            border: var(--border-width) solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--dim);
            font-family: var(--font-mono);
            font-size: 0.9rem;
            line-height: 1;
            width: 1.4rem;
            height: 1.4rem;
            cursor: pointer;
        }
        .new-ws-btn:hover {
            color: var(--accent);
            border-color: var(--accent);
        }
        .ws-input {
            margin: 0.25rem 1rem 0.5rem;
            background: var(--bg-3);
            border: 1px solid var(--accent);
            border-radius: var(--radius-sm);
            color: var(--text);
            font-family: var(--font-mono);
            font-size: 0.75rem;
            padding: 0.35rem 0.5rem;
            outline: none;
        }
        .current-name-row {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            margin-top: 0.5rem;
        }
        .current-name {
            color: var(--text);
            font-size: 0.85rem;
        }
        ul {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
        }
        li {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.35rem 1rem;
            color: var(--secondary);
            cursor: pointer;
            transition: background 0.1s, color 0.1s;
        }
        li:hover {
            background: var(--bg-4);
            color: var(--text);
        }
        .file-icon {
            font-size: 0.7rem;
            color: var(--dim);
            width: 1rem;
            text-align: center;
        }
        .ws-entry {
            border-bottom: var(--border-width) solid var(--bg-4);
        }
        .ws-header {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.4rem 1rem;
            color: var(--secondary);
            cursor: pointer;
            transition: background 0.1s, color 0.1s;
        }
        .ws-header:hover {
            background: var(--bg-4);
            color: var(--text);
        }
        .ws-chevron {
            font-size: 0.6rem;
            color: var(--dim);
            transition: transform 0.15s;
            display: inline-block;
        }
        .ws-chevron.open {
            transform: rotate(90deg);
        }
        .open-btn {
            margin-left: auto;
            background: none;
            border: var(--border-width) solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--dim);
            font-family: var(--font-mono);
            font-size: 0.6rem;
            padding: 0.15rem 0.4rem;
            letter-spacing: var(--tracking);
            text-transform: uppercase;
        }
        .open-btn:hover {
            color: var(--accent);
            border-color: var(--accent);
        }
        .lib-file {
            padding-left: 2rem;
        }
    `,
})
export class SideBar extends RxElement {
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService;
    @Inject(Router) private readonly router!: Router;
    @state expandedName = ''
    @state currentWorkspaceName = ''
    @state creatingWorkspace = false
    wsInput!: HTMLInputElement
    get hasCurrent$(): Observable<boolean> {
        return this.currentWorkspaceName$.pipe(map(n => n !== ''));
    }

    get currentName$(): Observable<string> {
        return this.currentWorkspaceName$;
    }

    get alwaysTrue$(): Observable<boolean> {
        return of(true);
    }

    get currentFiles$(): Observable<RuntimeFile[]> {
        return combineLatest([this.currentWorkspaceName$, this.filesystem.workspaces$]).pipe(
            switchMap(([name, workspaces]) => {
                const ws = workspaces.get(name)
                return ws ? ws.files$ : of(new Map<string, RuntimeFile>())
            }),
            map(files => [...files.values()].filter(f => fileKindOf(f.name) !== undefined)),
        );
    }

    get currentStatusIconKind$(): Observable<StatusIconKind> {
        return this.currentFiles$.pipe(switchMap(workspaceStatusIconKind$));
    }

    get libraryWorkspaces$(): Observable<LibraryWorkspaceView[]> {
        return combineLatest([this.filesystem.workspaces$, this.currentWorkspaceName$]).pipe(
            switchMap(([workspaces, current]) => {
                const entries = [...workspaces.values()].filter(w => w.name !== current)
                return entries.length === 0
                    ? of<LibraryWorkspaceView[]>([])
                    : combineLatest(entries.map(ws => ws.files$.pipe(
                        map(files => [...files.values()].filter(f => fileKindOf(f.name) !== undefined)),
                        switchMap(files => workspaceStatusIconKind$(files).pipe(
                            map((statusIconKind): LibraryWorkspaceView => ({ name: ws.name, files, statusIconKind })),
                        )),
                    )))
            }),
        );
    }

    isExpanded(name: string): Observable<boolean> {
        return this.expandedName$.pipe(map(e => e === name));
    }

    toggleExpanded(name: string): void {
        this.expandedName = this.expandedName === name ? '' : name;
    }

    openWorkspace(name: string): void {
        this.currentWorkspaceName = name;
        this.expandedName = '';
        this.router.navigate('/workspace/' + name);
    }

    startNewWorkspace(): void {
        this.creatingWorkspace = true;
        requestAnimationFrame(() => { this.wsInput.focus(); this.wsInput.select(); });
    }

    cancelNewWorkspace(): void {
        this.creatingWorkspace = false;
    }

    get wsInputDisplay$(): Observable<string> {
        return this.creatingWorkspace$.pipe(map(c => c ? '' : 'none'));
    }

    onNewWorkspaceKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') { this.cancelNewWorkspace(); return; }
        if (e.key !== 'Enter') return;
        const name = (e.target as HTMLInputElement).value.trim();
        this.creatingWorkspace = false;
        if (!name) return;
        this.filesystem.createWorkspace(name);
        this.openWorkspace(name);
    }
}
