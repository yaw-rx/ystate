import { bootstrap } from '@yaw-rx/core';
import { Router, ROUTES } from '@yaw-rx/core/router';
import { AppRoot } from './app-root.js';
import globalStyles from './main.css';

await bootstrap({
    root: AppRoot,
    globals: { styles: globalStyles },
    providers: [
        { provide: ROUTES, useValue: [
            /*{ path: '/',         load: () => import('./app-root/pages/manifesto-page.js').then(m => m.ManifestoPage) },
            { path: '/features', load: () => import('./app-root/pages/features-page.js').then(m => m.FeaturesPage) },
            { path: '/showcase', load: () => import('./app-root/pages/showcase-page.js').then(m => m.ShowcasePage) },
            { path: '/examples', load: () => import('./app-root/pages/examples-page.js').then(m => m.ExamplesPage) },
            { path: '/docs',     load: () => import('./app-root/pages/docs-page.js').then(m => m.DocsPage) },*/
        ] },
        Router,
    ],
});