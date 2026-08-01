import type { SerializedWorkspace } from './types/serialized-filesystem.types.js'

/**
 * Used by `RuntimeFilesystemService.onInit()` only when storage is empty
 * (a genuinely first run) - not something `app-root.ts` pushes in itself.
 * Seeding has to happen inside the same async flow that constructs
 * `dependencyGraph$`, or a file's machine would read `filesystem.dependencyGraph$`
 * before it exists (the injector doesn't await service `onInit()`, so
 * anything calling `addWorkspace` from outside could race ahead of it).
 */
export const defaultWorkspaces: SerializedWorkspace[] = [
  {
    name: 'heater',
    manifest: {
      name: 'heater',
      concepts: ['heater.ts'],
      metadata: {},
    },
    files: [
      {
        name: 'heater.ts',
        status: 'unanalyzed',
        content: `import { define } from '@yaw-rx/ystate'
import { BehaviorSubject, Subject, filter } from 'rxjs'

// Current room temperature (degrees C)
export const temperature$ = new BehaviorSubject(10)

// External signals to turn the thermostat on and off. Plain Subjects, not
// BehaviorSubjects: a signal is an event, so it must not fire on subscribe.
// (A BehaviorSubject would emit its seed the instant a node subscribes,
// firing turnOn/turnOff unconditionally and looping off->on->power->off.)
export const turnOnSignal = new Subject<void>()
export const turnOffSignal = new Subject<void>()

// Thermostat thresholds as nextable streams so the running UI can tune
// them live; the filters below read the current value at emit time.
export const upperLimitT$ = new BehaviorSubject(26)
export const lowerLimitT$ = new BehaviorSubject(23)

// The thermostat cycles between power (heating) and idle based on room
// temperature. It can be turned on from off, and turned off from either
// power or idle.
export const Heater = define({
  nodes: {
    on: {},
    off: {},
    power: {},
    idle: {},
  },
  edges: {
    turnOn: { from: 'off', to: 'on', on: 'onSignal.next' },
    onToPower: { from: 'on', to: 'power', on: 'belowLowerLimit.next' },
    onToIdle: { from: 'on', to: 'idle', on: 'atOrAboveLowerLimit.next' },
    powerToIdle: { from: 'power', to: 'idle', on: 'aboveUpperLimit.next' },
    idleToPower: { from: 'idle', to: 'power', on: 'belowLowerLimit.next' },
    powerToOff: { from: 'power', to: 'off', on: 'offSignal.next' },
    idleToOff: { from: 'idle', to: 'off', on: 'offSignal.next' },
  },
}).implement({
  onSignal: {
    $: () => turnOnSignal,
    next: () => ({}),
  },
  offSignal: {
    $: () => turnOffSignal,
    next: () => ({}),
  },
  // Fires on entry to 'on' if temperature is already at or above the lower limit
  atOrAboveLowerLimit: {
    $: () => temperature$.pipe(filter(T => T >= lowerLimitT$.value)),
    next: () => ({}),
  },
  // Fires when temperature drops below the lower threshold, triggering heating
  belowLowerLimit: {
    $: () => temperature$.pipe(filter(T => T < lowerLimitT$.value)),
    next: () => ({}),
  },
  // Fires when temperature rises above the upper threshold, stopping heating
  aboveUpperLimit: {
    $: () => temperature$.pipe(filter(T => T > upperLimitT$.value)),
    next: () => ({}),
  },
})`,
      },
      {
        name: 'heater.form',
        status: 'unanalyzed',
        sections: {
          template: `<div class="panel">
  <p class="temp">{{temperatureDisplay}}&deg;C</p>
  <div class="controls">
    <button onclick="turnOnSignal.next()">heater on</button>
    <button onclick="turnOffSignal.next()">heater off</button>
  </div>
  <div class="limits">
    <span>lower {{lower}}&deg;</span>
    <button onclick="lowerLimit(-1)">-</button>
    <button onclick="lowerLimit(1)">+</button>
    <span>upper {{upper}}&deg;</span>
    <button onclick="upperLimit(-1)">-</button>
    <button onclick="upperLimit(1)">+</button>
  </div>
  <rx-graph [config]="graphConfig" [series]="graphSeries"></rx-graph>
</div>`,
          styles: `.panel { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); }
.temp { margin: 0; font-size: 2rem; color: var(--accent); }
.controls, .limits { display: flex; gap: 0.5rem; align-items: center; font-size: 0.8rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.3rem 0.7rem; border-radius: var(--radius-sm); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }`,
        },
        content: `import { timer, combineLatest, scan, map, mergeMap, take, takeUntil, filter, withLatestFrom } from 'rxjs'
import { Heater, temperature$, turnOnSignal, turnOffSignal, upperLimitT$, lowerLimitT$ } from './heater.js'

// --- Simulation Constants ---
const TICK_INTERVAL_MS = 10 // Speed: 10ms per tick
const TIME_SCALE = 1.0       // 1.0 = normal physics, 2.0 = 2x faster physics

// Derived delta-t in seconds passed to the thermal equation per tick
const DT_SECONDS = (TICK_INTERVAL_MS / 1000) * TIME_SCALE

// Re-export the streams the template reads directly:
// (via the $-suffixed aliases) {{lower}}/{{upper}}. The buttons push the
// signals and nudge the limits.
export { temperature$, turnOnSignal, turnOffSignal }
export const lower$ = lowerLimitT$
export const upper$ = upperLimitT$

// Map the temperature to 2dp for display for use in the template like
// {{temperatureDisplay}}
export const temperatureDisplay$ = temperature$.pipe(
  map(t => t.toFixed(2))
)

// Nudging a limit is arithmetic on its current value - script logic, since
// the template's event args are literals/refs, not expressions.
export const lowerLimit = (d: number) => lowerLimitT$.next(lowerLimitT$.value + d)
export const upperLimit = (d: number) => upperLimitT$.next(upperLimitT$.value + d)

// The graph wants a stream of arrays; scan the scalar temperature into a
// rolling window.
export const graphConfig = { 
  temperature: { label: 'temperature', color: '#88aaff' },
  lowerLimitT: { label: 'Lower Limit', color: 'green' },
  upperLimitT: { label: 'Upper Limit', color: 'red' } 
}

// Sample the graph at the same tick interval
const sample$ = timer(0, TICK_INTERVAL_MS)

export const graphSeries = {
  temperature: temperature$.pipe(
    scan((window, t) => [...window, t].slice(-60), [] as number[])
  ),
  upperLimitT: sample$.pipe(
    withLatestFrom(upper$),
    map(([_, upper]) => upper),
    scan((window, val) => [...window, val].slice(-60), [] as number[])
  ),
  lowerLimitT: sample$.pipe(
    withLatestFrom(lower$),
    map(([_, lower]) => lower),
    scan((window, val) => [...window, val].slice(-60), [] as number[])
  )
}

// The thermal model. m*C = thermal mass, k = wall conductance; each tick
// applies dT = (q_heater - k*(roomT - environmentT)) / mC. The heater only
// outputs power in its 'power' node - so the machine's state drives the
// physics, and the resulting temperature crosses thresholds that drive the
// machine: a coupled loop through shared streams, neither side owning it.
const environmentT = 10, wallConductance = 5000, mC = 60 * 1005, heaterPower = 100000

// init() starts (and closes) the machine and returns it by name; the form's
// onDestroy calls .stop() on each. The physics loop rides the same
// lifetime: takeUntil the heater reports 'stopped', so Stop tears it down
// with no leak.
export const init = () => {
  const heater = Heater.close().start('off')
  timer(0, TICK_INTERVAL_MS).pipe(
    mergeMap(() => combineLatest([temperature$, heater.state$]).pipe(take(1))),
    map(([roomT, s]) => {
      const heatLoss = wallConductance * (roomT - environmentT)
      const heaterOutput = s.node === 'power' ? heaterPower : 0
      const deltaT = ((heaterOutput - heatLoss) / mC) * DT_SECONDS
      return roomT + deltaT
    }),
    takeUntil(heater.status$.pipe(filter(x => x === 'stopped'))),
  ).subscribe(t => temperature$.next(t))
  return { heater }
}`,
      },
    ],
  },
  {
    "name": "traffic",
    "manifest": {
      "name": "traffic",
      "concepts": [],
      "metadata": {}
    },
    "files": [
      {
        "name": "traffic-light.ts",
        "content": `import { define } from '@yaw-rx/ystate'
import { BehaviorSubject, Subject, timer, filter, mergeMap, of, delay, NEVER, take } from 'rxjs'

// ---------------------------------------------------------------------------
// External signals
// ---------------------------------------------------------------------------
export const pedestrianRequest = new Subject<void>()
export const emergencySignal   = new Subject<void>()
export const resumeNormal      = new Subject<void>()

// ---------------------------------------------------------------------------
// Shared mutable state (read by timer guards inside the machine)
// ---------------------------------------------------------------------------
export const pedestrianQueued$ = new BehaviorSubject(false)
export const nextDirection$    = new BehaviorSubject<'ns' | 'ew'>('ns')

// Idempotent queue: rapid presses don't stack.
pedestrianRequest.subscribe(() => {
  if (!pedestrianQueued$.value) pedestrianQueued$.next(true)
})

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------
export const TrafficLight = define({
  nodes: {
    allRed: {},
    nsGreen: {},
    nsYellow: {},
    ewGreen: {},
    ewYellow: {},
    pedestrianWalk: {},
    pedestrianClear: {},
    emergencyFlash: {},
  },
  edges: {
    // --- Normal vehicle cycle ----------------------------------------------
    nsGo:       { from: 'allRed',   to: 'nsGreen',  on: 'nsCycleTimer.next' },
    nsCaution:  { from: 'nsGreen',  to: 'nsYellow', on: 'nsTimer.next' },
    nsStop:     { from: 'nsYellow', to: 'allRed',   on: 'nsYellowTimer.next' },

    ewGo:       { from: 'allRed',   to: 'ewGreen',  on: 'ewCycleTimer.next' },
    ewCaution:  { from: 'ewGreen',  to: 'ewYellow', on: 'ewTimer.next' },
    ewStop:     { from: 'ewYellow', to: 'allRed',   on: 'ewYellowTimer.next' },

    // --- Pedestrian phase (wins the race at all-red when queued) -----------
    pedStart:    { from: 'allRed', to: 'pedestrianWalk',  on: 'pedestrianTimer.next' },
    pedWalkDone: { from: 'pedestrianWalk',  to: 'pedestrianClear', on: 'walkTimer.next' },
    pedClearDone:{ from: 'pedestrianClear', to: 'allRed',          on: 'clearTimer.next' },

    // --- Emergency overrides from every normal state -----------------------
    emergencyAllRed:   { from: 'allRed',          to: 'emergencyFlash', on: 'emergency.next' },
    emergencyNsGreen:  { from: 'nsGreen',         to: 'emergencyFlash', on: 'emergency.next' },
    emergencyNsYellow: { from: 'nsYellow',        to: 'emergencyFlash', on: 'emergency.next' },
    emergencyEwGreen:  { from: 'ewGreen',         to: 'emergencyFlash', on: 'emergency.next' },
    emergencyEwYellow: { from: 'ewYellow',        to: 'emergencyFlash', on: 'emergency.next' },
    emergencyPedWalk:  { from: 'pedestrianWalk',  to: 'emergencyFlash', on: 'emergency.next' },
    emergencyPedClear: { from: 'pedestrianClear', to: 'emergencyFlash', on: 'emergency.next' },
    resume:            { from: 'emergencyFlash',  to: 'allRed',         on: 'resume.next' },
  },
}).implement({
  // Only fires when nextDirection === 'ns' and no pedestrian is waiting.
  nsCycleTimer: {
    $: () => timer(1000).pipe(
      mergeMap(() => (nextDirection$.value === 'ns' && !pedestrianQueued$.value) ? of({}) : NEVER),
      take(1),
    ),
    next: () => ({}),
  },
  nsTimer: {
    $: () => timer(4000),
    next: () => ({}),
  },
  nsYellowTimer: {
    $: () => timer(2000),
    next: () => {
      nextDirection$.next('ew')
      return {}
    },
  },

  // Only fires when nextDirection === 'ew' and no pedestrian is waiting.
  ewCycleTimer: {
    $: () => timer(1000).pipe(
      mergeMap(() => (nextDirection$.value === 'ew' && !pedestrianQueued$.value) ? of({}) : NEVER),
      take(1),
    ),
    next: () => ({}),
  },
  ewTimer: {
    $: () => timer(4000),
    next: () => ({}),
  },
  ewYellowTimer: {
    $: () => timer(2000),
    next: () => {
      nextDirection$.next('ns')
      return {}
    },
  },

  // Fires 400 ms after a pedestrian is queued while in all-red, beating the
  // 1000 ms vehicle cycle timers. If the request arrives too late in the
  // all-red window, it rides over to the next cycle.
  pedestrianTimer: {
    $: () => pedestrianQueued$.pipe(filter(v => v), delay(400), take(1)),
    next: () => {
      pedestrianQueued$.next(false)
      return {}
    },
  },
  walkTimer: {
    $: () => timer(8000),
    next: () => ({}),
  },
  clearTimer: {
    $: () => timer(2000),
    next: () => ({}),
  },

  emergency: {
    $: () => emergencySignal,
    next: () => ({}),
  },
  resume: {
    $: () => resumeNormal,
    next: () => ({}),
  },
})`,
        "status": "unanalyzed"
      },
      {
        "name": "traffic-light.form",
        "content": `import { TrafficLight, pedestrianRequest, emergencySignal, resumeNormal, pedestrianQueued$ } from './traffic-light.js'
import { map } from 'rxjs'

export { pedestrianRequest, emergencySignal, resumeNormal }

const light = TrafficLight.close().start('allRed')
export { light }

const state$ = light.state$

export const stateName$ = state$.pipe(map(s => s.node))

// NS lights: red during allRed, ewGreen, ewYellow, pedestrian phases, emergency
export const nsRedOn$    = state$.pipe(map(s => ['allRed','ewGreen','ewYellow','pedestrianWalk','pedestrianClear','emergencyFlash'].includes(s.node)))
export const nsYellowOn$ = state$.pipe(map(s => s.node === 'nsYellow'))
export const nsGreenOn$  = state$.pipe(map(s => s.node === 'nsGreen'))

// EW lights: red during allRed, nsGreen, nsYellow, pedestrian phases, emergency
export const ewRedOn$    = state$.pipe(map(s => ['allRed','nsGreen','nsYellow','pedestrianWalk','pedestrianClear','emergencyFlash'].includes(s.node)))
export const ewYellowOn$ = state$.pipe(map(s => s.node === 'ewYellow'))
export const ewGreenOn$  = state$.pipe(map(s => s.node === 'ewGreen'))

export const walkOn$     = state$.pipe(map(s => s.node === 'pedestrianWalk'))
export const dontWalkOn$ = state$.pipe(map(s => s.node !== 'pedestrianWalk'))

export const pedQueued$  = pedestrianQueued$
export const emergencyOn$ = state$.pipe(map(s => s.node === 'emergencyFlash'))

export const init = () => ({ light })`,
        "status": "unanalyzed",
        "sections": {
          "template": `<div class="intersection">
  <svg viewBox="140 140 320 320" class="diagram">
    <defs>
      <filter id="glow-red"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="glow-yellow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="glow-green"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>

    <!-- Background -->
    <rect width="600" height="600" fill="#0a0a0a"/>

    <!-- Roads (80px wide, centred on 300) -->
    <rect x="0" y="260" width="600" height="80" fill="#252525"/>
    <rect x="260" y="0" width="80" height="600" fill="#252525"/>
    <rect x="260" y="260" width="80" height="80" fill="#333"/>

    <!-- Centre lane markings -->
    <line x1="0" y1="300" x2="600" y2="300" stroke="#555" stroke-width="2" stroke-dasharray="14 14"/>
    <line x1="300" y1="0" x2="300" y2="600" stroke="#555" stroke-width="2" stroke-dasharray="14 14"/>

    <!-- Crosswalks: dotted border + white stripes -->
    <!-- North -->
    <rect x="260" y="240" width="80" height="20" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="270" y1="240" x2="270" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="283" y1="240" x2="283" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="296" y1="240" x2="296" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="309" y1="240" x2="309" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="322" y1="240" x2="322" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="335" y1="240" x2="335" y2="260" stroke="#fff" stroke-width="3" opacity="0.9"/>

    <!-- South -->
    <rect x="260" y="340" width="80" height="20" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="270" y1="340" x2="270" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="283" y1="340" x2="283" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="296" y1="340" x2="296" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="309" y1="340" x2="309" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="322" y1="340" x2="322" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="335" y1="340" x2="335" y2="360" stroke="#fff" stroke-width="3" opacity="0.9"/>

    <!-- West -->
    <rect x="240" y="260" width="20" height="80" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="240" y1="270" x2="260" y2="270" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="240" y1="283" x2="260" y2="283" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="240" y1="296" x2="260" y2="296" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="240" y1="309" x2="260" y2="309" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="240" y1="322" x2="260" y2="322" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="240" y1="335" x2="260" y2="335" stroke="#fff" stroke-width="3" opacity="0.9"/>

    <!-- East -->
    <rect x="340" y="260" width="20" height="80" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="340" y1="270" x2="360" y2="270" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="340" y1="283" x2="360" y2="283" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="340" y1="296" x2="360" y2="296" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="340" y1="309" x2="360" y2="309" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="340" y1="322" x2="360" y2="322" stroke="#fff" stroke-width="3" opacity="0.9"/>
    <line x1="340" y1="335" x2="360" y2="335" stroke="#fff" stroke-width="3" opacity="0.9"/>

    <!-- North–South traffic light — North approach (facing southbound traffic) -->
    <!-- centred on x=300, positioned above the north crosswalk -->
    <g transform="translate(289, 165)">
      <text x="11" y="-10" text-anchor="middle" fill="#bbb" font-size="10" font-family="var(--font-mono)">North–South</text>
      <rect x="0" y="0" width="22" height="60" rx="4" fill="#111" stroke="#444" stroke-width="1.5"/>
      <circle cx="11" cy="14" r="7" fill="#300"/>
      <g rx-if="nsRedOn"><circle cx="11" cy="14" r="7" fill="#f33" filter="url(#glow-red)"/></g>
      <circle cx="11" cy="30" r="7" fill="#320"/>
      <g rx-if="nsYellowOn"><circle cx="11" cy="30" r="7" fill="#fc3" filter="url(#glow-yellow)"/></g>
      <circle cx="11" cy="46" r="7" fill="#020"/>
      <g rx-if="nsGreenOn"><circle cx="11" cy="46" r="7" fill="#3f3" filter="url(#glow-green)"/></g>
    </g>

    <!-- North–South traffic light — South approach (facing northbound traffic) -->
    <g transform="translate(289, 375)">
      <text x="11" y="72" text-anchor="middle" fill="#bbb" font-size="10" font-family="var(--font-mono)">North–South</text>
      <rect x="0" y="0" width="22" height="60" rx="4" fill="#111" stroke="#444" stroke-width="1.5"/>
      <circle cx="11" cy="14" r="7" fill="#300"/>
      <g rx-if="nsRedOn"><circle cx="11" cy="14" r="7" fill="#f33" filter="url(#glow-red)"/></g>
      <circle cx="11" cy="30" r="7" fill="#320"/>
      <g rx-if="nsYellowOn"><circle cx="11" cy="30" r="7" fill="#fc3" filter="url(#glow-yellow)"/></g>
      <circle cx="11" cy="46" r="7" fill="#020"/>
      <g rx-if="nsGreenOn"><circle cx="11" cy="46" r="7" fill="#3f3" filter="url(#glow-green)"/></g>
    </g>

    <!-- East–West traffic light — West approach (facing eastbound traffic) -->
    <!-- centred on y=300, positioned left of the west crosswalk -->
    <g transform="translate(165, 270)">
      <text x="11" y="-10" text-anchor="middle" fill="#bbb" font-size="10" font-family="var(--font-mono)">East–West</text>
      <rect x="0" y="0" width="22" height="60" rx="4" fill="#111" stroke="#444" stroke-width="1.5"/>
      <circle cx="11" cy="14" r="7" fill="#300"/>
      <g rx-if="ewRedOn"><circle cx="11" cy="14" r="7" fill="#f33" filter="url(#glow-red)"/></g>
      <circle cx="11" cy="30" r="7" fill="#320"/>
      <g rx-if="ewYellowOn"><circle cx="11" cy="30" r="7" fill="#fc3" filter="url(#glow-yellow)"/></g>
      <circle cx="11" cy="46" r="7" fill="#020"/>
      <g rx-if="ewGreenOn"><circle cx="11" cy="46" r="7" fill="#3f3" filter="url(#glow-green)"/></g>
    </g>

    <!-- East–West traffic light — East approach (facing westbound traffic) -->
    <g transform="translate(413, 270)">
      <text x="11" y="-10" text-anchor="middle" fill="#bbb" font-size="10" font-family="var(--font-mono)">East–West</text>
      <rect x="0" y="0" width="22" height="60" rx="4" fill="#111" stroke="#444" stroke-width="1.5"/>
      <circle cx="11" cy="14" r="7" fill="#300"/>
      <g rx-if="ewRedOn"><circle cx="11" cy="14" r="7" fill="#f33" filter="url(#glow-red)"/></g>
      <circle cx="11" cy="30" r="7" fill="#320"/>
      <g rx-if="ewYellowOn"><circle cx="11" cy="30" r="7" fill="#fc3" filter="url(#glow-yellow)"/></g>
      <circle cx="11" cy="46" r="7" fill="#020"/>
      <g rx-if="ewGreenOn"><circle cx="11" cy="46" r="7" fill="#3f3" filter="url(#glow-green)"/></g>
    </g>

    <!-- Pedestrian signals — 4 corners, same width as the crosswalk strips (20px) -->
    <!-- NW corner -->
    <g transform="translate(240, 240)">
      <rect x="0" y="0" width="20" height="20" rx="2" fill="#111" stroke="#444" stroke-width="1"/>
      <g rx-if="walkOn"><text x="10" y="14" text-anchor="middle" fill="#3f3" font-size="9" font-weight="bold" font-family="var(--font-mono)">W</text></g>
      <g rx-if="dontWalkOn"><text x="10" y="14" text-anchor="middle" fill="#f33" font-size="11" font-weight="bold" font-family="var(--font-mono)">✕</text></g>
    </g>
    <!-- NE corner -->
    <g transform="translate(340, 240)">
      <rect x="0" y="0" width="20" height="20" rx="2" fill="#111" stroke="#444" stroke-width="1"/>
      <g rx-if="walkOn"><text x="10" y="14" text-anchor="middle" fill="#3f3" font-size="9" font-weight="bold" font-family="var(--font-mono)">W</text></g>
      <g rx-if="dontWalkOn"><text x="10" y="14" text-anchor="middle" fill="#f33" font-size="11" font-weight="bold" font-family="var(--font-mono)">✕</text></g>
    </g>
    <!-- SW corner -->
    <g transform="translate(240, 340)">
      <rect x="0" y="0" width="20" height="20" rx="2" fill="#111" stroke="#444" stroke-width="1"/>
      <g rx-if="walkOn"><text x="10" y="14" text-anchor="middle" fill="#3f3" font-size="9" font-weight="bold" font-family="var(--font-mono)">W</text></g>
      <g rx-if="dontWalkOn"><text x="10" y="14" text-anchor="middle" fill="#f33" font-size="11" font-weight="bold" font-family="var(--font-mono)">✕</text></g>
    </g>
    <!-- SE corner -->
    <g transform="translate(340, 340)">
      <rect x="0" y="0" width="20" height="20" rx="2" fill="#111" stroke="#444" stroke-width="1"/>
      <g rx-if="walkOn"><text x="10" y="14" text-anchor="middle" fill="#3f3" font-size="9" font-weight="bold" font-family="var(--font-mono)">W</text></g>
      <g rx-if="dontWalkOn"><text x="10" y="14" text-anchor="middle" fill="#f33" font-size="11" font-weight="bold" font-family="var(--font-mono)">✕</text></g>
    </g>

    <!-- Central pedestrian signal (dead middle, 36×44) -->
    <g transform="translate(282, 278)">
      <rect x="0" y="0" width="36" height="44" rx="3" fill="#111" stroke="#444" stroke-width="1.5"/>
      <g rx-if="walkOn">
        <circle cx="18" cy="9" r="4" fill="#3f3"/>
        <line x1="18" y1="13" x2="18" y2="22" stroke="#3f3" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="18" y1="16" x2="12" y2="13" stroke="#3f3" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="16" x2="24" y2="11" stroke="#3f3" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="22" x2="13" y2="32" stroke="#3f3" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="22" x2="23" y2="30" stroke="#3f3" stroke-width="2" stroke-linecap="round"/>
      </g>
      <g rx-if="dontWalkOn">
        <circle cx="18" cy="9" r="4" fill="#f33"/>
        <line x1="18" y1="13" x2="18" y2="22" stroke="#f33" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="18" y1="16" x2="11" y2="16" stroke="#f33" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="16" x2="25" y2="16" stroke="#f33" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="22" x2="14" y2="34" stroke="#f33" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="22" x2="22" y2="34" stroke="#f33" stroke-width="2" stroke-linecap="round"/>
      </g>
    </g>
  </svg>

  <div class="status">
    <p>State: <span class="badge">{{stateName}}</span></p>
    <p class="queued" rx-if="pedQueued">🚶 Pedestrian queued</p>
    <p class="emergency" rx-if="emergencyOn">🚨 EMERGENCY OVERRIDE</p>
  </div>

  <div class="controls">
    <button onclick="pedestrianRequest.next()">Request Walk</button>
    <button onclick="emergencySignal.next()">Emergency</button>
    <button onclick="resumeNormal.next()">Resume</button>
  </div>
</div>`,
          "styles": `.intersection { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); max-width: 560px; }
.diagram { width: 100%; height: auto; border-radius: var(--radius-sm); background: #0a0a0a; }

.status { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
.badge { background: var(--bg-4); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); font-size: 0.8rem; text-transform: uppercase; }
.queued { color: #ffcc44; margin: 0; }
.emergency { color: #ff4444; margin: 0; animation: pulse 1s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.controls { display: flex; gap: 0.5rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.85rem; }
button:hover { border-color: var(--accent); color: var(--accent); }`
        }
      }
    ]
  },
  {
    name: 'checkout',
    manifest: {
      name: 'checkout',
      concepts: ['auth.ts', 'payment.ts', 'basket.ts'],
      metadata: {},
    },
    files: [
      {
        name: 'auth.ts',
        status: 'unanalyzed',
        content: `import { define } from '@yaw-rx/ystate'
import { Subject, timer, mergeMap, throwError, of } from 'rxjs'

const loginErrors = ['auth server unreachable', 'invalid credentials', 'account locked', 'rate limited']
const simulateLogin = () => timer(2000).pipe(
  mergeMap(() => Math.random() > 0.2
    ? of({ token: \`tok_\${Date.now()}\` })
    : throwError(() => new Error(loginErrors[Math.floor(Math.random() * loginErrors.length)]))
  )
)

// Signals pushed by the UI forms
export const loginRequest = new Subject<void>()
export const logoutRequest = new Subject<void>()
export const retryRequest = new Subject<void>()

export const Auth = define({
  nodes: {
    loggedOut: { since: 0 },
    authenticated: { token: '', authenticatedAt: 0 },
    loginFailed: { reason: '' },
  },
  edges: {
    login: { from: 'loggedOut', to: 'authenticated', on: 'authenticate.next' },
    loginError: { from: 'loggedOut', to: 'loginFailed', on: 'authenticate.error' },
    retry: { from: 'loginFailed', to: 'loggedOut', on: 'retryLogin.next' },
    expire: { from: 'authenticated', to: 'loggedOut', on: 'sessionExpire.next' },
    logout: { from: 'authenticated', to: 'loggedOut', on: 'logoutSignal.next' },
  },
}).implement({
  authenticate: {
    $: () => loginRequest.pipe(mergeMap(() => simulateLogin())),
    next: (result) => ({ token: result.token, authenticatedAt: Date.now() }),
    error: (err) => ({ reason: String(err) }),
  },
  retryLogin: {
    $: () => retryRequest.pipe(mergeMap(() => timer(800))),
    next: () => ({ since: Date.now() }),
  },
  sessionExpire: {
    $: () => timer(120000),
    next: (_result, _dest, source) => ({ since: source.authenticatedAt }),
  },
  logoutSignal: {
    $: () => logoutRequest,
    next: () => ({ since: Date.now() }),
  },
})`,
      },
      {
        name: 'payment.ts',
        status: 'unanalyzed',
        content: `import { define } from '@yaw-rx/ystate'
import { Subject, timer, mergeMap, throwError, of, EMPTY, withLatestFrom, map } from 'rxjs'
import { Auth } from './auth.js'

const simulatePayment = () => timer(3000).pipe(
  mergeMap(() => {
    const r = Math.random()
    if (r > 0.3) return of({ txId: \`tx_\${Date.now()}\` })
    if (r > 0.1) return throwError(() => new Error('card declined'))
    return EMPTY
  })
)

// The card details the "Pay" button submits - the payment request carries the
// entered card, not just a bare signal.
export interface Card { number: string; expiry: string; cvc: string }
export const payRequest = new Subject<Card>()
export const resetRequest = new Subject<void>()
export const Payment = define({
  nodes: {
    checkout: {},
    notLoggedIn: {},
    // orderId/card are set on pay and cleared to null on reset - both empty
    // until a card is actually submitted.
    processing: { orderId: null as string | null, card: null as Card | null },
    // approved is terminal: once paid we're done. No reset off it - stop and
    // start the machine for another run.
    approved: { confirmedAt: 0, txId: '' },
    declined: { reason: '' },
    stalled: { orderId: null as string | null },
  },
  deps: {
    auth: Auth,
  },
  edges: {
    pay: { from: 'checkout', to: 'processing', on: 'pay.next' },
    payBlocked: { from: 'checkout', to: 'notLoggedIn', on: 'pay.error' },
    dismiss: { from: 'notLoggedIn', to: 'checkout', on: 'dismiss.complete' },
    approve: { from: 'processing', to: 'approved', on: 'process.next' },
    decline: { from: 'processing', to: 'declined', on: 'process.error' },
    stall: { from: 'processing', to: 'stalled', on: 'process.complete' },
    resetDeclined: { from: 'declined', to: 'processing', on: 'reset.next' },
    resetStalled: { from: 'stalled', to: 'processing', on: 'reset.next' },
  },
}).implement({
  // Gate: pay only proceeds when auth is 'authenticated'; otherwise it errors,
  // routing checkout -> notLoggedIn, which bounces back to checkout shortly.
  pay: {
    $: (deps) => payRequest.pipe(
      withLatestFrom(deps.auth.state$),
      map(([card, auth]) => {
        if (auth.node !== 'authenticated') throw new Error('not logged in')
        return card
      })
    ),
    next: (card: Card) => ({ orderId: \`ORD-\${Date.now()}\`, card }),
    error: () => ({}),
  },
  dismiss: {
    $: () => EMPTY,
    next: () => ({}),
    complete: () => ({}),
  },
  process: {
    $: () => simulatePayment(),
    next: (result) => ({ confirmedAt: Date.now(), txId: result.txId }),
    error: (err) => ({ reason: String(err) }),
    complete: (_result, _dest, source) => ({ orderId: source.orderId }),
  },
  reset: {
    $: () => resetRequest,
    next: () => ({ orderId: null, card: null }),
  },
})`,
      },
      {
        name: 'basket.ts',
        status: 'unanalyzed',
        content: `import { define } from '@yaw-rx/ystate'
import { Subject, timer, mergeMap, throwError, of } from 'rxjs'
import { Auth } from './auth.js'
import { Payment } from './payment.js'

const simulateAddItem = () => timer(500).pipe(
  mergeMap(() => Math.random() > 0.1
    ? of({ itemId: \`item-\${Date.now()}\` })
    : throwError(() => new Error('item out of stock'))
  )
)

const simulateItemConfirmation = () => timer(1000)

export const addItemRequest = new Subject<void>()
export const checkoutRequest = new Subject<void>()

export const Basket = define({
  nodes: {
    empty: {},
    addingItem: { itemId: '' },
    hasItems: { items: [] as string[] },
    addFailed: { error: '', items: [] as string[] },
  },
  deps: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    // addItem's $ runs the stock check, so its error edge must leave every
    // node that listens for addItem (empty/hasItems/addFailed) - that's where
    // the $ is subscribed and can throw 'out of stock'. Routing the error off
    // 'addingItem' (which listens for itemAdded, not addItem) left the error
    // unhandled and crashed the machine.
    addFromEmpty: { from: 'empty', to: 'addingItem', on: 'addItem.next' },
    addFromHasItems: { from: 'hasItems', to: 'addingItem', on: 'addItem.next' },
    retryAdd: { from: 'addFailed', to: 'addingItem', on: 'addItem.next' },
    addErrorFromEmpty: { from: 'empty', to: 'addFailed', on: 'addItem.error' },
    addErrorFromHasItems: { from: 'hasItems', to: 'addFailed', on: 'addItem.error' },
    addErrorFromFailed: { from: 'addFailed', to: 'addFailed', on: 'addItem.error' },
    added: { from: 'addingItem', to: 'hasItems', on: 'itemAdded.next' },
    checkout: { from: 'hasItems', to: refs.payment.nodes.checkout, on: 'checkout.next' },
  }),
}).implement({
  addItem: {
    $: () => addItemRequest.pipe(mergeMap(() => simulateAddItem())),
    next: (result, _dest, _source, edge) => ({ itemId: \`\${result.itemId}-via-\${edge}\` }),
    error: (err, dest, _source, edge) => ({ error: \`\${edge}: \${String(err)}\`, items: dest.items }),
  },
  itemAdded: {
    $: () => simulateItemConfirmation(),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  },
  // Ungated: anyone can proceed to the checkout screen. The auth gate lives on
  // payment's pay edge (checkout -> processing), so a logged-out user reaches
  // checkout and is bounced to notLoggedIn when they try to pay.
  checkout: {
    $: () => checkoutRequest,
    next: () => ({}),
  },
})`,
      },
      {
        name: 'auth.form',
        status: 'unanalyzed',
        sections: {
          template: `<div class="auth-panel">
  <h3>Authentication</h3>
  <p class="state">State: <span class="badge">{{authState}}</span></p>
  <p class="token">Token: <code>{{authToken}}</code></p> <!-- SHOULD BE RX IF GUARDED -->
  <p class="error">Error: {{authError}}</p>
  <div class="controls">
    <button onclick="loginRequest.next()">Login</button>
    <button onclick="logoutRequest.next()">Logout</button>
    <button onclick="retryRequest.next()">Retry</button>
  </div>
</div>`,
          styles: `.auth-panel { display: flex; flex-direction: column; gap: 0.75rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); max-width: 420px; }
h3 { margin: 0 0 0.5rem; color: var(--accent); }
p { margin: 0.25rem 0; font-size: 0.9rem; }
.badge { background: var(--bg-4); padding: 0.2rem 0.6rem; border-radius: var(--radius-sm); font-size: 0.8rem; text-transform: uppercase; }
.token code { background: var(--bg-4); padding: 0.2rem 0.4rem; border-radius: var(--radius-sm); font-size: 0.75rem; word-break: break-all; }
.error { color: #ff8888; min-height: 1.2em; }
.controls { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }`,
        },
        content: `import { Auth, loginRequest, logoutRequest, retryRequest } from './auth.js'
import { map } from 'rxjs'

export { loginRequest, logoutRequest, retryRequest }

const auth = Auth.close().start('loggedOut')

export { auth };

export const authState$ = auth.state$.pipe(map(s => s.node))
export const authToken$ = auth.state$.pipe(map(s => s.node === 'authenticated' ? s.data.token : ''))
export const authError$ = auth.state$.pipe(map(s => s.node === 'loginFailed' ? s.data.reason : ''))
export const init = () => {
  return { auth }
}`,
      },
      {
        name: 'basket.form',
        status: 'unanalyzed',
        sections: {
          template: `<div class="checkout-panel">
  <div class="section auth-section"> <!-- REMOVE THIS ITS ON THE OTHER FORM -->
    <h4>Auth</h4>
    <p>State: <span class="badge">{{authState}}</span></p>
    <div class="controls">
      <button onclick="loginRequest.next()">Login</button>
      <button onclick="logoutRequest.next()">Logout</button>
    </div>
  </div>

  <div class="section basket-section">
    <h4>Basket</h4>
    <p>State: <span class="badge">{{basketState}}</span></p>
    <div class="items">
      <div rx-if="showItems">
        <span class="items-head">Items ({{itemCount}})</span>
        <ul class="item-list" rx-for="item of basketItems">
          <li>{{item}}</li>
        </ul>
      </div>
      <span rx-if="showItemId">Adding item: {{addingItemId}}</span>
    </div>
    <p class="error">Error: {{basketError}}</p>
    <div class="controls">
      <button onclick="addItemRequest.next()">Add Item</button>
      <button onclick="checkoutRequest.next()">Checkout</button>
    </div>
  </div>

  <div class="section payment-section">
    <h4>Payment</h4>
    <p>State: <span class="badge">{{paymentState}}</span></p>
    <p>TX: <code>{{paymentTxId}}</code></p>
    <p class="error">Reason: {{paymentReason}}</p>
  </div>
</div>`,
          styles: `.checkout-panel { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); max-width: 520px; }
.section { border: 1px solid var(--border); padding: 1rem; border-radius: var(--radius-sm); }
h4 { margin: 0 0 0.5rem; color: var(--accent); }
p { margin: 0.3rem 0; font-size: 0.9rem; }
.badge { background: var(--bg-4); padding: 0.15rem 0.5rem; border-radius: var(--radius-sm); font-size: 0.8rem; text-transform: uppercase; }
.items { font-size: 0.8rem; color: var(--text-secondary); word-break: break-all; min-height: 1.2em; }
.items-head { color: var(--dim); }
.item-list { margin: 0.35rem 0 0; padding-left: 1.25rem; list-style: disc; }
.item-list li { margin: 0.15rem 0; }
.error { color: #ff8888; min-height: 1.2em; }
.controls { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.35rem 0.7rem; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.85rem; }
button:hover { border-color: var(--accent); color: var(--accent); }
code { background: var(--bg-4); padding: 0.15rem 0.3rem; border-radius: var(--radius-sm); font-size: 0.75rem; }`,
        },
        content: `import { Basket, addItemRequest, checkoutRequest } from './basket.js'
import { loginRequest, logoutRequest } from './auth.js'
import { auth } from './auth.form.js'
import { map } from 'rxjs'

// Buttons drive the auth signals (shared instance) and the basket signals.
export { addItemRequest, checkoutRequest, loginRequest, logoutRequest }

// auth is a DISJOINT dep: a standalone instance owned by auth.form, passed in
// and only observed here (Basket never stops it). payment is UNIONED into this
// super-graph - basket's checkout edge targets payment.processing - so it's
// built from the blueprint at closure and lives inside \`basket\`. It is not
// passed in and not separately owned.
const basket = Basket.close().start('empty', { auth })
export { basket }

// The payment slice of the super-graph: a prefix-filtered projection of
// basket's own state, so its nodes read as 'payment.*'.
const payment = basket.runningMachines['payment']

export const authState$ = auth.state$.pipe(map(s => s.node))
export const basketState$ = basket.state$.pipe(map(s => s.node))
// The basket panel shows whatever the CURRENT node actually carries: nodes
// with an items list (hasItems/addFailed) show the list + count; addingItem
// carries only the itemId in flight, so it shows that. rx-if picks the block.
export const showItems$ = basket.state$.pipe(map(s => s.node === 'hasItems' || s.node === 'addFailed'))
export const showItemId$ = basket.state$.pipe(map(s => s.node === 'addingItem'))
export const basketItems$ = basket.state$.pipe(map(s => s.node === 'hasItems' || s.node === 'addFailed' ? (s.data.items as string[]) : []))
export const itemCount$ = basket.state$.pipe(map(s => s.node === 'hasItems' || s.node === 'addFailed' ? (s.data.items as string[]).length : 0))
export const addingItemId$ = basket.state$.pipe(map(s => s.node === 'addingItem' ? String(s.data.itemId ?? '') : ''))
export const basketError$ = basket.state$.pipe(map(s => s.node === 'addFailed' ? String(s.data.error ?? '') : ''))
export const paymentState$ = payment.state$.pipe(map(s => s.node.replace(/^payment\\./, '')))
export const paymentTxId$ = payment.state$.pipe(map(s => s.node === 'payment.approved' ? String(s.data.txId ?? '') : ''))
export const paymentReason$ = payment.state$.pipe(map(s => s.node === 'payment.declined' ? String(s.data.reason ?? '') : ''))

// Owns only the basket super-graph; init returns it (auth is owned by
// auth.form, payment lives inside basket). Stop stops it once.
export const init = () => ({ basket })`,
      },
      {
        name: 'payment.form',
        status: 'unanalyzed',
        sections: {
          template: `<div class="payment-panel">
  <h3>Payment Gateway</h3>
  <p>State: <span class="badge">{{paymentState}}</span></p>
  <p>Order: {{paymentOrderId}}</p>
  <p>Card: {{paymentCard}}</p>
  <p>TX: <code>{{paymentTxId}}</code></p>
  <p class="error">Reason: {{paymentReason}}</p>
  <div class="card">
    <label>Card number <input class="card-input" value="4242 4242 4242 4242" oninput="onCardNumber($event)" /></label>
    <div class="card-row">
      <label>Expiry <input class="card-input" value="12 / 29" oninput="onCardExpiry($event)" /></label>
      <label>CVC <input class="card-input" value="123" oninput="onCardCvc($event)" /></label>
    </div>
  </div>
  <div class="controls">
    <button onclick="pay()">Pay</button>
    <button onclick="resetRequest.next()">Run Again</button>
  </div>
</div>`,
          styles: `.payment-panel { display: flex; flex-direction: column; gap: 0.75rem; padding: 1.5rem; font-family: var(--font-mono); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); max-width: 420px; }
h3 { margin: 0 0 0.5rem; color: var(--accent); }
p { margin: 0.3rem 0; font-size: 0.9rem; }
.badge { background: var(--bg-4); padding: 0.2rem 0.6rem; border-radius: var(--radius-sm); font-size: 0.85rem; text-transform: uppercase; }
.error { color: #ff8888; min-height: 1.2em; }
.card { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; }
.card label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.65rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.card-row { display: flex; gap: 0.5rem; }
.card-input { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); font-size: 0.85rem; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); }
.card-input:focus { outline: none; border-color: var(--accent); }
.controls { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
button { background: var(--bg-4); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
code { background: var(--bg-4); padding: 0.2rem 0.4rem; border-radius: var(--radius-sm); font-size: 0.75rem; word-break: break-all; }`,
        },
        content: `import { basket } from './basket.form.js'
import { payRequest, resetRequest, type Card } from './payment.js'
import { BehaviorSubject, map } from 'rxjs'

// Card fields captured from the inputs. "Pay" submits them as the payment
// request payload (checkout -> processing, gated by auth); "Run Again" resets a
// declined/stalled payment. Both drive transitions wired inside the super-graph.
const cardNumber$ = new BehaviorSubject('4242 4242 4242 4242')
const cardExpiry$ = new BehaviorSubject('12 / 29')
const cardCvc$ = new BehaviorSubject('123')
export const onCardNumber = (e: Event) => cardNumber$.next((e.target as HTMLInputElement).value)
export const onCardExpiry = (e: Event) => cardExpiry$.next((e.target as HTMLInputElement).value)
export const onCardCvc = (e: Event) => cardCvc$.next((e.target as HTMLInputElement).value)
export const pay = () => payRequest.next({ number: cardNumber$.value, expiry: cardExpiry$.value, cvc: cardCvc$.value })
export { resetRequest }

// Payment has no graph of its own: it's UNIONED into the basket super-graph
// (basket's checkout edge targets payment.checkout). So this panel is a pure
// view - it reads payment's slice out of the running basket imported from
// basket.form, where the nodes are namespace-prefixed 'payment.*'. It owns no
// machine, so there is no init().
const payment = basket.runningMachines['payment']

export const paymentState$ = payment.state$.pipe(map(s => s.node.replace(/^payment\\./, '')))
export const paymentTxId$ = payment.state$.pipe(map(s => s.node === 'payment.approved' ? String(s.data.txId ?? '') : ''))
export const paymentReason$ = payment.state$.pipe(map(s => s.node === 'payment.declined' ? String(s.data.reason ?? '') : ''))
export const paymentOrderId$ = payment.state$.pipe(map(s => s.node === 'payment.processing' || s.node === 'payment.stalled' ? String(s.data.orderId ?? '') : ''))
// The card that was submitted, shown while processing - proof it rode the pay
// request through to the node.
export const paymentCard$ = payment.state$.pipe(map(s => {
  const card = s.node === 'payment.processing' ? s.data.card as Card | null : null
  return card ? 'ending ' + (card.number.split(' ').pop() ?? '') : ''
}))`,
      },
    ],
  }
]

