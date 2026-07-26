import type { Observable } from 'rxjs';

export const isObservable = (obj: unknown): obj is Observable<unknown> =>
    obj != null && typeof (obj as Record<string, unknown>)['subscribe'] === 'function';
