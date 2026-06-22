import { Observable, timer, filter, withLatestFrom } from 'rxjs';
import { define } from "./index.js"

const Auth = define({
  nodes: {
    loggedOut: { since: 0 },
    authenticated: { token: '', authenticatedAt: 0 },
  },
  edges: () => ({
    login:  { from: 'loggedOut',     to: 'authenticated', on: 'authenticate.next' },
    expire: { from: 'authenticated', to: 'loggedOut',     on: 'sessionExpire.next' },
  }),
}).implement(on => ({
  authenticate: on.authenticate({
    $: () => timer(2000),
    next: (result, dest, source) => ({ token: 'tok_abc', authenticatedAt: Date.now() }),
    error: (result) => ({ since: Date.now() }),
  }),
  sessionExpire: on.sessionExpire({
    $: () => timer(10000),
    next: (result, dest, source) => ({ since: Date.now() }),
    error: (result) => ({ token: '', authenticatedAt: 0 }),
  }),
}))

const Payment = define({
  nodes: {
    processing: { orderId: '' },
    approved: { confirmedAt: 0 },
    declined: { reason: '' },
  },
  edges: () => ({
    approve: { from: 'processing', to: 'approved', on: 'process.next' },
    decline: { from: 'processing', to: 'declined', on: 'process.error' },
  }),
}).implement(on => ({
  process: on.process({
    $: () => timer(3000),
    next: (result, dest, source) => ({ confirmedAt: Date.now() }),
    error: (result, dest, source) => ({ reason: String(result) }),
  }),
}))

const Basket = define({
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
  },
  incidenceMachines: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    addFromEmpty:    { from: 'empty',      to: 'addingItem', on: 'addItem.next' },
    addFromHasItems: { from: 'hasItems',   to: 'addingItem', on: 'addItem.next' },
    added:           { from: 'addingItem', to: 'hasItems',   on: 'itemAdded.next' },
    checkout:        { from: 'hasItems',   to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
}).implement(on => ({
  addItem: on.addItem({
    $: () => timer(500),
    next: (result, dest, source) => ({ itemId: String(result) }),
    error: (result) => ({}),
  }),
  itemAdded: on.itemAdded({
    $: () => timer(1000),
    next: (result, dest) => {
      const existing = dest?.items ?? []
      return { items: [...existing, `item-${existing.length + 1}`] }
    },
    error: (result) => ({ itemId: '' }),
  }),
  checkout: on.checkout({
    $: (ctx) => timer(500).pipe(
      withLatestFrom(ctx.auth.node$),
      filter(([_, auth]) => {
         if(auth.node === 'authenticated') {
            auth.data
            return true;
         }
         auth.data
         return false;
        }),
    ),
    next: (result) => ({ orderId: 'ORD-001' }),
    error: (result) => ({ items: [] as string[] }),
  }),
}))

// --- Runtime ---

// .close() validates Auth's graph satisfies E ⊆ V × V -
// every edge's from and to exist in the node set. Throws if not.
const authMachineSet = Auth.close()

// .start() runs the machine from the given entry node and returns
// a RunningMachineSet. node$ emits { node, data } on each transition,
// edge$ emits { edge, from, to } on each edge firing.
const auth = authMachineSet.start('loggedOut')

// node$ emits { node, data } whenever the machine transitions.
auth.node$.subscribe(state => console.log(`[${state.node}]`, state.data))

// edge$ emits { edge, from, to } on each edge firing.
auth.edge$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)

// Basket:
//   - absorbs Payment (checkout edge targets payment.processing)
//   - observes Auth (disconnected - no edges target its nodes)
//
// .close():
//   - merges Basket and Payment into one graph (the "root graph")
//   - validates Auth independently
//
// .start(entry, runningMachines, initialNodeData):
//   - entry: the starting node in the root graph
//   - runningMachines: running instances of disconnected machines,
//     passed to transition $ factories for observation
//   - initialNodeData: partial map of nodes to partial data, amending any node in the root graph
const basket = Basket.close().start('empty', { auth }, { hasItems: { items: ['item-0'] } })

// node$ fires for all nodes in the root graph (basket + payment).
// Completes when a terminal node is reached (no outgoing edges) -
// here that's payment.approved or payment.declined.
basket.node$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('basket complete'),
})

// edge$ fires for all edges in the merged graph.
basket.edge$.subscribe(event => console.log(`${event.edge}: ${event.from} -> ${event.to}`))

// Each absorbed machine also has its own RunningMachine, filtered
// from the root streams by namespace.
basket.runningMachines['payment'].node$.subscribe(state =>
  console.log(`[payment:${state.node}]`, state.data)
)

// --- Violations ---

const BasketBroken = define({
  nodes: {
    empty:    {},
    hasItems: { items: [] as string[] },
  },
  incidenceMachines: {
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
    next: (result) => ({}),
    error: (result) => ({}),
  }),
}))