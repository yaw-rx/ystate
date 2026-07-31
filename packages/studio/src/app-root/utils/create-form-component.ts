import { Component, RxElement } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { RxIf } from '@yaw-rx/core/directives/rx-if'
import type { RunningMachineSet } from '@yaw-rx/ystate'

/**
 * The event a running form dispatches once `init()` has produced its
 * machines - the run host listens for it and forwards the machines to the
 * ELK canvas to drive animation. `form-stopped` fires on teardown.
 */
export interface FormRunningDetail {
    tag: string
    running: Record<string, RunningMachineSet>
}

/** Dispatched when `init()` throws - a half-baked form (bad entry node, a dep that won't close). The run host shows it in the terminal instead of letting it crash the mount. */
export interface FormErrorDetail {
    tag: string
    error: string
}

/**
 * Turns an executed form script's exports (from LiveModulesService) plus
 * its template/styles into a live custom element, registered under `tag`.
 *
 * Every export becomes a getter on the instance - uniformly, whatever its
 * kind. The template resolves names against the instance: an observable
 * export drives `{{...}}`/`[...]` bindings, a subject export is the target
 * of `onclick="sig.next(...)"`, a function export is an event handler.
 * There is no per-kind branching here; the binding system already does the
 * right thing per name (see @yaw-rx/core binding/path.ts).
 *
 * `init` is the one export with special meaning: called on mount, it starts
 * (and closes) the form's machines and returns them by name. Each is a
 * `RunningMachineSet` - the thing `.start()` produces - so `.stop()` is
 * exactly the external disposal the ystate runtime exposes for machines
 * with no terminal node (see the ystate README's "Stopping"). On teardown
 * we call it on each.
 *
 * The tag is content-addressed (see form-tag.ts), so a given tag maps to
 * exactly one class over exactly one set of live instances. Redefining is
 * therefore never correct nor allowed - if the tag already exists, its
 * class is reused as-is.
 */
export function createFormComponent(
    tag: string,
    template: string,
    styles: string,
    exports: Record<string, unknown>,
): CustomElementConstructor {
    const existing = customElements.get(tag)
    if (existing !== undefined) return existing

    class FormElement extends RxElement {
        private running: Record<string, RunningMachineSet> = {}

        override onInit(): void {
            const init = exports['init']
            if (typeof init !== 'function') return
            try {
                this.running = (init as () => Record<string, RunningMachineSet>)() ?? {}
            } catch (e) {
                // A half-baked form - init() closing a machine that won't
                // close, starting at a node that doesn't exist. Surface it
                // in the run terminal, don't crash the mount.
                this.dispatchEvent(new CustomEvent<FormErrorDetail>('form-error', {
                    bubbles: true,
                    composed: true,
                    detail: { tag, error: e instanceof Error ? e.message : String(e) },
                }))
                return
            }
            this.dispatchEvent(new CustomEvent<FormRunningDetail>('form-running', {
                bubbles: true,
                composed: true,
                detail: { tag, running: this.running },
            }))
        }

        override onDestroy(): void {
            for (const machine of Object.values(this.running)) machine.stop()
            this.running = {}
            this.dispatchEvent(new CustomEvent('form-stopped', { bubbles: true, composed: true, detail: { tag } }))
        }
    }

    // Expose every export as a getter the template's bindings resolve
    // against. Getters (not fields) so they always read the current live
    // value and are never overwritten by the binding system.
    for (const key of Object.keys(exports)) {
        Object.defineProperty(FormElement.prototype, key, {
            get() { return exports[key] },
            enumerable: true,
            configurable: true,
        })
    }

    // Manual decorator application - the class is generated, not authored,
    // so there's no decorator syntax site. Component() registers the tag
    // via customElements.define and compiles the template.
    Component({
        selector: tag,
        template,
        styles,
        directives: [RxFor, RxIf],
    })(FormElement as unknown as CustomElementConstructor, undefined as unknown as ClassDecoratorContext)

    return FormElement as unknown as CustomElementConstructor
}
