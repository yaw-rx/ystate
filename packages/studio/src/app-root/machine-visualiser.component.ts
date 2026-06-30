import { Component, RxElement } from "@yaw-rx/core";
import { define } from '@yaw-rx/ystate';
import { BehaviorSubject, combineLatest, filter, map, mergeMap, take, timer } from "rxjs";

// This models the temperature of a room with a thermostat controlled heater.
//
// q = mC * dT
// dT = q / mC
//
// To compute how much the temperature changes per unit time we need to know:
//   - The ambient temperature outside the room
//   - The thermal transfer properties of the walls (how fast heat leaks as a function of dT)
//   - The mass and specific heat capacity of the air in the room
//   - The heat output of the heater
//
// Heat leaving the room = k * (roomT - environmentT)
// Net rate of change: dT = (q_heater - k * (roomT - environmentT)) / mC

// Current room temperature (degrees C)
const temperature$ = new BehaviorSubject(10);

// Ambient temperature outside the room (degrees C)
const environmentT = 10;

// Thermal conductance of the walls - heat loss per degree of difference (W/K)
const wallConductance = 50; // W/K

// m = mass of air in the room (kg) - assuming ~50m3 at 1.2 kg/m3
const m = 60; // kg

// C = specific heat capacity of air (J/kg/K)
const C = 1005; // J/kg/K

// mC = thermal mass of the room, determines how much energy is needed to change temperature
const mC = m * C;

// q = heat output of the heater when running (W)
const heaterPower = 1000; // W

const upperLimitT = 26;
const lowerLimitT = 23;

// External signals to turn the thermostat on and off
const turnOnSubject = new BehaviorSubject(false);
const turnOffSubject = new BehaviorSubject(false);

const turnOnSignal = turnOnSubject.pipe(filter((signal) => signal === true));
const turnOffSignal = turnOffSubject.pipe(filter((signal) => signal === true));

// The thermostat cycles between power (heating) and idle based on room temperature.
// It can be turned on from off, and turned off from either power or idle.
const Heater = define({
    nodes: {
        on: {},
        off: {},
        power: {},
        idle: {}
    },
    edges: {
        turnOn: {from: 'off', to: 'on', on: 'onSignal.next'},

        onToPower: {from: 'on', to: 'power', on: 'belowLowerLimit.next'},
        onToIdle: {from: 'on', to: 'idle', on: 'atOrAboveLowerLimit.next'},

        powerToIdle: {from: 'power', to: 'idle', on: 'aboveUpperLimit.next'},
        idleToPower: {from: 'idle', to: 'power', on: 'belowLowerLimit.next'},

        powerToOff: {from: 'power', to: 'off', on: 'offSignal.next'},
        idleToOff: {from: 'idle', to: 'off', on: 'offSignal.next'},
    }
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
        $: () => temperature$.pipe(filter((T) => T >= lowerLimitT)),
        next: () => ({}),
    },
    // Fires when temperature drops below the lower threshold, triggering heating
    belowLowerLimit: {
        $: () => temperature$.pipe(filter((T) => T < lowerLimitT)),
        next: () => ({}),
    },
    // Fires when temperature rises above the upper threshold, stopping heating
    aboveUpperLimit: {
        $: () => temperature$.pipe(filter((T) => T > upperLimitT)),
        next: () => ({}),
    },
});

const heater = Heater.close().start('on');
const heaterState$ = heater.state$;

// Physics simulation outside the machine. The heater influences the
// environment (heat output raises temperature$) and the environment
// influences the heater (temperature$ crosses thresholds that trigger
// transitions between power and idle). Neither side owns the loop;
// they are coupled through shared observables.
// Each tick applies dT = (q_heater - k * (roomT - environmentT)) / mC
timer(0, 1000).pipe(
    mergeMap(() => combineLatest([temperature$, heaterState$]).pipe(take(1))),
    map(([roomT, toasterState]) => {
        const heatLoss = wallConductance * (roomT - environmentT); // W
        const heaterOutput = toasterState.node === 'power' ? heaterPower : 0; // W
        return roomT + (heaterOutput - heatLoss) / mC;
    })
).subscribe(newT => temperature$.next(newT))

@Component({
    selector: 'machineVisualiser',
    template: '',
})
class MachineVisualiser extends RxElement {

}
