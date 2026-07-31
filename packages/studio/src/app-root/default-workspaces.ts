import type { SerializedWorkspace } from './types/serialized-filesystem.types.js'

/**
 * Used by `RuntimeFilesystemService.onInit()` only when storage is empty
 * (a genuinely first run) - not something `app-root.ts` pushes in itself.
 * Seeding has to happen inside the same async flow that constructs
 * `dependencyGraph$`, or a file's machine would read `filesystem.dependencyGraph$`
 * before it exists (the injector doesn't await service `onInit()`, so
 * anything calling `addWorkspace` from outside could race ahead of it).
 */
export const defaultWorkspaces: SerializedWorkspace[] = [
    {
        name: 'heater',
        manifest: {
            name: 'heater',
            concepts: ['heater.ts'],
            metadata: {},
        },
        files: [
            {
                name: 'heater.ts',
                status: 'unanalyzed',
                content: `import { define } from '@yaw-rx/ystate'
import { BehaviorSubject, Subject, filter } from 'rxjs'

// Current room temperature (degrees C)
export const temperature$ = new BehaviorSubject(10)

// External signals to turn the thermostat on and off. Plain Subjects, not
// BehaviorSubjects: a signal is an event, so it must not fire on subscribe.
// (A BehaviorSubject would emit its seed the instant a node subscribes,
// firing turnOn/turnOff unconditionally and looping off->on->power->off.)
export const turnOnSignal = new Subject<void>()
export const turnOffSignal = new Subject<void>()

// Thermostat thresholds as nextable streams so the running UI can tune
// them live; the filters below read the current value at emit time.
export const upperLimitT$ = new BehaviorSubject(26)
export const lowerLimitT$ = new BehaviorSubject(23)

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
    $: () => temperature$.pipe(filter(T => T >= lowerLimitT$.value)),
    next: () => ({}),
  },
  // Fires when temperature drops below the lower threshold, triggering heating
  belowLowerLimit: {
    $: () => temperature$.pipe(filter(T => T < lowerLimitT$.value)),
    next: () => ({}),
  },
  // Fires when temperature rises above the upper threshold, stopping heating
  aboveUpperLimit: {
    $: () => temperature$.pipe(filter(T => T > upperLimitT$.value)),
    next: () => ({}),
  },
})`,
            },
            {
                name: 'heater.form',
                status: 'unanalyzed',
                sections: {
                    template: `<div class="panel">
  <p class="temp">{{temperatureDisplay}}&deg;C</p>
  <div class="controls">
    <button onclick="turnOnSignal.next()">heater on</button>
    <button onclick="turnOffSignal.next()">heater off</button>
  </div>
  <div class="limits">
    <span>lower {{lower}}&deg;</span>
    <button onclick="lowerLimit(-1)">-</button>
    <button onclick="lowerLimit(1)">+</button>
    <span>upper {{upper}}&deg;</span>
    <button onclick="upperLimit(-1)">-</button>
    <button onclick="upperLimit(1)">+</button>
  </div>
  <rx-graph [config]="graphConfig" [series]="graphSeries"></rx-graph>
</div>`,
                    styles: `.panel { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); }
.temp { margin: 0; font-size: 2rem; color: var(--accent); }
.controls, .limits { display: flex; gap: 0.5rem; align-items: center; font-size: 0.8rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.3rem 0.7rem; border-radius: var(--radius-sm); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }`,
                },
                content: `import { timer, combineLatest, scan, map, mergeMap, take, takeUntil, filter, withLatestFrom } from 'rxjs'
import { Heater, temperature$, turnOnSignal, turnOffSignal, upperLimitT$, lowerLimitT$ } from './heater.js'

// --- Simulation Constants ---
const TICK_INTERVAL_MS = 100 // Speed: 100ms per tick (10 ticks/sec)
const TIME_SCALE = 1.0       // 1.0 = normal physics, 2.0 = 2x faster physics

// Derived delta-t in seconds passed to the thermal equation per tick
const DT_SECONDS = (TICK_INTERVAL_MS / 1000) * TIME_SCALE

// Re-export the streams the template reads directly:
// (via the $-suffixed aliases) {{lower}}/{{upper}}. The buttons push the
// signals and nudge the limits.
export { temperature$, turnOnSignal, turnOffSignal }
export const lower$ = lowerLimitT$
export const upper$ = upperLimitT$

// Map the temperature to 2dp for display for use in the template like
// {{temperatureDisplay}}
export const temperatureDisplay$ = temperature$.pipe(
  map(t => t.toFixed(2))
)

// Nudging a limit is arithmetic on its current value - script logic, since
// the template's event args are literals/refs, not expressions.
export const lowerLimit = (d: number) => lowerLimitT$.next(lowerLimitT$.value + d)
export const upperLimit = (d: number) => upperLimitT$.next(upperLimitT$.value + d)

// The graph wants a stream of arrays; scan the scalar temperature into a
// rolling window.
export const graphConfig = { 
  temperature: { label: 'temperature', color: '#88aaff' },
  lowerLimitT: { label: 'Lower Limit', color: 'green' },
  upperLimitT: { label: 'Upper Limit', color: 'red' } 
}

// Sample the graph at the same tick interval
const sample$ = timer(0, TICK_INTERVAL_MS)

export const graphSeries = {
  temperature: temperature$.pipe(
    scan((window, t) => [...window, t].slice(-60), [] as number[])
  ),
  upperLimitT: sample$.pipe(
    withLatestFrom(upper$),
    map(([_, upper]) => upper),
    scan((window, val) => [...window, val].slice(-60), [] as number[])
  ),
  lowerLimitT: sample$.pipe(
    withLatestFrom(lower$),
    map(([_, lower]) => lower),
    scan((window, val) => [...window, val].slice(-60), [] as number[])
  )
}

// The thermal model. m*C = thermal mass, k = wall conductance; each tick
// applies dT = (q_heater - k*(roomT - environmentT)) / mC. The heater only
// outputs power in its 'power' node - so the machine's state drives the
// physics, and the resulting temperature crosses thresholds that drive the
// machine: a coupled loop through shared streams, neither side owning it.
const environmentT = 10, wallConductance = 5000, mC = 60 * 1005, heaterPower = 100000

// init() starts (and closes) the machine and returns it by name; the form's
// onDestroy calls .stop() on each. The physics loop rides the same
// lifetime: takeUntil the heater reports 'stopped', so Stop tears it down
// with no leak.
export const init = () => {
  const heater = Heater.close().start('off')
  timer(0, TICK_INTERVAL_MS).pipe(
    mergeMap(() => combineLatest([temperature$, heater.state$]).pipe(take(1))),
    map(([roomT, s]) => {
      const heatLoss = wallConductance * (roomT - environmentT)
      const heaterOutput = s.node === 'power' ? heaterPower : 0
      const deltaT = ((heaterOutput - heatLoss) / mC) * DT_SECONDS
      return roomT + deltaT
    }),
    takeUntil(heater.status$.pipe(filter(x => x === 'stopped'))),
  ).subscribe(t => temperature$.next(t))
  return { heater }
}`,
            },
        ],
    },
    {
        name: 'checkout',
        manifest: {
            name: 'checkout',
            concepts: ['auth.ts', 'payment.ts', 'basket.ts'],
            metadata: {},
        },
        files: [
            {
                name: 'auth.ts',
                status: 'unanalyzed',
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
                status: 'unanalyzed',
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
                status: 'unanalyzed',
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
        ],
    },
]
