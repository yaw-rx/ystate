import { define } from '@yaw-rx/ystate'
import { Subject, fromEvent } from 'rxjs'
import type { SandboxResponse } from '../services/sandbox.service.js'

/**
 * The sandbox worker's full lifecycle AND the transport itself - not a
 * status tracker bolted onto mechanics implemented elsewhere. This module
 * owns constructing the `Worker`, `postMessage`, response correlation, and
 * the queue of in-flight command ids; the only thing it exposes outward
 * beyond the running machine itself is `send()`. A caller never touches a
 * `Worker`, a pending map, or connection state directly.
 *
 * `cold` (never connected) and `crashed` (was connected, then died) are
 * separate nodes on purpose - a consumer of `state$` can tell "starting
 * up" from "just died" even though both reconnect via the same
 * `connect.next` trigger. `processing` carries the live queue of in-flight
 * command ids as node data - real observability, not a bare busy bit -
 * but which edge fires (`processing` vs `idle`) is still decided here,
 * inside this closure, never leaked to a caller: a fixed-target edge can't
 * conditionally route based on data a `next` handler computes.
 */
const workerTopology = define({
    nodes: {
        cold: {},
        idle: {},
        processing: { queue: [] as number[] },
        crashed: {},
    },
    edges: {
        connect: { from: 'cold', to: 'idle', on: 'connect.next' },
        reconnect: { from: 'crashed', to: 'idle', on: 'connect.next' },
        crashFromIdle: { from: 'idle', to: 'crashed', on: 'crash.next' },
        crashFromProcessing: { from: 'processing', to: 'crashed', on: 'crash.next' },
        start: { from: 'idle', to: 'processing', on: 'job.next' },
        restart: { from: 'processing', to: 'processing', on: 'job.next' },
        finish: { from: 'processing', to: 'idle', on: 'idle.next' },
    },
})

export function createSandboxWorkerMachine() {
    const connect$ = new Subject<void>()
    const job$ = new Subject<number[]>()
    const idle$ = new Subject<void>()

    let current: Worker | null = null
    let nextId = 0
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

    const machine = workerTopology.implement({
        connect: {
            $: () => connect$,
            next: () => {
                current = new Worker(new URL('../workers/sandbox.worker.ts', import.meta.url), { type: 'module' })
                current.addEventListener('message', (event: MessageEvent<SandboxResponse>) => {
                    const response = event.data
                    const entry = pending.get(response.id)
                    if (!entry) return
                    pending.delete(response.id)
                    if (response.command === 'error') entry.reject(new Error(response.error))
                    else entry.resolve(response)
                    if (pending.size === 0) idle$.next()
                    else job$.next([...pending.keys()])
                })
                return {}
            },
        },
        // The actual browser Worker's real 'error' event, not a synthetic
        // signal. Safe to read `current!`: `crash`'s $ is only invoked on
        // entry to 'idle'/'processing' (runtime.ts's listen()), both only
        // reachable after `connect`'s `next` has already set `current`.
        crash: {
            $: () => fromEvent<ErrorEvent>(current!, 'error'),
            next: () => {
                for (const [, { reject }] of pending) reject(new Error('Sandbox worker crashed'))
                pending.clear()
                current = null
                return {}
            },
        },
        job: {
            $: () => job$,
            next: (queue) => ({ queue }),
        },
        idle: {
            $: () => idle$,
            next: () => ({}),
        },
    })

    const running = machine.close().start('cold')

    function ensureConnected(): Worker {
        if (!current) connect$.next()
        return current!
    }

    function send<T extends SandboxResponse>(command: Record<string, unknown>): Promise<T> {
        const id = nextId++
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            // Connect before announcing the job: 'cold' has no `job.next`
            // edge, so firing job$ before the machine has reached 'idle'
            // would just be silently dropped.
            const worker = ensureConnected()
            job$.next([...pending.keys()])
            worker.postMessage({ id, ...command })
        })
    }

    function dispose(): void {
        current?.terminate()
        current = null
        pending.clear()
    }

    return { runningMachine: running, send, dispose }
}
