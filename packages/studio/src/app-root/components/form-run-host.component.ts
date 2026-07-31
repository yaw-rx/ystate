import { Component, Inject, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { distinctUntilChanged, map, tap, type Observable, type Subscription } from 'rxjs'
import type { RunningMachineSet } from '@yaw-rx/ystate'
import { FormRunService, type PreparedForm } from '../services/form-run.service.js'
import type { SandboxResult } from '../services/sandbox.service.js'
import type { FormRunningDetail, FormErrorDetail } from '../utils/create-form-component.js'
import type { RunningMachineInfo } from './output-panel.component.js'
import './output-panel.component.js'

/**
 * The RHS view while forms run. Always mounted (display-swapped with the
 * editor by the page), driven by `[playing]`: false->true stamps the
 * workspace's forms as live elements, true->false tears them down (which
 * stops their machines - see create-form-component.ts). Tabs switch which
 * form is visible via `display`; a hidden form keeps running.
 *
 * The stamped tag is content-addressed and therefore only known at runtime,
 * so the element is created imperatively (no template can name a dynamic
 * tag). Everything else - tabs, terminal - is declarative. Forms report
 * themselves via bubbling events, aggregated here into the machines the
 * page animates and the errors this host's own terminal shows.
 */
@Component({
    selector: 'form-run-host',
    directives: [RxFor],
    template: `
        <div class="tabs" rx-for="tab of tabs by tag">
            <button class="tab" [class.active]="isActive(tab.tag)" onclick="selectTab(tab.tag)">{{tab.name}}</button>
        </div>
        <div #stage class="stage"></div>
        <output-panel [sandboxResult]="runResult" [runningMachines]="machineInfos"></output-panel>
    `,
    styles: `
        :host { display: flex; flex-direction: column; height: 100%; background: var(--bg-2); }
        .tabs { display: flex; border-bottom: var(--border-width) solid var(--border); background: var(--bg-1); overflow-x: auto; flex-shrink: 0; }
        .tab { background: none; border: none; border-right: var(--border-width) solid var(--border); color: var(--dim); font-family: var(--font-mono); font-size: 0.75rem; padding: 0.5rem 1rem; cursor: pointer; white-space: nowrap; }
        .tab:hover { color: var(--text); background: var(--bg-4); }
        .tab.active { color: var(--accent); background: var(--bg-3); border-bottom: 2px solid var(--accent); }
        .stage { flex: 1; overflow: auto; }
        .stage > * { display: none; }
        .stage > .active-form { display: block; }
    `,
})
export class FormRunHost extends RxElement {
    @Inject(FormRunService) private readonly formRun!: FormRunService

    @state workspaceName = ''
    @state playing = false
    @state tabs: PreparedForm[] = []
    @state activeTag = ''
    @state runResult: SandboxResult | null = null
    // The analysed run output: every machine init() actually produced,
    // named by its init-map key, with live lifecycle status. The terminal
    // reports "N machines running" from this.
    @state machineInfos: RunningMachineInfo[] = []

    stage!: HTMLDivElement
    private elements = new Map<string, HTMLElement>()
    private running = new Map<string, Record<string, RunningMachineSet>>()
    private errors = new Map<string, string>()
    private subs: Subscription[] = []
    // status$ subscriptions for the currently running machines - torn down
    // and rebuilt whenever the running set changes.
    private statusSubs: Subscription[] = []

    isActive(tag: string): Observable<boolean> {
        return this.activeTag$.pipe(map(t => t === tag))
    }

    override onRender(): void {
        this.addEventListener('form-running', (e: Event) => {
            const { tag, running } = (e as CustomEvent<FormRunningDetail>).detail
            this.running.set(tag, running)
            this.emitRunning()
        })
        this.addEventListener('form-error', (e: Event) => {
            const { tag, error } = (e as CustomEvent<FormErrorDetail>).detail
            this.errors.set(tag, error)
            this.refreshRunResult()
        })

        this.subs.push(this.playing$.pipe(
            distinctUntilChanged(),
            tap(playing => playing ? void this.start() : this.teardown()),
        ).subscribe())
    }

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
        this.teardown()
    }

    private clearStatusSubs(): void {
        for (const s of this.statusSubs) s.unsubscribe()
        this.statusSubs = []
    }

    private async start(): Promise<void> {
        this.errors.clear()
        this.refreshRunResult()
        let tabs: PreparedForm[]
        try {
            tabs = await this.formRun.prepare(this.workspaceName)
        } catch (e) {
            this.errors.set('<prepare>', e instanceof Error ? e.message : String(e))
            this.refreshRunResult()
            return
        }
        this.tabs = tabs
        this.activeTag = tabs[0]?.tag ?? ''
        for (const { tag } of tabs) {
            const el = document.createElement(tag)
            el.classList.toggle('active-form', tag === this.activeTag)
            this.elements.set(tag, el)
            this.stage.appendChild(el)
        }
    }

    private teardown(): void {
        // Removing the stamped elements drives each form's onDestroy -> stop().
        this.stage?.replaceChildren()
        this.clearStatusSubs()
        this.elements.clear()
        this.running.clear()
        this.errors.clear()
        this.machineInfos = []
        this.tabs = []
        this.activeTag = ''
        this.emitRunning()
        this.refreshRunResult()
        // Machines are now stopped; drop the executed-module cache so the next
        // Play re-evaluates every form and starts fresh instances.
        this.formRun.reset()
    }

    selectTab(tag: string): void {
        this.activeTag = tag
        for (const [t, el] of this.elements) el.classList.toggle('active-form', t === tag)
    }

    private emitRunning(): void {
        const named = [...this.running.values()].flatMap(byName => Object.entries(byName))
        const all = named.map(([, m]) => m)
        // Publish through the service (not a DOM event) so the ELK canvas
        // gets them - see FormRunService.runningMachines$.
        this.formRun.setRunningMachines(all)

        // Rebuild the terminal's machine list, subscribing each machine's
        // status$ so the reported status stays live (running -> stopped).
        for (const s of this.statusSubs) s.unsubscribe()
        this.statusSubs = []
        this.machineInfos = named.map(([name]) => ({ name, status: 'running' }))
        named.forEach(([name, machine], i) => {
            this.statusSubs.push(machine.status$.subscribe(status => {
                const next = [...this.machineInfos]
                if (next[i]) next[i] = { name, status }
                this.machineInfos = next
            }))
        })
    }

    private refreshRunResult(): void {
        const errors = [...this.errors.values()]
        this.runResult = errors.length > 0
            ? { ok: false, error: errors.join('\n\n') }
            : { ok: true, runtimeKinds: {}, graphs: {}, graphKinds: {}, transitionKeys: {}, closureResults: {} }
    }
}
