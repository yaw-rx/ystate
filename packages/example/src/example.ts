import { Observable, timer, filter, withLatestFrom, mergeMap, throwError, of, EMPTY } from 'rxjs';
import { define, MachineUnhandledError, MachineCompletionError } from '@yaw-rx/ystate';

// --- Environment Observables ---

const loginErrors = ['auth server unreachable', 'invalid credentials', 'account locked', 'rate limited']
const simulateLogin = () => timer(2000).pipe(
  mergeMap(() => Math.random() > 0.2
    ? of({ token: `tok_${Date.now()}` })
    : throwError(() => new Error(loginErrors[Math.floor(Math.random() * loginErrors.length)]))
  )
)

const simulateSessionTimeout = () => timer(10000)

const simulatePayment = () => timer(3000).pipe(
  mergeMap(() => {
    const r = Math.random()
    if (r > 0.3) return of({ txId: `tx_${Date.now()}` })
    if (r > 0.1) return throwError(() => new Error('card declined'))
    return EMPTY
  })
)

const simulateAddItem = () => timer(500).pipe(
  mergeMap(() => Math.random() > 0.1
    ? of({ itemId: `item-${Date.now()}` })
    : throwError(() => new Error('item out of stock'))
  )
)

const simulateItemConfirmation = () => timer(1000)

// --- Machines ---

const Auth = define({
  nodes: {
    loggedOut: { since: 0 },
    authenticated: { token: '', authenticatedAt: 0 },
    loginFailed: { reason: '' },
  },
  edges: () => ({
    login: { from: 'loggedOut', to: 'authenticated', on: 'authenticate.next' },
    loginError: { from: 'loggedOut', to: 'loginFailed', on: 'authenticate.error' },
    retry: { from: 'loginFailed', to: 'loggedOut', on: 'retryLogin.next' },
    expire: { from: 'authenticated', to: 'loggedOut', on: 'sessionExpire.next' },
  }),
}).implement(on => ({
  // simulateLogin() can error for various reasons (server unreachable,
  // invalid credentials, account locked, rate limited), so authenticate
  // needs error edges in the graph to handle it. Without them the machine
  // would throw MachineUnhandledError.
  authenticate: on.authenticate({
    $: () => simulateLogin(),
    next: (result) => ({ token: result.token, authenticatedAt: Date.now() }),
    error: (err) => ({ reason: String(err) }),
  }),
  // timer(2000) is a simple delay that cannot error or complete without
  // emission, so no error or complete edges are needed. If it did, the
  // machine would throw MachineUnhandledError or MachineCompletionError.
  retryLogin: on.retryLogin({
    $: () => timer(2000),
    next: () => ({ since: Date.now() }),
  }),
  // simulateSessionTimeout() is a simple timer that cannot error or
  // complete without emission, so no error or complete edges are needed.
  // If it did, the machine would throw MachineUnhandledError or
  // MachineCompletionError.
  sessionExpire: on.sessionExpire({
    $: () => simulateSessionTimeout(),
    next: (_result, _dest, source) => ({ since: source.authenticatedAt }),
  }),
}))

const Payment = define({
  nodes: {
    processing: { orderId: '' },
    approved: { confirmedAt: 0, txId: '' },
    declined: { reason: '' },
    stalled: { orderId: '' },
  },
  edges: () => ({
    approve: { from: 'processing', to: 'approved', on: 'process.next' },
    decline: { from: 'processing', to: 'declined', on: 'process.error' },
    stall: { from: 'processing', to: 'stalled', on: 'process.complete' },
  }),
}).implement(on => ({
  // simulatePayment() can emit (approved), error (declined), or complete
  // without emission (stalled). All three outcomes are handled by edges
  // in the graph, so next, error, and complete are all required.
  process: on.process({
    $: () => simulatePayment(),
    next: (result) => ({ confirmedAt: Date.now(), txId: result.txId }),
    error: (err) => ({ reason: String(err) }),
    complete: (_result, _dest, source) => ({ orderId: source.orderId }),
  }),
}))

const Basket = define({
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
}).implement(on => ({
  // simulateAddItem() can throw 'item out of stock', so addItem needs
  // error edges in the graph to handle it. Without them the machine
  // would throw MachineUnhandledError.
  addItem: on.addItem({
    $: () => simulateAddItem(),
    next: (result, _dest, _source, edge) => ({ itemId: `${result.itemId}-via-${edge}` }),
    error: (err, dest, _source, edge) => ({ error: `${edge}: ${String(err)}`, items: dest.items }),
  }),
  // simulateItemConfirmation() is a simple timer that cannot error or
  // complete without emission, so no error or complete edges are needed.
  // If it did, the machine would throw MachineUnhandledError or
  // MachineCompletionError.
  itemAdded: on.itemAdded({
    $: () => simulateItemConfirmation(),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  }),
  // checkout waits for auth to be authenticated before emitting. The
  // observable cannot error or complete, so no error or complete
  // edges are needed.
  checkout: on.checkout({
    $: (deps) => timer(500).pipe(
      withLatestFrom(deps.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (_result, _dest, _source, edge) => ({ orderId: `ORD-${Date.now()}-${edge}` }),
  }),
}))

// --- Runtime ---

// .close() validates Auth's graph satisfies E ⊆ V × V -
// every edge's from and to exist in the node set. Throws if not.
const authMachineSet = Auth.close()

// .start() runs the machine from the given entry node and returns
// a RunningMachineSet. state$ emits { node, data } on each transition,
// event$ emits { edge, from, to } on each edge firing.
const auth = authMachineSet.start('loggedOut')

// Machine errors (MachineUnhandledError, MachineCompletionError) propagate
// to both state$ and event$. You can handle them on either stream.
auth.state$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('auth complete'),
  error: (err) => {
    if (err instanceof MachineUnhandledError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace, cause: err.cause })
    } else if (err instanceof MachineCompletionError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace })
    } else {
      console.error('unknown error:', err)
    }
  },
})

// event$ emits { edge, from, to } on each edge firing.
auth.event$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)

// status$ emits the machine's lifecycle state: 'running', 'complete', or 'error'.
auth.status$.subscribe(status => console.log(`auth status: ${status}`))

// Basket:
//   - Payment's nodes are referenced by edges, so its graph
//     is merged into the supergraph G'
//   - Auth's nodes are not referenced by any edge, so Auth
//     is validated independently by .close()
//
// .close():
//   - merges Basket and Payment into the supergraph G'
//   - validates Auth independently
//
// .start(entry, runningMachines, initialNodeData):
//   - entry: the starting node in G'
//   - runningMachines: running instances of independently validated machines,
//     passed to transition $ factories for observation
//   - initialNodeData: partial map of nodes to partial data, amending any node in G'
const basket = Basket.close().start('empty', { auth }, { hasItems: { items: ['item-0'] } })

// state$ fires for all nodes in G' (basket + payment merged).
// Completes when a terminal node is reached (no outgoing edges) -
// here that's payment.approved, payment.declined, or payment.stalled.
basket.state$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('basket complete'),
})

// event$ fires for all edges in G'.
basket.event$.subscribe({
  next: (event) => console.log(`${event.edge}: ${event.from} -> ${event.to}`),
  error: (err) => {
    if (err instanceof MachineUnhandledError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace, cause: err.cause })
    } else if (err instanceof MachineCompletionError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace })
    } else {
      console.error('unknown error:', err)
    }
  },
})

// status$ emits the machine's lifecycle state: 'running', 'complete', or 'error'.
basket.status$.subscribe(status => console.log(`basket status: ${status}`))

// Each machine whose graph was merged into G' has its own
// RunningMachine, filtered from the root streams by namespace.
basket.runningMachines['payment'].state$.subscribe(state =>
  console.log(`[payment:${state.node}]`, state.data)
)

// --- Violations ---

const BasketBroken = define({
  nodes: {
    empty: {},
    hasItems: { items: [] as string[] },
  },
  deps: {
    payment: Payment,
  },
  edges: (refs) => ({
    add: { from: 'empty', to: 'hasItems', on: 'addItem.next' },
    // VIOLATION: 'browsing' is not a node
    bad: { from: 'browsing', to: 'empty', on: 'addItem.next' },
    // VIOLATION: 'refunded' does not exist in Payment
    checkout: { from: 'hasItems', to: refs.payment.nodes.refunded, on: 'addItem.next' },
  }),
}).implement(on => ({
  addItem: on.addItem({
    $: () => new Observable(),
    next: (_result) => ({}),
  }),
}))
