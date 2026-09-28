"use strict";
const NuHeatModels_1 = require("./NuHeatModels");
let Characteristic;
let SwitchService;
class NuHeatScheduleSwitch {
    log;
    deviceData;
    accessory;
    nuHeatAPI;
    constructor(log, deviceData, accessory, nuHeatAPI, homebridge) {
        Characteristic = homebridge.hap.Characteristic;
        SwitchService = homebridge.hap.Service.Switch;
        this.log = log;
        this.deviceData = deviceData;
        this.accessory = accessory;
        this.nuHeatAPI = nuHeatAPI;
        this.accessory
            .getService(homebridge.hap.Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, "NuHeat")
            .setCharacteristic(Characteristic.Model, "Signature Schedule")
            .setCharacteristic(Characteristic.SerialNumber, (this.deviceData.serialNumber ?? "") + "-schedule");
        this.setupListeners();
    }
    setupListeners() {
        this.accessory
            .getService(SwitchService)
            .getCharacteristic(Characteristic.On)
            .on("set", this.setScheduleEnabled.bind(this));
    }
    async setScheduleEnabled(value, callback) {
        if (!value) {
            callback(null);
            this.updateValues(this.deviceData);
            return;
        }
        this.log.debug("Resuming schedule for thermostat " + this.deviceData.serialNumber, this.deviceData.name);
        const response = await this.nuHeatAPI.resumeSchedule(this.deviceData.serialNumber ?? "");
        if (!response) {
            this.log.error("Error resuming schedule", this.deviceData.name);
            callback(new Error("Error: resumeSchedule"));
            return;
        }
        // A 204 No Content reply comes back as `true`; keep the existing
        // thermostat data and mark the schedule as resumed.
        this.updateValues(response === true
            ? { ...this.deviceData, scheduleMode: NuHeatModels_1.SCHEDULE_MODE.AUTO }
            : response);
        callback(null);
    }
    updateValues(newValues) {
        this.deviceData = newValues;
        const scheduleEnabled = newValues.scheduleMode === NuHeatModels_1.SCHEDULE_MODE.AUTO;
        this.accessory
            .getService(SwitchService)
            .getCharacteristic(Characteristic.On)
            .updateValue(scheduleEnabled);
    }
}
module.exports = NuHeatScheduleSwitch;
