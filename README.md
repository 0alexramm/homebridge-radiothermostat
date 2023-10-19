# homebridge-radiothermostat-ar

HomeBridge plugin for a RadioThermostat device. See <http://www.radiothermostat.com/>. It was implemented because Radiothermostat discontinued its app and other available RadioThermostat plugins have issues.
At the moment it does not support thermostat AUTO mode.

## Installation

Install this plugin using: npm install -g homebridge-radiothermostat-ar

## Configuration parameters

- "accessory" - Should be set to "radiothermostat". Required.
- "name" - Accessory name to show in the UI. Required.
- "base_url" - Url of the thermostat. Required.
- "min_poll_interval" - Throttle network requests to the thermostat to one per specified interval value in milliseconds. Default value is 5000 (5 sec). Min 3000, max 15000. Optional.
- "enable_fan_interface" - Adds fan on/auto control. Default value is false. Optional.

### Configuration sample

 ``` json
    {

        "accessories": [
            {
                "accessory": "radiothermostat",
                "name": "Thermostat",
                "base_url": "http://192.169.1.10",
                "min_poll_interval": 10000,
                "enable_fan_interface": true
            }
        ],

        "platforms":[]
    }
