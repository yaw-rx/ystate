import { Observable, of, Subject, EMPTY, throwError } from 'rxjs';
import { define } from './index.js';
import { MachineUnhandledError, MachineCompletionError } from './runtime.js';

describe('startMachineSet', () => {
  it('emits the entry node on subscribe', (done) => {
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: { $: () => new Observable(), next: () => ({}) },
    });

    const rms = m.close().start('idle');
    rms.state$.subscribe({
      next: (state) => {
        expect(state.node).toBe('idle');
        expect(state.data).toEqual({});
        done();
      },
    });
  });

  it('transitions to the target node when $ emits', (done) => {
    const trigger = new Subject<string>();
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => trigger,
        next: (value: string) => ({ started: value }),
      },
    });

    const rms = m.close().start('idle');
    const states: { node: string; data: any }[] = [];
    rms.state$.subscribe({
      next: (s) => {
        states.push(s);
        if (states.length === 2) {
          expect(states[1].node).toBe('active');
          expect(states[1].data).toEqual({ started: 'now' });
          done();
        }
      },
    });
    trigger.next('now');
  });

  it('emits edge events on transition', (done) => {
    const trigger = new Subject<void>();
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: { $: () => trigger, next: () => ({}) },
    });

    const rms = m.close().start('idle');
    rms.event$.subscribe({
      next: (event) => {
        expect(event.edge).toBe('activate');
        expect(event.from).toBe('idle');
        expect(event.to).toBe('active');
        done();
      },
    });
    trigger.next();
  });

  it('completes state$ and event$ when reaching a terminal node', (done) => {
    const m = define({
      nodes: { idle: {}, terminal: {} },
      edges: { finish: { from: 'idle', to: 'terminal', on: 'go.next' } },
    }).implement({
      go: { $: () => of('done'), next: () => ({}) },
    });

    const rms = m.close().start('idle');
    let stateCompleted = false;
    let eventCompleted = false;
    rms.state$.subscribe({
      complete: () => {
        stateCompleted = true;
        if (eventCompleted) done();
      },
    });
    rms.event$.subscribe({
      complete: () => {
        eventCompleted = true;
        if (stateCompleted) done();
      },
    });
  });

  it('sets status$ to complete when reaching a terminal node', (done) => {
    const trigger = new Subject<void>();
    const m = define({
      nodes: { idle: {}, terminal: {} },
      edges: { finish: { from: 'idle', to: 'terminal', on: 'go.next' } },
    }).implement({
      go: { $: () => trigger, next: () => ({}) },
    });

    const rms = m.close().start('idle');
    const statuses: string[] = [];
    rms.status$.subscribe({
      next: (s) => {
        statuses.push(s);
        if (s === 'complete') {
          expect(statuses).toEqual(['running', 'complete']);
          done();
        }
      },
    });
    trigger.next();
  });

  it('traverses multiple edges in sequence', (done) => {
    const t1 = new Subject<void>();
    const t2 = new Subject<void>();
    const m = define({
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        first: { from: 'a', to: 'b', on: 'step1.next' },
        second: { from: 'b', to: 'c', on: 'step2.next' },
      },
    }).implement({
      step1: { $: () => t1, next: () => ({}) },
      step2: { $: () => t2, next: () => ({}) },
    });

    const rms = m.close().start('a');
    const nodes: string[] = [];
    rms.state$.subscribe({
      next: (s) => {
        nodes.push(s.node);
        if (nodes.length === 1) t1.next();
        if (nodes.length === 2) t2.next();
      },
      complete: () => {
        expect(nodes).toEqual(['a', 'b', 'c']);
        done();
      },
    });
  });

  it('passes source data and dest data to the handler', (done) => {
    const trigger = new Subject<string>();
    const m = define({
      nodes: { idle: { count: 0 }, active: { label: 'ready' } },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => trigger,
        next: (value: string, dest: { label: string }, source: { count: number }) => ({
          label: `${dest.label}-${value}-${source.count}`,
        }),
      },
    });

    const rms = m.close().start('idle');
    const states: any[] = [];
    rms.state$.subscribe({
      next: (s) => {
        states.push(s);
        if (states.length === 2) {
          expect(states[1].data).toEqual({ label: 'ready-go-0' });
          done();
        }
      },
    });
    trigger.next('go');
  });

  it('applies initialNodeData to override node defaults', (done) => {
    const trigger = new Subject<void>();
    const m = define({
      nodes: { idle: { count: 0 }, active: { label: 'default' } },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => trigger,
        next: (_v: void, dest: { label: string }) => ({ label: dest.label }),
      },
    });

    const rms = m.close().start('idle', undefined, { active: { label: 'custom' } } as any);
    const states: any[] = [];
    rms.state$.subscribe({
      next: (s) => {
        states.push(s);
        if (states.length === 2) {
          expect(states[1].data).toEqual({ label: 'custom' });
          done();
        }
      },
    });
    trigger.next();
  });
});

describe('error handling', () => {
  it('throws MachineUnhandledError when $ errors with no error edge', (done) => {
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => throwError(() => new Error('boom')),
        next: () => ({}),
      },
    });

    const rms = m.close().start('idle');
    rms.state$.subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(MachineUnhandledError);
        expect(err.transition).toBe('go');
        expect(err.node).toBe('idle');
        expect(err.cause).toBeInstanceOf(Error);
        done();
      },
    });
  });

  it('sets status$ to error on MachineUnhandledError', (done) => {
    const trigger = new Subject<void>();
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => trigger,
        next: () => ({}),
      },
    });

    const rms = m.close().start('idle');
    const statuses: string[] = [];
    rms.status$.subscribe({
      next: (s) => {
        statuses.push(s);
        if (s === 'error') {
          expect(statuses).toEqual(['running', 'error']);
          done();
        }
      },
    });
    trigger.error(new Error('boom'));
  });

  it('follows error edge when $ errors and error handler exists', (done) => {
    const m = define({
      nodes: { idle: {}, active: {}, failed: {} },
      edges: {
        activate: { from: 'idle', to: 'active', on: 'go.next' },
        fail: { from: 'idle', to: 'failed', on: 'go.error' },
      },
    }).implement({
      go: {
        $: () => throwError(() => new Error('oops')),
        next: () => ({}),
        error: (err: Error) => ({ reason: err.message }),
      },
    });

    const rms = m.close().start('idle');
    const states: any[] = [];
    rms.state$.subscribe({
      next: (s) => {
        states.push(s);
        if (s.node === 'failed') {
          expect(states[states.length - 1].data).toEqual({ reason: 'oops' });
          done();
        }
      },
    });
  });

  it('throws MachineCompletionError when $ completes without emission and no complete edge', (done) => {
    const m = define({
      nodes: { idle: {}, active: {} },
      edges: { activate: { from: 'idle', to: 'active', on: 'go.next' } },
    }).implement({
      go: {
        $: () => EMPTY,
        next: () => ({}),
      },
    });

    const rms = m.close().start('idle');
    rms.state$.subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(MachineCompletionError);
        expect(err.transition).toBe('go');
        expect(err.node).toBe('idle');
        done();
      },
    });
  });

  it('follows complete edge when $ completes and complete handler exists', (done) => {
    const m = define({
      nodes: { idle: {}, active: {}, done: {} },
      edges: {
        activate: { from: 'idle', to: 'active', on: 'go.next' },
        finish: { from: 'idle', to: 'done', on: 'go.complete' },
      },
    }).implement({
      go: {
        $: () => EMPTY,
        next: () => ({}),
        complete: () => ({ finished: true }),
      },
    });

    const rms = m.close().start('idle');
    const states: any[] = [];
    rms.state$.subscribe({
      next: (s) => {
        states.push(s);
      },
      complete: () => {
        expect(states[states.length - 1].node).toBe('done');
        expect(states[states.length - 1].data).toEqual({ finished: true });
        done();
      },
    });
  });
});

describe('unioned deps at runtime', () => {
  it('traverses across namespace boundaries in the supergraph', (done) => {
    const payTrigger = new Subject<void>();
    const Payment = define({
      nodes: { processing: {}, approved: {} },
      edges: { approve: { from: 'processing', to: 'approved', on: 'process.next' } },
    }).implement({
      process: {
        $: () => payTrigger,
        next: () => ({ confirmed: true }),
      },
    });

    const basketTrigger = new Subject<void>();
    const payTrigger2 = new Subject<void>();
    const Basket = define({
      nodes: { empty: {}, hasItems: {} },
      deps: { payment: Payment },
      edges: (refs) => ({
        add: { from: 'empty', to: 'hasItems', on: 'addItem.next' },
        checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'pay.next' },
      }),
    }).implement({
      addItem: { $: () => basketTrigger, next: () => ({ items: ['apple'] }) },
      pay: { $: () => payTrigger2, next: () => ({}) },
    });

    const rms = Basket.close().start('empty');
    const nodes: string[] = [];
    rms.state$.subscribe({
      next: (s) => {
        nodes.push(s.node);
        if (s.node === 'hasItems') {
          payTrigger2.next();
        }
        if (s.node === 'payment.processing') {
          payTrigger.next();
        }
      },
      complete: () => {
        expect(nodes).toEqual(['empty', 'hasItems', 'payment.processing', 'payment.approved']);
        done();
      },
    });
    basketTrigger.next();
  });
});

describe('disjoint deps at runtime', () => {
  it('includes disjoint running machines in runningMachines', () => {
    const Auth = define({
      nodes: { loggedOut: {}, loggedIn: {} },
      edges: { login: { from: 'loggedOut', to: 'loggedIn', on: 'auth.next' } },
    }).implement({
      auth: { $: () => new Observable(), next: () => ({}) },
    });

    const App = define({
      nodes: { idle: {}, active: {} },
      deps: { auth: Auth },
      edges: { go: { from: 'idle', to: 'active', on: 'start.next' } },
    }).implement({
      start: { $: () => new Observable(), next: () => ({}) },
    });

    const authMs = Auth.close();
    const authRunning = authMs.start('loggedOut');

    const rms = App.close().start('idle', { auth: authRunning });
    expect(rms.runningMachines['auth']).toBeDefined();
    expect(rms.runningMachines['auth'].kind).toBe('disjoint');
  });
});
