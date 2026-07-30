import { bootstrap } from '@yaw-rx/core';
import { Router, ROUTES } from '@yaw-rx/core/router';
import { AppRoot } from './app-root.js';
import globalStyles from './main.css';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
    getWorker(_: string, label: string) {
        const worker = (label === 'typescript' || label === 'javascript') ? new tsWorker() : new editorWorker()
        worker.addEventListener('error', e => console.error(`[monaco-worker:${label}] error`, e))
        worker.addEventListener('messageerror', e => console.error(`[monaco-worker:${label}] messageerror`, e))
        return worker
    },
}

await bootstrap({
    root: AppRoot,
    globals: { styles: globalStyles },
    providers: [
        { provide: ROUTES, useValue: [
            { path: '/', load: () => import('./app-root/pages/workspace-page.js').then(m => m.WorkspacePage) },
            { path: '/workspace', load: () => import('./app-root/pages/workspace-page.js').then(m => m.WorkspacePage) },
        ] },
        Router,
    ],
});
