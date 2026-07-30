import * as monaco from 'monaco-editor'

/**
 * Monaco defers its own DI bootstrap (`StandaloneServices`) until the first
 * real editor instance is created - `monaco.editor.create(...)`, same call
 * `code-panel.component.ts` makes when a workspace page mounts. Language
 * registration (`languages.onLanguage('typescript', ...)`, which is what
 * eventually makes `getTypeScriptWorker()` resolve) is queued behind that
 * bootstrap via `StandaloneServices.withServices` and won't fire until it
 * runs - model creation alone doesn't reliably trigger it early enough for
 * analysis that starts before any workspace page has ever been opened.
 *
 * This forces that bootstrap once, at app startup, using a throwaway editor
 * attached to a detached (never-appended) element and disposed immediately -
 * the only supported public entry point for it, just run eagerly instead of
 * waiting on the first real editor mount.
 */
export function warmUpMonacoServices(): void {
    const scratch = document.createElement('div')
    const editor = monaco.editor.create(scratch, { model: null })
    editor.dispose()
}
