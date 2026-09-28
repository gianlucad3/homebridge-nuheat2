import NuHeatAPI = require("./NuHeatAPI");
import { OPERATING_MODE, SCHEDULE_MODE } from "./NuHeatModels";
import type {
  AccessoryLike,
  AccessoryThermostat,
  Callback,
  HomebridgeLike,
  LoggerLike,
} from "./types";

let Characteristic: Record<string, any>;
let ThermostatService: unknown;

const MIN_TARGET_TEMPERATURE_C = 10;
const MAX_TARGET_TEMPERATURE_C = 38;

class NuHeatThermostat {
  log: LoggerLike;
  deviceData: AccessoryThermostat;
  holdLength: number;
  accessory: AccessoryLike;
  NuHeatAPI: NuHeatAPI;
  temperatureScale?: string;

  constructor(
    log: LoggerLike,
    deviceData: AccessoryThermostat,
    holdLength: number,
    accessory: AccessoryLike,
    NuHeatAPI: NuHeatAPI,
    homebridge: HomebridgeLike,
    temperatureScale?: string,
  ) {
    Characteristic = homebridge.hap.Characteristic;
    ThermostatService = homebridge.hap.Service.Thermostat;
    this.log = log;
    this.deviceData = deviceData;
    this.holdLength = holdLength;
    this.accessory = accessory;
    this.NuHeatAPI = NuHeatAPI;
    this.temperatureScale = temperatureScale;

    this.accessory
      .getService(homebridge.hap.Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "NuHeat")
      .setCharacteristic(Characteristic.Model, "Signature")
      .setCharacteristic(
        Characteristic.SerialNumber,
        this.deviceData.serialNumber,
      )
      .setCharacteristic(
        Characteristic.FirmwareRevision,
        this.deviceData.swVersion,
      );
    this.setupListeners();
  }

  setupListeners(): void {
    const thermostatService = this.accessory.getService(ThermostatService);

    this.log.info("holdLength: " + this.holdLength, this.deviceData.name);
    thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [Characteristic.TargetHeatingCoolingState.HEAT],
      })
      .on("set", this.setTargetHeatingCooling.bind(this));
    thermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({
      minValue: -100,
      maxValue: 100,
    });
    thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minStep: 0.5,
      })
      .on("set", this.setTargetTemperature.bind(this));

    this.updateTemperatureDisplayUnits();
  }

  async setTargetHeatingCooling(
    value: number,
    callback: Callback,
  ): Promise<void> {
    if (value !== Characteristic.TargetHeatingCoolingState.OFF) {
      callback(null);
      void this.updateAccessory();
      return;
    }

    this.log.info(
      "NuHeat does not support an off mode. Setting the thermostat to its minimum target temperature instead.",
      this.deviceData.name,
    );

    const heatSetPoint = this.toNuHeatTemperature(MIN_TARGET_TEMPERATURE_C);
    const response = await this.NuHeatAPI.setHeatSetpoint(
      this.deviceData.serialNumber ?? "",
      heatSetPoint,
      this.holdLength,
    );

    if (!response) {
      this.log.error(
        "Error setting minimum target temperature for off request",
        this.deviceData.name,
      );
      callback(new Error("Error: setTargetHeatingCooling"));
      return;
    }

    this.applySetpointResponse(response, heatSetPoint);
    callback(null);
  }

  async setTargetTemperature(value: number, callback: Callback): Promise<void> {
    this.log.info(
      "Setting target temperature to " + value + " C",
      this.deviceData.name,
    );
    if (value < MIN_TARGET_TEMPERATURE_C) value = MIN_TARGET_TEMPERATURE_C;
    if (value > MAX_TARGET_TEMPERATURE_C) value = MAX_TARGET_TEMPERATURE_C;
    const heatSetPoint = this.toNuHeatTemperature(value);
    this.log.debug(
      "setTargetTemperature " + heatSetPoint,
      this.deviceData.name,
    );

    const response = await this.NuHeatAPI.setHeatSetpoint(
      this.deviceData.serialNumber ?? "",
      heatSetPoint,
      this.holdLength,
    );

    if (!response) {
      this.log.error("Error setting target temperature", this.deviceData.name);
      callback(new Error("Error: setTargetTemperature"));
    } else {
      this.applySetpointResponse(response, heatSetPoint);
      callback(null);
    }
  }

  // NuHeat answers a successful setpoint PUT with 204 No Content, which
  // makeAPICall returns as `true` rather than thermostat data. In that case,
  // keep the existing thermostat data with the new setpoint applied.
  private applySetpointResponse(
    response: AccessoryThermostat | true,
    heatSetPoint: string,
  ): void {
    this.updateValues(
      response === true
        ? { ...this.deviceData, setPointTemp: Number(heatSetPoint) }
        : response,
    );
  }

  async updateAccessory(): Promise<void> {
    const response = await this.NuHeatAPI.refreshThermostat(
      this.deviceData.serialNumber ?? "",
    );
    if (!response) {
      this.log.error("Error getting updated data", this.deviceData.name);
    } else {
      this.updateValues(response);
    }
  }

  updateValues(newValues: AccessoryThermostat): void {
    if (this.isOnline(newValues)) {
      this.updateTemperatureDisplayUnits();

      let currentTemperature = Number(
        this.toHBTemperature(newValues.currentTemperature ?? 0),
      );
      this.log.debug(
        "Current temperature is " + currentTemperature + " C",
        this.deviceData.name,
      );
      this.accessory
        .getService(ThermostatService)
        .getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(currentTemperature);

      let setPointTemperature = Number(
        this.toHBTemperature(newValues.setPointTemp ?? 0),
      );
      if (setPointTemperature < MIN_TARGET_TEMPERATURE_C) {
        setPointTemperature = MIN_TARGET_TEMPERATURE_C;
      }
      if (setPointTemperature > MAX_TARGET_TEMPERATURE_C) {
        setPointTemperature = MAX_TARGET_TEMPERATURE_C;
      }
      this.log.debug(
        "Setpoint temperature is " + setPointTemperature + " C",
        this.deviceData.name,
      );
      this.accessory
        .getService(ThermostatService)
        .getCharacteristic(Characteristic.TargetTemperature)
        .updateValue(setPointTemperature);

      let currentHeatingCoolingState =
        Characteristic.CurrentHeatingCoolingState.OFF;
      if (newValues.isHeating) {
        currentHeatingCoolingState =
          Characteristic.CurrentHeatingCoolingState.HEAT;
      }
      this.log.debug(
        "Current heating state is " + currentHeatingCoolingState,
        this.deviceData.name,
      );
      this.accessory
        .getService(ThermostatService)
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .updateValue(currentHeatingCoolingState);

      const targetHeatingCooling =
        this.toHomeBridgeHeatingCoolingState(newValues);
      this.log.debug(
        "Target heating state is " + targetHeatingCooling,
        this.deviceData.name,
      );
      this.accessory
        .getService(ThermostatService)
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .updateValue(targetHeatingCooling);
    } else {
      this.log.debug(
        "Seems to be offline according to NuHeat",
        this.deviceData.name,
      );
    }
    this.deviceData = newValues;
  }

  toNuHeatTemperature(temperature: number): string {
    return (((temperature * 9) / 5 + 32 - 33) * 56 + 33).toFixed(0);
  }

  toHBTemperature(temperature: number): string {
    return ((((temperature - 33) / 56 + 33 - 32) * 5) / 9).toFixed(1);
  }

  toHomeBridgeHeatingCoolingState(newValues: AccessoryThermostat): number {
    if (!this.isOnline(newValues)) {
      return Characteristic.TargetHeatingCoolingState.OFF;
    }

    switch (newValues.operatingMode) {
      case OPERATING_MODE.AUTO:
      case OPERATING_MODE.MANUAL:
        return Characteristic.TargetHeatingCoolingState.HEAT;
      default:
        return Characteristic.TargetHeatingCoolingState.HEAT;
    }
  }

  isScheduleEnabled(newValues: AccessoryThermostat): boolean {
    return newValues.scheduleMode === SCHEDULE_MODE.AUTO;
  }

  isOnline(newValues: AccessoryThermostat): boolean {
    const onlineValue =
      newValues.Online ?? newValues.online ?? newValues.isOnline;
    if (typeof onlineValue === "boolean") {
      return onlineValue;
    }

    if (typeof onlineValue === "string") {
      const normalizedValue = onlineValue
        .replace(/'/g, "")
        .trim()
        .toLowerCase();
      return normalizedValue === "true";
    }

    return true;
  }

  updateTemperatureDisplayUnits(): void {
    const displayUnits = this.toHomeKitDisplayUnits(this.temperatureScale);
    if (
      displayUnits === undefined ||
      !Characteristic.TemperatureDisplayUnits
    ) {
      return;
    }

    this.accessory
      .getService(ThermostatService)
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(displayUnits);
  }

  toHomeKitDisplayUnits(temperatureScale?: string): number | undefined {
    if (!temperatureScale || !Characteristic.TemperatureDisplayUnits) {
      return undefined;
    }

    const normalizedScale = temperatureScale.trim().toLowerCase();
    if (normalizedScale.startsWith("f")) {
      return Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }

    if (normalizedScale.startsWith("c")) {
      return Characteristic.TemperatureDisplayUnits.CELSIUS;
    }

    return undefined;
  }
}

export = NuHeatThermostat;
