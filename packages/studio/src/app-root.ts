import { Component, Inject, RxElement } from '@yaw-rx/core';
import '@yaw-rx/core/router/outlet';
import { WorkspaceService } from './app-root/services/workspace.service.js';
import './app-root/components/side-bar.component.js';

@Component({
    selector: 'app-root',
    providers: [WorkspaceService],
    template: `
        <side-bar></side-bar>
        <rx-router-outlet></rx-router-outlet>
    `,
    styles: `
        :host {
            display: flex;
            height: 100vh;
            overflow: hidden;
        }
        rx-router-outlet {
            flex: 1;
            overflow: auto;
        }
    `,
})
export class AppRoot extends RxElement {
    @Inject(WorkspaceService) private readonly workspace!: WorkspaceService;

    override onInit(): void {
        this.workspace.addToLibrary({
            name: 'thermostat',
            manifest: {
                name: 'thermostat',
                concepts: ['heater.ts'],
                metadata: {},
            },
            files: [
                {
                    name: 'heater.ts',
                    content: `import { define } from '@yaw-rx/ystate'

export const Heater = define({
  nodes: {
    on: {},
    off: {},
    power: {},
    idle: {},
  },
  edges: {
    turnOn: { from: 'off', to: 'on', on: 'onSignal.next' },
    onToPower: { from: 'on', to: 'power', on: 'belowLowerLimit.next' },
    onToIdle: { from: 'on', to: 'idle', on: 'atOrAboveLowerLimit.next' },
    powerToIdle: { from: 'power', to: 'idle', on: 'aboveUpperLimit.next' },
    idleToPower: { from: 'idle', to: 'power', on: 'belowLowerLimit.next' },
    powerToOff: { from: 'power', to: 'off', on: 'offSignal.next' },
    idleToOff: { from: 'idle', to: 'off', on: 'offSignal.next' },
  },
}).implement({
  onSignal: {
    $: () => turnOnSignal,
    next: () => ({}),
  },
  offSignal: {
    $: () => turnOffSignal,
    next: () => ({}),
  },
  atOrAboveLowerLimit: {
    $: () => temperature$.pipe(filter((T) => T >= lowerLimitT)),
    next: () => ({}),
  },
  belowLowerLimit: {
    $: () => temperature$.pipe(filter((T) => T < lowerLimitT)),
    next: () => ({}),
  },
  aboveUpperLimit: {
    $: () => temperature$.pipe(filter((T) => T > upperLimitT)),
    next: () => ({}),
  },
})`,
                },
            ],
        });

        this.workspace.addToLibrary({
            name: 'checkout',
            manifest: {
                name: 'checkout',
                concepts: ['auth.ts', 'payment.ts', 'basket.ts'],
                metadata: {},
            },
            files: [
                {
                    name: 'auth.ts',
                    content: `import { define } from '@yaw-rx/ystate'

export const Auth = define({
  nodes: {
    loggedOut: { since: 0 },
    authenticated: { token: '', authenticatedAt: 0 },
    loginFailed: { reason: '' },
  },
  edges: {
    login: { from: 'loggedOut', to: 'authenticated', on: 'authenticate.next' },
    loginError: { from: 'loggedOut', to: 'loginFailed', on: 'authenticate.error' },
    retry: { from: 'loginFailed', to: 'loggedOut', on: 'retryLogin.next' },
    expire: { from: 'authenticated', to: 'loggedOut', on: 'sessionExpire.next' },
  },
}).implement({
  authenticate: {
    $: () => simulateLogin(),
    next: (result) => ({ token: result.token, authenticatedAt: Date.now() }),
    error: (err) => ({ reason: String(err) }),
  },
  retryLogin: {
    $: () => timer(2000),
    next: () => ({ since: Date.now() }),
  },
  sessionExpire: {
    $: () => timer(10000),
    next: (_result, _dest, source) => ({ since: source.authenticatedAt }),
  },
})`,
                },
                {
                    name: 'payment.ts',
                    content: `import { define } from '@yaw-rx/ystate'

export const Payment = define({
  nodes: {
    processing: { orderId: '' },
    approved: { confirmedAt: 0, txId: '' },
    declined: { reason: '' },
    stalled: { orderId: '' },
  },
  edges: {
    approve: { from: 'processing', to: 'approved', on: 'process.next' },
    decline: { from: 'processing', to: 'declined', on: 'process.error' },
    stall: { from: 'processing', to: 'stalled', on: 'process.complete' },
  },
}).implement({
  process: {
    $: () => simulatePayment(),
    next: (result) => ({ confirmedAt: Date.now(), txId: result.txId }),
    error: (err) => ({ reason: String(err) }),
    complete: (_result, _dest, source) => ({ orderId: source.orderId }),
  },
})`,
                },
                {
                    name: 'basket.ts',
                    content: `import { define } from '@yaw-rx/ystate'
import { Auth } from './auth.js'
import { Payment } from './payment.js'

export const Basket = define({
  nodes: {
    empty: {},
    addingItem: { itemId: '' },
    hasItems: { items: [] as string[] },
    addFailed: { error: '', items: [] as string[] },
  },
  deps: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    addFromEmpty: { from: 'empty', to: 'addingItem', on: 'addItem.next' },
    addFromHasItems: { from: 'hasItems', to: 'addingItem', on: 'addItem.next' },
    addError: { from: 'addingItem', to: 'addFailed', on: 'addItem.error' },
    retryAdd: { from: 'addFailed', to: 'addingItem', on: 'addItem.next' },
    added: { from: 'addingItem', to: 'hasItems', on: 'itemAdded.next' },
    checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
}).implement({
  addItem: {
    $: () => simulateAddItem(),
    next: (result, _dest, _source, edge) => ({ itemId: result.itemId + '-via-' + edge }),
    error: (err, dest, _source, edge) => ({ error: edge + ': ' + String(err), items: dest.items }),
  },
  itemAdded: {
    $: () => timer(1000),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  },
  checkout: {
    $: (deps) => timer(500).pipe(
      withLatestFrom(deps.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (_result, _dest, _source, edge) => ({ orderId: 'ORD-' + Date.now() + '-' + edge }),
  },
})`,
                },
                { name: 'form.html', content: '' },
            ],
        });
    }
}
