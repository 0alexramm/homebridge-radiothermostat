import {API} from 'homebridge';
import {Radiothermostat} from './radiothermostat';

export = (api: API) => {
    api.registerAccessory('homebridge-radiothermostat-ar', 'radiothermostat', Radiothermostat);
};


