import { bootstrap } from '@yaw-rx/core';
import { Router, ROUTES } from '@yaw-rx/core/router';
import { AppRoot } from './app-root.js';
import globalStyles from './main.css';
// Side-effect import: registers the standard-library form components
// (rx-slider, rx-graph) globally before any form is compiled.
import './app-root/components/std/index.js';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'

// The form triad edits html (template) and css (styles) alongside ts
// (script), so those language workers must be registered too - without
// them Monaco routes html/css requests (getFoldingRanges, findDocument
// Symbols, ...) to the generic editor worker, which rejects them.
self.MonacoEnvironment = {
    getWorker(_: string, label: string) {
        const worker
            = (label === 'typescript' || label === 'javascript') ? new tsWorker()
            : label === 'html' ? new htmlWorker()
            : label === 'css' ? new cssWorker()
            : new editorWorker()
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
