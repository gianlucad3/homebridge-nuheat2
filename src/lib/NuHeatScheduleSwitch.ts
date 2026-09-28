import NuHeatAPI = require("./NuHeatAPI");
import { SCHEDULE_MODE } from "./NuHeatModels";
import type {
  AccessoryLike,
  AccessoryThermostat,
  Callback,
  HomebridgeLike,
  LoggerLike,
} from "./types";

let Characteristic: Record<string, any>;
let SwitchService: unknown;

class NuHeatScheduleSwitch {
  log: LoggerLike;
  deviceData: AccessoryThermostat;
  accessory: AccessoryLike;
  nuHeatAPI: NuHeatAPI;

  constructor(
    log: LoggerLike,
    deviceData: AccessoryThermostat,
    accessory: AccessoryLike,
    nuHeatAPI: NuHeatAPI,
    homebridge: HomebridgeLike,
  ) {
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
      .setCharacteristic(
        Characteristic.SerialNumber,
        (this.deviceData.serialNumber ?? "") + "-schedule",
      );

    this.setupListeners();
  }

  setupListeners(): void {
    this.accessory
      .getService(SwitchService)
      .getCharacteristic(Characteristic.On)
      .on("set", this.setScheduleEnabled.bind(this));
  }

  async setScheduleEnabled(value: boolean, callback: Callback): Promise<void> {
    if (!value) {
      callback(null);
      this.updateValues(this.deviceData);
      return;
    }

    this.log.debug(
      "Resuming schedule for thermostat " + this.deviceData.serialNumber,
      this.deviceData.name,
    );

    const response = await this.nuHeatAPI.resumeSchedule(
      this.deviceData.serialNumber ?? "",
    );

    if (!response) {
      this.log.error("Error resuming schedule", this.deviceData.name);
      callback(new Error("Error: resumeSchedule"));
      return;
    }

    // A 204 No Content reply comes back as `true`; keep the existing
    // thermostat data and mark the schedule as resumed.
    this.updateValues(
      response === true
        ? { ...this.deviceData, scheduleMode: SCHEDULE_MODE.AUTO }
        : response,
    );
    callback(null);
  }

  updateValues(newValues: AccessoryThermostat): void {
    this.deviceData = newValues;
    const scheduleEnabled = newValues.scheduleMode === SCHEDULE_MODE.AUTO;
    this.accessory
      .getService(SwitchService)
      .getCharacteristic(Characteristic.On)
      .updateValue(scheduleEnabled);
  }
}

export = NuHeatScheduleSwitch;
