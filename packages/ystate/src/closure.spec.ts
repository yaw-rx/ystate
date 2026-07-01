import { Observable, of } from 'rxjs';
import { define } from './index.js';
import { closeGraph, closeMachineSet } from './closure.js';
import { IncidenceGraphSetClosureError, ROOT, isGraphMissingDep, isGraphMissingTarget, isGraphMissingSource, isMultipleGraphs } from './graph.js';
import { IncidenceMachineClosureError, isClosureMissingTransition, isClosureMissingHandler, isMalformedEdgeOn } from './machine.js';
import type { IncidenceGraph, NodeData, EdgeDef } from './graph.js';

describe('closeGraph', () => {
  it('resolves refs, unions subgraphs, and produces a closed graph', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'ns', node: 'c' };
    const root = {
      nodes: { a: {}, b: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 't.next' },
        e2: { from: 'b', to: ref, on: 't.next' },
      },
    };
    const sub: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { 'ns.c': {} },
      edges: {},
    };
    const result = closeGraph(root as any, { ns: 'ns' }, [sub]);
    expect(Object.keys(result.nodes).sort()).toEqual(['a', 'b', 'ns.c']);
    expect(result.edges['e2'].to).toBe('ns.c');
  });

  it('throws IncidenceGraphSetClosureError with multiple-graphs when union is disconnected', () => {
    const root: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: {},
    };
    const sub: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { 'ns.b': {} },
      edges: {},
    };
    try {
      closeGraph(root, {}, [sub]);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      const mg = e.issues.filter(isMultipleGraphs);
      expect(mg).toHaveLength(1);
      expect(mg[0].graphs).toHaveLength(2);
    }
  });

  it('throws IncidenceGraphSetClosureError with missing-target when target node does not exist', () => {
    const root: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: { e1: { from: 'a', to: 'missing', on: 't.next' } },
    };
    try {
      closeGraph(root, {}, []);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      const targets = e.issues.filter(isGraphMissingTarget);
      expect(targets).toHaveLength(1);
      expect(targets[0].edge).toBe('e1');
      expect(targets[0].node).toBe('missing');
      expect(targets[0].availableNodes).toContain('a');
    }
  });

  it('throws IncidenceGraphSetClosureError with missing-source when source node does not exist', () => {
    const root: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: { e1: { from: 'missing', to: 'a', on: 't.next' } },
    };
    try {
      closeGraph(root, {}, []);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      const sources = e.issues.filter(isGraphMissingSource);
      expect(sources).toHaveLength(1);
      expect(sources[0].edge).toBe('e1');
      expect(sources[0].node).toBe('missing');
      expect(sources[0].availableNodes).toContain('a');
    }
  });

  it('throws IncidenceGraphSetClosureError with missing-dep when a DepNodeRef references an unknown dep', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'unknown', node: 'x' };
    const root = {
      nodes: { a: {} },
      edges: { e1: { from: 'a', to: ref, on: 't.next' } },
    };
    try {
      closeGraph(root as any, {}, []);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      const deps = e.issues.filter(isGraphMissingDep);
      expect(deps).toHaveLength(1);
      expect(deps[0].edge).toBe('e1');
      expect(deps[0].dep).toBe('unknown');
    }
  });

  it('collects issues from both ref resolution and closure validation in one error', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'unknown', node: 'x' };
    const root = {
      nodes: { a: {}, b: {} },
      edges: {
        e1: { from: 'a', to: ref, on: 't.next' },
        e2: { from: 'b', to: 'missing', on: 't.next' },
      },
    };
    try {
      closeGraph(root as any, {}, []);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      expect(e.issues.filter(isGraphMissingDep)).toHaveLength(1);
      expect(e.issues.filter(isGraphMissingTarget)).toHaveLength(1);
    }
  });
});

describe('closeMachineSet', () => {
  it('closes a simple connected machine', () => {
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: {
        activate: { from: 'idle', to: 'active', on: 'go.next' },
      },
    }).implement({
      go: {
        $: () => new Observable(),
        next: () => ({}),
      },
    });

    const ms = m.close();
    expect(Object.keys(ms.graphs)).toContain(ROOT);
    expect(ms.machines[ROOT].F).toContain('active');
  });

  it('closes a machine with unioned deps into the supergraph', () => {
    const Payment = define({
      nodes: { processing: {}, approved: {} },
      edges: {
        approve: { from: 'processing', to: 'approved', on: 'process.next' },
      },
    }).implement({
      process: {
        $: () => of({}),
        next: () => ({}),
      },
    });

    const Basket = define({
      nodes: { empty: {}, hasItems: {} },
      deps: { payment: Payment },
      edges: (refs) => ({
        add: { from: 'empty', to: 'hasItems', on: 'addItem.next' },
        checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'pay.next' },
      }),
    }).implement({
      addItem: {
        $: () => of({}),
        next: () => ({}),
      },
      pay: {
        $: () => of({}),
        next: () => ({}),
      },
    });

    const ms = Basket.close();
    expect(ms.correspondence.unioned).toContain('payment');
    expect('payment.processing' in ms.graphs[ROOT].graph.nodes).toBe(true);
    expect('payment.approved' in ms.graphs[ROOT].graph.nodes).toBe(true);
  });

  it('closes disjoint deps independently', () => {
    const Auth = define({
      nodes: { loggedOut: {}, loggedIn: {} },
      edges: {
        login: { from: 'loggedOut', to: 'loggedIn', on: 'auth.next' },
      },
    }).implement({
      auth: {
        $: () => of({}),
        next: () => ({}),
      },
    });

    const App = define({
      nodes: { idle: {}, active: {} },
      deps: { auth: Auth },
      edges: {
        go: { from: 'idle', to: 'active', on: 'start.next' },
      },
    }).implement({
      start: {
        $: () => of({}),
        next: () => ({}),
      },
    });

    const ms = App.close();
    expect(ms.correspondence.disjoint).toContain('auth');
    expect(ms.graphs['auth']).toBeDefined();
    expect(ms.graphs['auth'].kind).toBe('disjoint');
  });

  it('throws IncidenceGraphSetClosureError with multiple-graphs when root graph is disconnected', () => {
    const im = {
      nodes: { a: {}, b: {}, c: {} },
      edges: { e1: { from: 'a', to: 'b', on: 't.next' } },
      transitions: { t: { $: () => new Observable(), next: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceGraphSetClosureError);
      const e = err as IncidenceGraphSetClosureError;
      const mg = e.issues.filter(isMultipleGraphs);
      expect(mg).toHaveLength(1);
      expect(mg[0].graphs).toHaveLength(2);
    }
  });

  it('throws IncidenceMachineClosureError with missing-transition when a transition is not implemented', () => {
    const im = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'missing.next' } },
      transitions: { other: { $: () => new Observable(), next: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceMachineClosureError);
      const e = err as IncidenceMachineClosureError;
      const mt = e.issues.filter(isClosureMissingTransition);
      expect(mt).toHaveLength(1);
      expect(mt[0].edge).toBe('e1');
      expect(mt[0].transition).toBe('missing');
      expect(mt[0].availableTransitions).toEqual(['other']);
    }
  });

  it('throws IncidenceMachineClosureError with malformed-edge-on when edge on field is invalid', () => {
    const im = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'noDot' } },
      transitions: {},
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceMachineClosureError);
      const e = err as IncidenceMachineClosureError;
      const mal = e.issues.filter(isMalformedEdgeOn);
      expect(mal).toHaveLength(1);
      expect(mal[0].edge).toBe('e1');
      expect(mal[0].on).toBe('noDot');
    }
  });

  it('throws IncidenceMachineClosureError with missing-handler when edge demands a direction the transition does not implement', () => {
    const im = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.error' } },
      transitions: { go: { $: () => new Observable(), next: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceMachineClosureError);
      const e = err as IncidenceMachineClosureError;
      const mh = e.issues.filter(isClosureMissingHandler);
      expect(mh).toHaveLength(1);
      expect(mh[0].transition).toBe('go');
      expect(mh[0].direction).toBe('error');
      expect(mh[0].availableHandlers).toEqual(['next']);
    }
  });

  it('throws IncidenceMachineClosureError with missing-handler for complete direction', () => {
    const im = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 'go.complete' } },
      transitions: { go: { $: () => new Observable(), next: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceMachineClosureError);
      const e = err as IncidenceMachineClosureError;
      const mh = e.issues.filter(isClosureMissingHandler);
      expect(mh).toHaveLength(1);
      expect(mh[0].direction).toBe('complete');
    }
  });

  it('does not throw missing-handler when the direction handler exists', () => {
    const im = {
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 'go.next' },
        e2: { from: 'a', to: 'c', on: 'go.error' },
      },
      transitions: { go: { $: () => new Observable(), next: () => ({}), error: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    expect(() => closeMachineSet(im as any)).not.toThrow();
  });

  it('collects multiple machine closure issues in one error', () => {
    const im = {
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 'go.error' },
        e2: { from: 'a', to: 'c', on: 'go.complete' },
      },
      transitions: { go: { $: () => new Observable(), next: () => ({}) } },
      deps: {},
      source: { nodes: {}, edges: {}, deps: {} },
    };
    try {
      closeMachineSet(im as any);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncidenceMachineClosureError);
      const e = err as IncidenceMachineClosureError;
      const mh = e.issues.filter(isClosureMissingHandler);
      expect(mh).toHaveLength(2);
      expect(mh.map(i => i.direction).sort()).toEqual(['complete', 'error']);
    }
  });
});
