import { fromEventPattern, map, startWith, shareReplay, type Observable } from 'rxjs'
import type * as monaco from 'monaco-editor'

/**
 * The single bridge from Monaco's imperative model API into RxJS. Monaco's
 * `onDidChangeContent` is a disposable-returning event emitter, not an
 * Observable - `fromEventPattern` wires RxJS's internal handler in as the
 * listener and calls `.dispose()` as the teardown, so unsubscribing here
 * actually detaches from the model instead of leaking a listener.
 *
 * `shareReplay({ refCount: true })` makes this a proxy in the literal
 * sense: every caller of this function for the same `model` gets a
 * reference to one shared multicast source, not an independent Monaco
 * listener each - the underlying subscription exists exactly while at
 * least one consumer needs it, and every consumer sees the same values.
 * Call this once per model, not once per consumer.
 */
export function modelContent$(model: monaco.editor.ITextModel): Observable<string> {
    return fromEventPattern<monaco.editor.IModelContentChangedEvent>(
        handler => model.onDidChangeContent(handler),
        (_handler, disposable) => disposable.dispose(),
    ).pipe(
        map(() => model.getValue()),
        startWith(model.getValue()),
        shareReplay({ bufferSize: 1, refCount: true }),
    )
}
