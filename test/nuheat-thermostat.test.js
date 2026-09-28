"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test = require("node:test");
const assert = require("node:assert/strict");
const NuHeatThermostat = require("../lib/NuHeatThermostat");
const helpers_1 = require("./support/helpers");
test("manual mode is exposed to HomeKit as heat, not off", () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createThermostatHomebridgeStub)();
    const thermostat = new NuHeatThermostat((0, helpers_1.createLogStub)(), { serialNumber: "123", swVersion: "1.0", name: "Bathroom" }, 1440, accessory, {}, homebridge);
    thermostat.updateValues({
        Online: true,
        currentTemperature: 1209,
        setPointTemp: 1209,
        isHeating: false,
        operatingMode: 2,
    });
    const value = accessory
        .getService(homebridge.hap.Service.Thermostat)
        .getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
    assert.equal(value, Characteristic.TargetHeatingCoolingState.HEAT);
});
test("heat-only thermostats do not advertise an off target state", () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createThermostatHomebridgeStub)();
    new NuHeatThermostat((0, helpers_1.createLogStub)(), { serialNumber: "124", swVersion: "1.0", name: "Bathroom" }, 1440, accessory, {}, homebridge);
    const props = accessory
        .getService(homebridge.hap.Service.Thermostat)
        .getCharacteristic(Characteristic.TargetHeatingCoolingState).props;
    assert.deepEqual(props.validValues, [Characteristic.TargetHeatingCoolingState.HEAT]);
});
test("off requests are translated to the minimum NuHeat target temperature", async () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createThermostatHomebridgeStub)();
    let requestedSetPoint;
    const thermostat = new NuHeatThermostat((0, helpers_1.createLogStub)(), { serialNumber: "125", swVersion: "1.0", name: "Bathroom" }, 1440, accessory, {
        async setHeatSetpoint(_serialNumber, setPoint) {
            requestedSetPoint = setPoint;
            return {
                Online: true,
                currentTemperature: 1209,
                setPointTemp: Number(setPoint),
                isHeating: false,
                operatingMode: 2,
            };
        },
    }, homebridge);
    await new Promise((resolve, reject) => {
        void thermostat.setTargetHeatingCooling(Characteristic.TargetHeatingCoolingState.OFF, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    assert.equal(requestedSetPoint, thermostat.toNuHeatTemperature(10));
    const targetState = accessory
        .getService(homebridge.hap.Service.Thermostat)
        .getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
    assert.equal(targetState, Characteristic.TargetHeatingCoolingState.HEAT);
});
test("hardware display units follow the NuHeat account temperature scale", () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createThermostatHomebridgeStub)();
    new NuHeatThermostat((0, helpers_1.createLogStub)(), { serialNumber: "126", swVersion: "1.0", name: "Bathroom" }, 1440, accessory, {}, homebridge, "Fahrenheit");
    const displayUnits = accessory
        .getService(homebridge.hap.Service.Thermostat)
        .getCharacteristic(Characteristic.TemperatureDisplayUnits).value;
    assert.equal(displayUnits, Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
});
test("string online values are parsed without mutating the payload", () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createThermostatHomebridgeStub)();
    const thermostat = new NuHeatThermostat((0, helpers_1.createLogStub)(), { serialNumber: "456", swVersion: "1.0", name: "Ensuite" }, 1440, accessory, {}, homebridge);
    const payload = {
        Online: "'True'",
        currentTemperature: 1209,
        setPointTemp: 1209,
        isHeating: true,
        operatingMode: 1,
    };
    thermostat.updateValues(payload);
    const currentState = accessory
        .getService(homebridge.hap.Service.Thermostat)
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
    assert.equal(currentState, Characteristic.CurrentHeatingCoolingState.HEAT);
    assert.equal(payload.Online, "'True'");
});
function createThermostatWith204Setpoint(serialNumber) {
    const stub = (0, helpers_1.createThermostatHomebridgeStub)();
    const api = {
        refreshCalls: 0,
        // makeAPICall returns `true` for a 204 No Content reply
        async setHeatSetpoint() {
            return true;
        },
        async refreshThermostat() {
            api.refreshCalls += 1;
            return false;
        },
    };
    const thermostat = new NuHeatThermostat((0, helpers_1.createLogStub)(), {
        serialNumber,
        swVersion: "1.0",
        name: "Master",
        Online: true,
        currentTemperature: 2417,
        setPointTemp: 1209,
        isHeating: false,
        operatingMode: 2,
    }, 1440, stub.accessory, api, stub.homebridge);
    return { ...stub, api, thermostat };
}
function invoke(handler) {
    return new Promise((resolve, reject) => {
        void handler((error) => (error ? reject(error) : resolve()));
    });
}
test("a 204 setpoint response keeps the thermostat data with the new setpoint", async () => {
    const { accessory, homebridge, Characteristic, api, thermostat } = createThermostatWith204Setpoint("127");
    await invoke((callback) => thermostat.setTargetTemperature(23, callback));
    const service = accessory.getService(homebridge.hap.Service.Thermostat);
    assert.equal(api.refreshCalls, 0);
    assert.equal(thermostat.deviceData.serialNumber, "127");
    assert.equal(thermostat.deviceData.setPointTemp, Number(thermostat.toNuHeatTemperature(23)));
    assert.equal(service.getCharacteristic(Characteristic.CurrentTemperature).value, Number(thermostat.toHBTemperature(2417)));
    assert.equal(service.getCharacteristic(Characteristic.TargetTemperature).value, 23);
});
test("a 204 response to an off request keeps the thermostat data at the minimum setpoint", async () => {
    const { accessory, homebridge, Characteristic, thermostat } = createThermostatWith204Setpoint("128");
    await invoke((callback) => thermostat.setTargetHeatingCooling(Characteristic.TargetHeatingCoolingState.OFF, callback));
    const service = accessory.getService(homebridge.hap.Service.Thermostat);
    assert.equal(thermostat.deviceData.serialNumber, "128");
    assert.equal(service.getCharacteristic(Characteristic.CurrentTemperature).value, Number(thermostat.toHBTemperature(2417)));
    assert.equal(service.getCharacteristic(Characteristic.TargetTemperature).value, 10);
});
