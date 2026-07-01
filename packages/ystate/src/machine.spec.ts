import { of } from 'rxjs';
import { ROOT } from './graph.js';
import { flattenIncidenceMachines, buildMachineCorrespondence } from './machine.js';
import type { IncidenceMachine } from './machine.js';
import type { NodeData, EdgeDef, TransitionDef, IncidenceGraph } from './graph.js';

function makeMachine(
  nodes: Record<string, NodeData>,
  edges: Record<string, EdgeDef>,
  transitions: Record<string, TransitionDef> = {},
  deps: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>> = {}
): IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>> {
  return { nodes, edges, transitions, deps, source: { nodes, edges, deps } }
}

describe('flattenIncidenceMachines', () => {
  it('flattens a single unioned dep to one entry with its namespace', () => {
    const payment = makeMachine(
      { processing: {}, approved: {} },
      { approve: { from: 'processing', to: 'approved', on: 'process.next' } },
      { process: { $: () => of({}), next: () => ({}) } },
    );
    const { flattened, namespaceMap } = flattenIncidenceMachines({ payment }, ['payment']);
    expect(flattened).toHaveLength(1);
    expect(flattened[0].namespace).toBe('payment');
    expect(flattened[0].incidenceMachine).toBe(payment);
    expect(namespaceMap).toEqual({ payment: 'payment' });
  });

  it('applies parent namespace prefix', () => {
    const inner = makeMachine({ a: {} }, {});
    const { flattened, namespaceMap } = flattenIncidenceMachines({ inner }, ['inner'], 'outer');
    expect(flattened[0].namespace).toBe('outer.inner');
    expect(namespaceMap).toEqual({ inner: 'outer.inner' });
  });

  it('recurses into unioned deps of deps', () => {
    const leaf = makeMachine(
      { done: {} },
      {},
      { fin: { $: () => of({}), next: () => ({}) } },
    );
    const ref = { __brand: 'depNodeRef' as const, dep: 'leaf', node: 'done' };
    const mid = makeMachine(
      { start: {} },
      { go: { from: 'start', to: ref as any, on: 'run.next' } },
      { run: { $: () => of({}), next: () => ({}) } },
      { leaf },
    );
    const { flattened, namespaceMap } = flattenIncidenceMachines({ mid }, ['mid']);
    expect(flattened).toHaveLength(2);
    expect(flattened[0].namespace).toBe('mid');
    expect(flattened[1].namespace).toBe('mid.leaf');
    expect(namespaceMap['mid']).toBe('mid');
    expect(namespaceMap['leaf']).toBe('mid.leaf');
  });

  it('skips disjoint deps during recursion', () => {
    const disjointDep = makeMachine({ x: {} }, {});
    const parent = makeMachine(
      { a: {} },
      { e1: { from: 'a', to: 'a', on: 't.next' } },
      { t: { $: () => of({}), next: () => ({}) } },
      { side: disjointDep },
    );
    const { flattened } = flattenIncidenceMachines({ parent }, ['parent']);
    expect(flattened).toHaveLength(1);
    expect(flattened[0].namespace).toBe('parent');
  });

  it('returns empty for no unioned deps', () => {
    const dep = makeMachine({ a: {} }, {});
    const { flattened, namespaceMap } = flattenIncidenceMachines({ dep }, []);
    expect(flattened).toHaveLength(0);
    expect(namespaceMap).toEqual({});
  });
});

describe('buildMachineCorrespondence', () => {
  it('maps root nodes and edges to ROOT namespace', () => {
    const rootGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    };
    const transitions = { go: { $: () => of({}), next: () => ({}) } };
    const corr = buildMachineCorrespondence(rootGraph, transitions, [], [], []);

    expect(corr.preimage[ROOT].nodes).toEqual({ idle: 'idle', active: 'active' });
    expect(corr.preimage[ROOT].edges).toEqual({ activate: 'activate' });
    expect(corr.image[ROOT].nodes).toEqual({ idle: 'idle', active: 'active' });
    expect(corr.image[ROOT].edges).toEqual({ activate: 'activate' });
    expect(corr.transitions[ROOT]).toBe(transitions);
  });

  it('maps namespaced nodes and edges with local name stripping', () => {
    const rootGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { idle: {} },
      edges: {},
    };
    const nsGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { 'pay.processing': {}, 'pay.approved': {} },
      edges: { 'pay.approve': { from: 'pay.processing', to: 'pay.approved', on: 'process.next' } },
    };
    const payTransitions = { process: { $: () => of({}), next: () => ({}) } };
    const corr = buildMachineCorrespondence(
      rootGraph,
      {},
      [{ namespace: 'pay', namespacedGraph: nsGraph, transitions: payTransitions }],
      ['pay'],
      [],
    );

    expect(corr.preimage['pay'].nodes).toEqual({ 'pay.processing': 'processing', 'pay.approved': 'approved' });
    expect(corr.preimage['pay'].edges).toEqual({ 'pay.approve': 'approve' });
    expect(corr.image['pay'].nodes).toEqual({ processing: 'pay.processing', approved: 'pay.approved' });
    expect(corr.image['pay'].edges).toEqual({ approve: 'pay.approve' });
    expect(corr.transitions['pay']).toBe(payTransitions);
  });

  it('passes through unioned and disjoint arrays', () => {
    const rootGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: {},
    };
    const corr = buildMachineCorrespondence(rootGraph, {}, [], ['pay'], ['auth']);
    expect(corr.unioned).toEqual(['pay']);
    expect(corr.disjoint).toEqual(['auth']);
  });
});
