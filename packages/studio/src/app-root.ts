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
import { BehaviorSubject, filter } from 'rxjs'

// Current room temperature (degrees C)
const temperature$ = new BehaviorSubject(10)

// External signals to turn the thermostat on and off
const turnOnSignal = new BehaviorSubject(false).pipe(filter(v => v === true))
const turnOffSignal = new BehaviorSubject(false).pipe(filter(v => v === true))

const upperLimitT = 26
const lowerLimitT = 23

// The thermostat cycles between power (heating) and idle based on room
// temperature. It can be turned on from off, and turned off from either
// power or idle.
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
  // Fires on entry to 'on' if temperature is already at or above the lower limit
  atOrAboveLowerLimit: {
    $: () => temperature$.pipe(filter(T => T >= lowerLimitT)),
    next: () => ({}),
  },
  // Fires when temperature drops below the lower threshold, triggering heating
  belowLowerLimit: {
    $: () => temperature$.pipe(filter(T => T < lowerLimitT)),
    next: () => ({}),
  },
  // Fires when temperature rises above the upper threshold, stopping heating
  aboveUpperLimit: {
    $: () => temperature$.pipe(filter(T => T > upperLimitT)),
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
import { timer, mergeMap, throwError, of } from 'rxjs'

const loginErrors = ['auth server unreachable', 'invalid credentials', 'account locked', 'rate limited']
const simulateLogin = () => timer(2000).pipe(
  mergeMap(() => Math.random() > 0.2
    ? of({ token: \`tok_\${Date.now()}\` })
    : throwError(() => new Error(loginErrors[Math.floor(Math.random() * loginErrors.length)]))
  )
)

const simulateSessionTimeout = () => timer(10000)

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
  // simulateLogin() can error for various reasons (server unreachable,
  // invalid credentials, account locked, rate limited), so authenticate
  // needs error edges in the graph to handle it. Without them the machine
  // would throw MachineUnhandledError.
  authenticate: {
    $: () => simulateLogin(),
    next: (result) => ({ token: result.token, authenticatedAt: Date.now() }),
    error: (err) => ({ reason: String(err) }),
  },
  // timer(2000) is a simple delay that cannot error or complete without
  // emission, so no error or complete edges are needed.
  retryLogin: {
    $: () => timer(2000),
    next: () => ({ since: Date.now() }),
  },
  // simulateSessionTimeout() is a simple timer that cannot error or
  // complete without emission.
  sessionExpire: {
    $: () => simulateSessionTimeout(),
    next: (_result, _dest, source) => ({ since: source.authenticatedAt }),
  },
})`,
                },
                {
                    name: 'payment.ts',
                    content: `import { define } from '@yaw-rx/ystate'
import { timer, mergeMap, throwError, of, EMPTY } from 'rxjs'

const simulatePayment = () => timer(3000).pipe(
  mergeMap(() => {
    const r = Math.random()
    if (r > 0.3) return of({ txId: \`tx_\${Date.now()}\` })
    if (r > 0.1) return throwError(() => new Error('card declined'))
    return EMPTY
  })
)

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
  // simulatePayment() can emit (approved), error (declined), or complete
  // without emission (stalled). All three outcomes are handled by edges
  // in the graph, so next, error, and complete are all required.
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
import { timer, mergeMap, throwError, of, withLatestFrom, filter } from 'rxjs'
import { Auth } from './auth.js'
import { Payment } from './payment.js'

const simulateAddItem = () => timer(500).pipe(
  mergeMap(() => Math.random() > 0.1
    ? of({ itemId: \`item-\${Date.now()}\` })
    : throwError(() => new Error('item out of stock'))
  )
)

const simulateItemConfirmation = () => timer(1000)

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
  // simulateAddItem() can throw 'item out of stock', so addItem needs
  // error edges in the graph to handle it. Without them the machine
  // would throw MachineUnhandledError.
  addItem: {
    $: () => simulateAddItem(),
    next: (result, _dest, _source, edge) => ({ itemId: \`\${result.itemId}-via-\${edge}\` }),
    error: (err, dest, _source, edge) => ({ error: \`\${edge}: \${String(err)}\`, items: dest.items }),
  },
  // simulateItemConfirmation() is a simple timer that cannot error or
  // complete without emission, so no error or complete edges are needed.
  itemAdded: {
    $: () => simulateItemConfirmation(),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  },
  // checkout waits for auth to be authenticated before emitting. The
  // observable cannot error or complete, so no error or complete
  // edges are needed.
  checkout: {
    $: (deps) => timer(500).pipe(
      withLatestFrom(deps.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (_result, _dest, _source, edge) => ({ orderId: \`ORD-\${Date.now()}-\${edge}\` }),
  },
})`,
                },
                { name: 'form.html', content: '' },
            ],
        });
    }
}
