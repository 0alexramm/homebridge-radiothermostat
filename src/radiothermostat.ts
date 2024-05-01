import {AccessoryConfig, AccessoryPlugin, API, Characteristic, CharacteristicValue, Logging, Service} from 'homebridge';

interface ThermostatConfig extends AccessoryConfig {
    base_url?: string;
    min_poll_interval?: number;
    enable_fan_interface?: boolean;
}
export class Radiothermostat implements AccessoryPlugin {
    private readonly service: Service;
    private readonly informationService: Service;
    private readonly fanService?: Service;
    private readonly Characteristic: typeof Characteristic;
    private lastGetStateTime = new Date(0);
    private getStateCache: any;
    private getStateInProgress = false;
    private model?: string;
    private sysInfo?: {serialNumber: string, firmware: string};


    constructor(
        private readonly log: Logging,
        private readonly config: ThermostatConfig,
        private readonly api: API,
    ) {
        // config defaults and checks
        if (config.base_url === undefined) {
            this.log.error(`"base_url" must be defined in the config`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        if (config.min_poll_interval === undefined) {
            config.min_poll_interval = 5000;
        } else if (config.min_poll_interval < 3000) {
            config.min_poll_interval = 3000;
        } else if (config.min_poll_interval > 15000) {
            config.min_poll_interval = 15000;
        }

        if (config.enable_fan_interface === undefined) {
            config.enable_fan_interface = false;
        }

        this.Characteristic = this.api.hap.Characteristic;
        this.informationService = new this.api.hap.Service.AccessoryInformation();
        this.service = new this.api.hap.Service(config.name, this.api.hap.Service.Thermostat.UUID);
        if (config.enable_fan_interface === true) {
            this.fanService = new this.api.hap.Service(config.name + ' Fan', this.api.hap.Service.Fanv2.UUID);
        }

        // AccessoryInformation Service
        this.informationService.setCharacteristic(this.Characteristic.Manufacturer, 'Radiothermostat');
        this.informationService.getCharacteristic(this.Characteristic.Model)
            .onGet(this.onGetModel.bind(this));
        this.informationService.getCharacteristic(this.Characteristic.SerialNumber)
            .onGet(this.onGetSerialNumber.bind(this));
        this.informationService.getCharacteristic(this.Characteristic.FirmwareRevision)
            .onGet(this.onGetFirmware.bind(this));

        // Thermostat Service
        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.onCurrentHeatingCoolingStateGet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .onGet(this.onTargetHeatingCoolingStateGet.bind(this))
            .onSet(this.onTargetHeatingCoolingStateSet.bind(this))
            .setProps({ // TODO: for now, AUTO is disabled as it's unclear how to set a target temp for that mode
                validValues: [
                    this.Characteristic.TargetHeatingCoolingState.OFF,
                    this.Characteristic.TargetHeatingCoolingState.HEAT,
                    this.Characteristic.TargetHeatingCoolingState.COOL,
                ],
            });

        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(this.onCurrentTemperatureGet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
            .onGet(this.onTargetTemperatureGet.bind(this))
            .onSet(this.onTargetTemperatureSet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(this.onTemperatureDisplayUnitsGet.bind(this))
            .onSet(this.onTemperatureDisplayUnitsSet.bind(this))
            .setProps({ // disable Celsius
                validValues: [this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT],
            });

        // Fanv2 Service
        this.fanService?.getCharacteristic(this.Characteristic.Active)
            .onGet(this.onFanActiveGet.bind(this))
            .onSet(this.onFanActiveSet.bind(this));

        this.log.debug('Finished initializing accessory:', this.config.name);
        // fetch initial data async
        this.getInfo();
        this.getState();
        this.registerHumidity(); // need to query device to check if supported
        if (this.fanService !== undefined) {
            setInterval(this.updateFanState.bind(this), 15000); // update Fan state to use as automation event
        }
    }

    getServices(): Service[] {
        const services = [this.service, this.informationService];
        if (this.fanService !== undefined) {
            services.push(this.fanService);
        }
        return services;
    }

    // AccessoryInformation Service
    private async onGetModel() {
        if (this.model === undefined) {
            try {
                this.model = await this.request('/tstat/model').then((data) => data.model);
            } catch (error) {
                this.model = 'unknown';
            }
        }
        return this.model as CharacteristicValue;
    }

    private async getInfo() {
        if (this.sysInfo === undefined) {
            try {
                const sysInfo = await this.request('/sys');
                this.sysInfo = {serialNumber: sysInfo.uuid, firmware: sysInfo.fw_version};
            } catch (error) {
                this.sysInfo = {serialNumber: 'unknown', firmware: 'unknown'};
            }
        }
        return this.sysInfo;
    }

    private async onGetSerialNumber() {
        const sysInfo = await this.getInfo();
        return sysInfo.serialNumber as CharacteristicValue;
    }

    private async onGetFirmware() {
        const sysInfo = await this.getInfo();
        return sysInfo.firmware as CharacteristicValue;
    }

    // Thermostat Service
    private fahrenheitToCelsius(fahrenheit: number) {
        return (fahrenheit - 32) * 5/9;
    }

    private celsiusToFahrenheit(celsius: number) {
        return celsius * 9/5 + 32;
    }
    private async request(uri: string, method = 'GET', body?: string) {
        const url = this.config.base_url + uri;
        const response = await fetch(url, {method, body});
        if (!response.ok) {
            this.log.error(`Request to ${url} status: ${response.status}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        return response.json();
    }
    private async getState() {
        while (this.getStateInProgress) { // delay as many getters usually gets called at the same time
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const currentTime = new Date();
        // new query if data are older than specified (5 sec default)
        if (currentTime.getTime() - this.lastGetStateTime.getTime() > this.config?.min_poll_interval! ) {
            this.getStateInProgress = true;
            try {
                this.getStateCache = await this.request('/tstat');
            } catch (error) {
                this.getStateInProgress = false;
                throw error;
            }

            this.lastGetStateTime = currentTime;
            this.getStateInProgress = false;
        }

        return this.getStateCache;
    }

    private async onCurrentHeatingCoolingStateGet() {
        const currentState = await this.getState().then((data) => data.tstate);
        this.log.debug('onCurrentHeatingCoolingStateGet:', currentState);
        // tstate is "HVAC Operating State". Can be: 0 - OFF, 1 - HEAT, 2 -COOL
        return currentState as CharacteristicValue;
    }

    private async onTargetHeatingCoolingStateGet() {
        const state = await this.getState();
        this.log.debug('onTargetHeatingCoolingStateGet:', state.tmode);
        // it seems there is no way to change target temp when thermostat
        // was set to AUTO on the device itself (tmode is 3)
        // if target state is auto, set it to heat if current temp < 60,
        // cool if current temp > 85, off otherwise
        if (state.tmode == this.Characteristic.TargetHeatingCoolingState.AUTO) {
            if (state.temp < 60) state.tmode = this.Characteristic.TargetHeatingCoolingState.HEAT;
            if (state.temp > 85) state.tmode = this.Characteristic.TargetHeatingCoolingState.COOL;
            else state.tmode = this.Characteristic.TargetHeatingCoolingState.OFF;
            await this.request('/tstat', 'POST', `{"tmode": ${state.tmode}}`);
        }
        return state.tmode as CharacteristicValue;
    }

    private async onTargetHeatingCoolingStateSet(targetState: any) {
        this.log.debug('onTargetHeatingCoolingStateSet:', targetState);
        await this.request('/tstat', 'POST', `{"tmode": ${targetState}}`);
        // update target temp from from the thermostat because it gets reset by schedule
        const temp = await this.onTargetTemperatureGet();
        this.service.getCharacteristic(this.Characteristic.TargetTemperature).updateValue(temp);
        return;
    }

    private async onCurrentTemperatureGet() {
        const currentTemp = await this.getState().then((data) => data.temp);
        this.log.debug('onCurrentTemperatureGet:', currentTemp);
        return this.fahrenheitToCelsius(currentTemp) as CharacteristicValue;
    }

    private async onTargetTemperatureGet() {
        const state = await this.getState();
        let targetTemp = state.temp;
        switch (state.tmode) {
        case this.Characteristic.TargetHeatingCoolingState.HEAT:
            targetTemp = state.t_heat;
            break;
        case this.Characteristic.TargetHeatingCoolingState.COOL:
            targetTemp = state.t_cool;
            break;
        }

        this.log.debug('onTargetTemperatureGet:', targetTemp);
        return this.fahrenheitToCelsius(targetTemp) as CharacteristicValue;
    }

    // this sets only temporary target temp. Switching mode or schedule reset it
    private async onTargetTemperatureSet(targetTempCelsius: any) {
        // thermostat only accept values rounded to 0.5, but Apple shows rounded to 1 anyway
        const targetTemp = Math.round(this.celsiusToFahrenheit(targetTempCelsius));
        this.log.debug('onTargetTemperatureSet:', targetTemp);

        const state = await this.getState();
        switch (state.tmode) {
        case this.Characteristic.TargetHeatingCoolingState.HEAT:
            this.request('/tstat', 'POST', `{"t_heat": ${targetTemp}}`);
            break;
        case this.Characteristic.TargetHeatingCoolingState.COOL:
            this.request('/tstat', 'POST', `{"t_cool":${targetTemp}}`);
            break;
        }
    }

    private onTemperatureDisplayUnitsGet() {
        this.log.debug('onTemperatureDisplayUnitsGet');
        const currentValue = this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
        return currentValue;
    }

    private onTemperatureDisplayUnitsSet(value: any) {
        this.log.debug('onTemperatureDisplayUnitsSet:', value);
    }

    private async registerHumidity() {
        const humidity = await this.onCurrentRelativeHumidityGet();
        if (humidity as number >= 0) {
            this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
                .onGet(this.onCurrentRelativeHumidityGet.bind(this));
        }
    }

    private async onCurrentRelativeHumidityGet() {
        const humidity = this.model = await this.request('/tstat/humidity').then((data) => data.humidity);
        this.log.debug('onCurrentRelativeHumidityGet:', humidity);
        return humidity as CharacteristicValue;
    }

    private async onFanActiveGet() {
        const state = await this.getState();

        this.log.debug('onFanActiveGet:', state.fstate );
        return state.fstate as CharacteristicValue;
    }

    private async onFanActiveSet(active: any) {
        this.log.debug('onFanActiveSet:', active);
        const fmode = (active == this.Characteristic.Active.INACTIVE) ? 0 : 2;
        await this.request('/tstat', 'POST', `{"fmode": ${fmode}}`);
    }

    private async updateFanState() {
        const state = await this.getState();
        this.log.debug('updateFanState:', state.fstate);
        this.fanService?.getCharacteristic(this.Characteristic.Active).updateValue(state.fstate);
    }
}
