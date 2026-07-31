import { Component, RxElement, state } from '@yaw-rx/core'
import { RxFor } from '@yaw-rx/core/directives/rx-for'
import { map, type Observable, type Subscription } from 'rxjs'

/**
 * A canvas line chart, ported from yaw-example. One of the studio's
 * standard-library components: registered globally at bootstrap so any
 * form template can use `<rx-graph>` with no import.
 *
 * `series` is `Record<string, Observable<number[]>>` - the exact shape a
 * form produces by scanning an imported stream into a rolling window
 * (see the thermostat panel form). Each series draws as one line; `config`
 * gives it a label and colour.
 */
@Component({
    selector: 'rx-graph',
    directives: [RxFor],
    template: `
        <div class="legend" rx-for="{ label, color } of legendItems by label">
            <span><span class="dot" [style.background]="color"></span>{{label}}</span>
        </div>
        <canvas #canvas></canvas>
    `,
    styles: `
        :host { display: block; position: relative; }
        .legend { position: absolute; top: 0.25rem; left: 0.4rem;
                  display: flex; flex-direction: column; gap: 0.1rem;
                  font-family: var(--font-mono); font-size: 0.55rem; color: var(--secondary);
                  text-transform: uppercase; letter-spacing: 0.06em; pointer-events: none;
                  background: rgba(3, 3, 3, 0.75); padding: 0.2rem 0.4rem; border-radius: var(--radius-sm); }
        .legend span { display: flex; align-items: center; gap: 0.2rem; }
        .legend .dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; }
        canvas { display: block; width: 100%; height: 6rem; background: #030303;
                 border: var(--border-width) solid var(--bg-5); border-radius: var(--radius-lg); }
    `,
})
export class RxGraph extends RxElement {
    @state config: Record<string, { label: string; color: string; width?: number }> = {}
    @state series: Record<string, Observable<number[]>> = {}

    canvas!: HTMLCanvasElement
    private ro: ResizeObserver | undefined
    private data = new Map<string, number[]>()
    private subs: Subscription[] = []

    get legendItems$(): Observable<{ label: string; color: string }[]> {
        return this.config$.pipe(map(cfg => Object.values(cfg)))
    }

    override onRender(): void {
        this.ro = new ResizeObserver(() => this.resize())
        this.ro.observe(this.canvas)
        this.resize()
        this.subs.push(this.series$.subscribe(seriesMap => this.subscribeSeries(seriesMap)))
    }

    override onDestroy(): void {
        this.ro?.disconnect()
        this.subs.forEach(s => s.unsubscribe())
    }

    private subscribeSeries(seriesMap: Record<string, Observable<number[]>>): void {
        this.subs.forEach(s => s.unsubscribe())
        this.subs = []
        this.data.clear()
        for (const [name, obs$] of Object.entries(seriesMap)) {
            this.subs.push(obs$.subscribe(points => {
                this.data.set(name, points)
                this.draw()
            }))
        }
    }

    private resize(): void {
        this.canvas.width = this.canvas.clientWidth * devicePixelRatio
        this.canvas.height = this.canvas.clientHeight * devicePixelRatio
        this.draw()
    }

    private draw(): void {
        const ctx = this.canvas.getContext('2d')
        if (!ctx) return
        const w = this.canvas.width
        const h = this.canvas.height
        ctx.clearRect(0, 0, w, h)

        const names = Object.keys(this.config)
        const maxLen = Math.max(0, ...names.map(n => this.data.get(n)?.length ?? 0))
        if (maxLen < 2) return

        const step = w / (maxLen - 1)

        for (const name of names) {
            const cfg = this.config[name]
            if (!cfg) continue
            const pts = this.data.get(name) ?? []
            if (pts.length < 2) continue

            const pad = maxLen - pts.length
            const ceil = Math.max(1, ...pts)

            ctx.beginPath()
            for (let i = 0; i < pts.length; i++) {
                const x = (pad + i) * step
                const y = h - (pts[i]! / ceil) * h
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            }
            ctx.strokeStyle = cfg.color
            ctx.lineWidth = (cfg.width ?? 1) * devicePixelRatio
            ctx.stroke()
        }
    }
}
