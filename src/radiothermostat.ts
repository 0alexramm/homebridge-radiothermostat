import {AccessoryConfig, AccessoryPlugin, API, Characteristic, CharacteristicValue, Logging, Service} from 'homebridge';

export class Radiothermostat implements AccessoryPlugin {
    private readonly service: Service;
    private readonly Characteristic: typeof Characteristic;
    private lastGetStateTime = new Date(0);
    private getStateCache: any;
    private getStateInProgress = false;

    constructor(
        private readonly log: Logging,
        private readonly config: AccessoryConfig,
        private readonly api: API,
    ) {
        // TODO Fan service and humidity sensor service
        this.service = new this.api.hap.Service(config.name, this.api.hap.Service.Thermostat.UUID);
        this.Characteristic = this.api.hap.Characteristic;

        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.onCurrentHeatingCoolingStateGet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .onGet(this.onTargetHeatingCoolingStateGet.bind(this))
            .onSet(this.onTargetHeatingCoolingStateSet.bind(this))
            .setProps({ // disable auto
                validValues: [
                    this.Characteristic.TargetHeatingCoolingState.OFF,
                    this.Characteristic.TargetHeatingCoolingState.HEAT,
                    this.Characteristic.TargetHeatingCoolingState.COOL]
              });

        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(this.onCurrentTemperatureGet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
            .onGet(this.onTargetTemperatureGet.bind(this))
            .onSet(this.onTargetTemperatureSet.bind(this));

        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(this.onTemperatureDisplayUnitsGet.bind(this))
            .onSet(this.onTemperatureDisplayUnitsSet.bind(this))
            .setProps({ // disable Celsium
                validValues: [this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT]
            });

        this.log.debug('Finished initializing accessory:', this.config.name);
    }
    identify?(): void {
        this.log('Identify!');
    }
    getServices(): Service[] {
        return [this.service];
    }

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
        if (currentTime.getTime() - this.lastGetStateTime.getTime() > 5000) {// new query if data are older than 5 sec
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
        // if state is auto, set it to heat if temp < 65, cool if temp > 85, off otherwise
        return currentState as CharacteristicValue;
    }

    private async onTargetHeatingCoolingStateGet() {
        const state = await this.getState();
        this.log.debug('onTargetHeatingCoolingStateGet:', state.tmode);
        // if target state is auto in the device, set it to heat if temp < 65,
        // cool if temp > 85, off otherwise
        if(state.tmode == this.Characteristic.TargetHeatingCoolingState.AUTO) {
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
}
