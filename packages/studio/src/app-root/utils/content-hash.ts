/**
 * A fast, non-cryptographic content fingerprint (djb2/xor variant) - not a
 * security primitive, just cheap enough to compute for every file on every
 * save without the cost `sandbox.worker.ts`'s in-memory cache avoids by
 * comparing full strings directly. That comparison is free in memory;
 * persisting the full content a second time just to validate a cache
 * seed would double this app's storage footprint for no benefit a short
 * hash doesn't already give.
 */
export function hashContent(content: string): string {
    let hash = 5381
    for (let i = 0; i < content.length; i++) {
        hash = (hash * 33) ^ content.charCodeAt(i)
    }
    return (hash >>> 0).toString(36)
}
