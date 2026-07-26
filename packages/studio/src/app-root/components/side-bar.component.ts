import { Component, Inject, RxElement, state } from '@yaw-rx/core';
import { type Observable, map, of, combineLatest } from 'rxjs';
import { Router } from '@yaw-rx/core/router';
import { RxFor } from '@yaw-rx/core/directives/rx-for';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { WorkspaceService, type Workspace, type WorkspaceFile } from '../services/workspace.service.js';
import './file-tree-entry.component.js';

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
                <span class="current-name">{{currentName}}</span>
            </div>
            <ul rx-for="file of currentFiles by name">
                <li>
                    <file-tree-entry [file]="file" [workspaceName]="currentName" [startExpanded]="alwaysTrue"></file-tree-entry>
                </li>
            </ul>
        </section>

        <section class="library">
            <span class="section-label">Library</span>
            <div rx-for="ws of libraryWorkspaces by name" class="ws-entry">
                <div class="ws-header" onclick="toggleExpanded(ws.name)">
                    <span class="ws-chevron" [class.open]="isExpanded(ws.name)">&#9656;</span>
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
        .current-name {
            color: var(--text);
            font-size: 0.85rem;
            margin-top: 0.15rem;
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
    @Inject(WorkspaceService) private readonly workspace!: WorkspaceService;
    @Inject(Router) private readonly router!: Router;
    @state expandedName = ''
    @state currentWorkspaceName = ''
    get hasCurrent$(): Observable<boolean> {
        return this.currentWorkspaceName$.pipe(map(n => n !== ''));
    }

    get currentName$(): Observable<string> {
        return this.currentWorkspaceName$;
    }

    get alwaysTrue$(): Observable<boolean> {
        return of(true);
    }

    get currentFiles$(): Observable<WorkspaceFile[]> {
        // Must react to library$ too, not just the workspace name - otherwise
        // this never re-derives when WorkspaceEvaluationService rewrites a
        // file's analysis (new export added, machine became a graph-set, etc).
        return combineLatest([this.currentWorkspaceName$, this.workspace.library$]).pipe(
            map(([name]) => {
                const ws = this.workspace.getWorkspace(name);
                return ws ? ws.files.filter(f => this.workspace.kindOf(f.name) === 'concept') : [];
            }),
        );
    }

    get libraryWorkspaces$(): Observable<Workspace[]> {
        return this.workspace.library$.pipe(
            map(lib => lib
                .filter(w => w.name !== this.currentWorkspaceName)
                .map(w => ({ ...w, files: w.files.filter(f => this.workspace.kindOf(f.name) === 'concept') }))),
        );
    }

    isExpanded(name: string): Observable<boolean> {
        return this.expandedName$.pipe(map(e => e === name));
    }

    toggleExpanded(name: string): void {
        this.expandedName = this.expandedName === name ? '' : name;
    }

    openWorkspace(name: string): void {
        if (!this.workspace.getWorkspace(name)) return;
        this.currentWorkspaceName = name;
        this.expandedName = '';
        this.router.navigate('/workspace/' + name);
    }
}
