import { bootstrap } from '@yaw-rx/core';
import { Router, ROUTES } from '@yaw-rx/core/router';
import { AppRoot } from './app-root.js';
import globalStyles from './main.css';

await bootstrap({
    root: AppRoot,
    globals: { styles: globalStyles },
    providers: [
        { provide: ROUTES, useValue: [
            { path: '/', load: () => import('./app-root/pages/workspace-page.js').then(m => m.WorkspacePage) },
        ] },
        Router,
    ],
});
