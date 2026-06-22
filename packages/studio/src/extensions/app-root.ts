import { Component, RxElement } from '@yaw-rx/core';
import '@yaw-rx/core/router/outlet';

@Component({
    selector: 'app-root',
    providers: [],
    template: `
        <!--<side-bar></side-bar>
        <rx-router-outlet></rx-router-outlet>-->
    `,
    styles: `
        :host { display: block; }
    `
})
export class AppRoot extends RxElement {}