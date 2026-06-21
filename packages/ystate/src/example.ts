import { Observable, timer, filter, withLatestFrom } from 'rxjs';
import { defineMachine } from "./index.js"

const AuthGraph = defineMachine({
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

const PaymentGraph = defineMachine({
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

const BasketGraph = defineMachine({
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
  },
  context: {
    auth: AuthGraph,
    payment: PaymentGraph,
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
      withLatestFrom(ctx.auth.state$),
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

// --- Violations ---

/*const BasketBroken = defineMachine({
  nodes: {
    empty:    {},
    hasItems: { items: [] as string[] },
  },
  context: {
    payment: PaymentGraph,
  },
  edges: (refs) => ({
    add: { from: 'empty', to: 'hasItems', on: 'addItem.next' },
    // VIOLATION: 'browsing' is not a node
    bad: { from: 'browsing', to: 'empty', on: 'addItem.next' },
    // VIOLATION: 'refunded' does not exist in PaymentGraph
    checkout: { from: 'hasItems', to: refs.payment.nodes.refunded, on: 'addItem.next' },
  }),
}).implement(on => ({
  addItem: on.addItem({
    $: () => new Observable(),
    next: (result) => ({}),
    error: (result) => ({}),
  }),
}))*/