import { Component, RxElement } from '@yaw-rx/core';

@Component({
    selector: 'workspace-page',
    template: `
        <div class="canvas-area"></div>
    `,
    styles: `
        :host {
            display: flex;
            flex: 1;
            height: 100%;
        }
        .canvas-area {
            flex: 1;
            background: var(--bg-3);
        }
    `,
})
export class WorkspacePage extends RxElement {}
