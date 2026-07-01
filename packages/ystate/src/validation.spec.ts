import { of } from 'rxjs';
import { define } from './index.js';
import { closeMachineSet } from './closure.js';
import { validateMachineSet } from './validation.js';
import { ROOT } from './graph.js';
import { isMissingHandler, isUnusedTransition } from './machine.js';

describe('validateMachineSet', () => {
  it('warns missing-handler with both error and complete when neither is implemented', () => {
    const m = define({
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
    }).implement({
      go: { $: () => of({}), next: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    const handlerIssues = issues.filter(isMissingHandler);
    expect(handlerIssues).toHaveLength(1);
    expect(handlerIssues[0].transition).toBe('go');
    expect(handlerIssues[0].namespace).toBe(ROOT);
    expect(handlerIssues[0].handlers.sort()).toEqual(['complete', 'error']);
  });

  it('warns missing-handler with only complete when error is implemented', () => {
    const m = define({
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
    }).implement({
      go: { $: () => of({}), next: () => ({}), error: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    const handlerIssues = issues.filter(isMissingHandler);
    expect(handlerIssues).toHaveLength(1);
    expect(handlerIssues[0].handlers).toEqual(['complete']);
  });

  it('warns missing-handler with only error when complete is implemented', () => {
    const m = define({
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
    }).implement({
      go: { $: () => of({}), next: () => ({}), complete: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    const handlerIssues = issues.filter(isMissingHandler);
    expect(handlerIssues).toHaveLength(1);
    expect(handlerIssues[0].handlers).toEqual(['error']);
  });

  it('returns no issues when all handlers are implemented', () => {
    const m = define({
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
    }).implement({
      go: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    expect(issues).toHaveLength(0);
  });

  it('warns about each transition independently', () => {
    const m = define({
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 'go.next' },
        e2: { from: 'b', to: 'c', on: 'step.next' },
      },
    }).implement({
      go: { $: () => of({}), next: () => ({}) },
      step: { $: () => of({}), next: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    const handlerIssues = issues.filter(isMissingHandler);
    expect(handlerIssues).toHaveLength(2);
    expect(handlerIssues.map(i => i.transition).sort()).toEqual(['go', 'step']);
  });

  it('warns unused-transition when a transition is not referenced by any edge', () => {
    const im = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
      transitions: {
        go: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
        orphan: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
      },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    const ms = closeMachineSet(im as any);
    const issues = validateMachineSet(ms);
    const unusedIssues = issues.filter(isUnusedTransition);
    expect(unusedIssues).toHaveLength(1);
    expect(unusedIssues[0].transition).toBe('orphan');
  });

  it('does not warn unused-transition when all transitions are referenced', () => {
    const m = define({
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 'go.next' },
        e2: { from: 'b', to: 'c', on: 'step.next' },
      },
    }).implement({
      go: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
      step: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
    });

    const ms = m.close();
    const issues = validateMachineSet(ms);
    expect(issues.filter(isUnusedTransition)).toHaveLength(0);
  });

  it('validates transitions across unioned dep namespaces', () => {
    const Payment = define({
      nodes: { processing: {}, approved: {} },
      edges: {
        approve: { from: 'processing', to: 'approved', on: 'process.next' },
      },
    }).implement({
      process: { $: () => of({}), next: () => ({}) },
    });

    const Basket = define({
      nodes: { empty: {}, hasItems: {} },
      deps: { payment: Payment },
      edges: (refs) => ({
        add: { from: 'empty', to: 'hasItems', on: 'addItem.next' },
        checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'pay.next' },
      }),
    }).implement({
      addItem: { $: () => of({}), next: () => ({}) },
      pay: { $: () => of({}), next: () => ({}) },
    });

    const ms = Basket.close();
    const issues = validateMachineSet(ms);
    const paymentIssues = issues.filter(isMissingHandler).filter(i => i.namespace === 'payment');
    expect(paymentIssues).toHaveLength(1);
    expect(paymentIssues[0].transition).toBe('process');
    expect(paymentIssues[0].handlers.sort()).toEqual(['complete', 'error']);
  });

  it('validates transitions in disjoint dep namespaces', () => {
    const Auth = define({
      nodes: { loggedOut: {}, loggedIn: {} },
      edges: {
        login: { from: 'loggedOut', to: 'loggedIn', on: 'auth.next' },
      },
    }).implement({
      auth: { $: () => of({}), next: () => ({}) },
    });

    const App = define({
      nodes: { idle: {}, active: {} },
      deps: { auth: Auth },
      edges: {
        go: { from: 'idle', to: 'active', on: 'start.next' },
      },
    }).implement({
      start: { $: () => of({}), next: () => ({}), error: () => ({}), complete: () => ({}) },
    });

    const ms = App.close();
    const issues = validateMachineSet(ms);
    const authIssues = issues.filter(isMissingHandler).filter(i => i.namespace === 'auth');
    expect(authIssues).toHaveLength(1);
    expect(authIssues[0].transition).toBe('auth');
    expect(authIssues[0].handlers.sort()).toEqual(['complete', 'error']);
  });

  it('is accessible via the mixin chain', () => {
    const m = define({
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.next' } },
    }).implement({
      go: { $: () => of({}), next: () => ({}) },
    });

    const issues = m.close().validate();
    expect(issues.some(i => i.kind === 'missing-handler')).toBe(true);
  });
});
