"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test = require("node:test");
const assert = require("node:assert/strict");
const NuHeatScheduleSwitch = require("../lib/NuHeatScheduleSwitch");
const NuHeatModels_1 = require("../lib/NuHeatModels");
const helpers_1 = require("./support/helpers");
test("schedule switch reflects schedule mode state", () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createSwitchHomebridgeStub)();
    const scheduleSwitch = new NuHeatScheduleSwitch((0, helpers_1.createLogStub)(), { serialNumber: "123", name: "Bathroom", scheduleMode: NuHeatModels_1.SCHEDULE_MODE.HOLD }, accessory, { resumeSchedule: async () => false }, homebridge);
    scheduleSwitch.updateValues({
        serialNumber: "123",
        name: "Bathroom",
        scheduleMode: NuHeatModels_1.SCHEDULE_MODE.AUTO,
    });
    const value = accessory
        .getService(homebridge.hap.Service.Switch)
        .getCharacteristic(Characteristic.On).value;
    assert.equal(value, true);
});
test("schedule switch resumes schedule when turned on", async () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createSwitchHomebridgeStub)();
    let calledWith = null;
    const scheduleSwitch = new NuHeatScheduleSwitch((0, helpers_1.createLogStub)(), { serialNumber: "123", name: "Bathroom", scheduleMode: NuHeatModels_1.SCHEDULE_MODE.HOLD }, accessory, {
        resumeSchedule: async (serialNumber) => {
            calledWith = serialNumber;
            return {
                serialNumber,
                name: "Bathroom",
                scheduleMode: NuHeatModels_1.SCHEDULE_MODE.AUTO,
            };
        },
    }, homebridge);
    await new Promise((resolve, reject) => {
        scheduleSwitch.setScheduleEnabled(true, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    const value = accessory
        .getService(homebridge.hap.Service.Switch)
        .getCharacteristic(Characteristic.On).value;
    assert.equal(calledWith, "123");
    assert.equal(value, true);
});
test("a 204 resume-schedule response keeps the existing thermostat data", async () => {
    const { accessory, homebridge, Characteristic } = (0, helpers_1.createSwitchHomebridgeStub)();
    const scheduleSwitch = new NuHeatScheduleSwitch((0, helpers_1.createLogStub)(), { serialNumber: "123", name: "Bathroom", scheduleMode: NuHeatModels_1.SCHEDULE_MODE.HOLD }, accessory, 
    // makeAPICall returns `true` for a 204 No Content reply
    { resumeSchedule: async () => true }, homebridge);
    await new Promise((resolve, reject) => {
        scheduleSwitch.setScheduleEnabled(true, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    const value = accessory
        .getService(homebridge.hap.Service.Switch)
        .getCharacteristic(Characteristic.On).value;
    assert.equal(value, true);
    assert.equal(scheduleSwitch.deviceData.serialNumber, "123");
    assert.equal(scheduleSwitch.deviceData.scheduleMode, NuHeatModels_1.SCHEDULE_MODE.AUTO);
});
