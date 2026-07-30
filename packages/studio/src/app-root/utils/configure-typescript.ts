import * as monaco from 'monaco-editor'
import dtsBundle from 'virtual:dts-bundle'

let configured = false

/**
 * Sets the TypeScript compiler options and ambient .d.ts libs every file's
 * analysis depends on. Must run before the first 'typescript' model is ever
 * created - RuntimeFilesystemService's constructor calls this before
 * anything else. `typescriptDefaults.setCompilerOptions()` fires Monaco's
 * `onDidChange`, which `WorkerManager` (Monaco's internal TS worker
 * lifecycle, workerManager.js) reacts to by disposing whatever worker is
 * currently in flight and resetting its client to null. Running this
 * lazily - after analysis has already started spawning a worker - orphans
 * that in-flight analysis permanently: every file's `check()` call that was
 * already awaiting the old (now-disposed) client hangs forever, while only
 * a file analyzed *after* this runs gets a fresh, correctly-configured
 * worker. That was the cold-start bug: everything stuck in `analyzing`
 * except whichever file got edited (and thus re-checked) after the first
 * workspace page mounted and ran this configuration lazily.
 */
export function configureTypeScript(): void {
    if (configured) return
    configured = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaults = (monaco.languages as any).typescript.typescriptDefaults

    defaults.setCompilerOptions({
        target: 9 /* ES2022 */,
        module: 199 /* NodeNext */,
        moduleResolution: 99 /* NodeNext */,
        strict: true,
        esModuleInterop: true,
        allowNonTsExtensions: true,
    })

    for (const [, files] of Object.entries(dtsBundle)) {
        for (const [path, content] of Object.entries(files)) {
            defaults.addExtraLib(content, `file:///${path}`)
        }
    }
}
