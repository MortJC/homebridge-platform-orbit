const PluginName = 'homebridge-platform-orbit';
const PlatformName = 'orbit';
const request = require("request");
const WebSocket = require("ws");

class PlatformOrbit {


  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.email = config["email"];
    this.password = config["password"];
    this.user = null;
    this.token = null;
    this.id = null;
    this.accessories = [];
    this.refreshDevice = true;

    this.log('Starting OrbitPlatform using homebridge API', api.version);
    if (api) {

      // save the api for use later
      this.api = api;

      // if finished loading cache accessories
      this.api.on("didFinishLaunching", function () {

        // login to API
        this._login(function () {

          // Fetch the devices
          this._fetchDevices();

        }.bind(this));
      }.bind(this));
    }
  }


  configureAccessory(accessory) {
    // Configure handlers for cache accessories
    this.log('Remembered accessory, configuring handlers', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;

    // Configure Irrigation Service
    this._configureIrrigationService(accessory.getService(Service.IrrigationSystem));

    // Find the valve Services
    accessory.services.forEach(function (service) {
      if (Service.Valve.UUID === service.UUID) {

        // Configure Valve Service
        this._configureValveService(accessory, service);
      }
    }.bind(this));
  }


  _createIrrigationAccessory(uuid, id, name, hardware_version, firmware_version, is_connected, runmode) {
    this.log.debug('Create Irrigation service', id);

    // Create new Irrigation System Service
    let newAccessory = new Accessory(name, uuid);
    newAccessory.addService(Service.IrrigationSystem, name);
    newAccessory.updateReachability(true);
    let irrigationSystem = newAccessory.getService(Service.IrrigationSystem);

    // Check if the device is connected
    if (is_connected == true) {
      irrigationSystem.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } else {
      irrigationSystem.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }

    // Set the Program Mode
    switch (runmode) {
      case "auto":
        irrigationSystem.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED);
        break;
      case "manual":
        irrigationSystem.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
        break;
      case "off":
        irrigationSystem.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
        break;
    }

    // Create AccessoryInformation Service
    newAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return newAccessory;
  }


  _configureIrrigationService(irrigationSystemService) {
    this.log.debug('Configure Irrigation service', irrigationSystemService.getCharacteristic(Characteristic.Name).value)

    // Configure IrrigationSystem Service
    irrigationSystemService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);

    irrigationSystemService
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getDeviceValue.bind(this, irrigationSystemService, "DeviceActive"));

    irrigationSystemService
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getDeviceValue.bind(this, irrigationSystemService, "DeviceInUse"));

    irrigationSystemService
      .getCharacteristic(Characteristic.ProgramMode)
      .on('get', this._getDeviceValue.bind(this, irrigationSystemService, "DeviceProgramMode"));

    irrigationSystemService
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getDeviceValue.bind(this, irrigationSystemService, "DeviceRemainingDuration"));
  }


  _createValveService(id, name) {
    this.log.debug("Create Valve service " + name + " with id " + id);

    // Create Valve Service
    let valve = new Service.Valve(name, id);
    valve
      .setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
      .setCharacteristic(Characteristic.SetDuration, 300)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.ServiceLabelIndex, id)
      .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
      .setCharacteristic(Characteristic.Name, name);

    return valve
  }


  _configureValveService(irrigationAccessory, valveService) {
    this.log.debug("Configure Valve service", valveService.getCharacteristic(Characteristic.Name).value);

    // Configure Valve Service
    valveService
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValveValue.bind(this, valveService, "ValveActive"))
      .on('set', this._setValveActive.bind(this, irrigationAccessory, valveService, "ValveActive"));

    valveService
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValveValue.bind(this, valveService, "ValveInUse"));

    valveService
      .getCharacteristic(Characteristic.SetDuration)
      .on('get', this._getValveValue.bind(this, valveService, "ValveSetDuration"))
      .on('set', this._setValveSetDuration.bind(this, valveService, "ValveSetDuration"));

    valveService
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValveValue.bind(this, valveService, "ValveRemainingDuration"));

  }


  _getDeviceValue(irrigationSystemService, characteristicName, callback) {

    this.log.debug("_getValue", irrigationSystemService.getCharacteristic(Characteristic.Name).value, characteristicName);

    this._refreshDevicesStatus();

    switch (characteristicName) {

      case "DeviceActive":
        this.log.debug("DeviceActive =", irrigationSystemService.getCharacteristic(Characteristic.Active).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.Active).value);
        break;

      case "DeviceProgramMode":
        this.log.debug("DeviceProgramMode =", irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value);
        break;

      case "DeviceInUse":
        this.log.debug("DeviceInUse =", irrigationSystemService.getCharacteristic(Characteristic.InUse).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.InUse).value);
        break;

      case "DeviceRemainingDuration":
        this.log.debug("DeviceRemainingDuration =", irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value);
        break;

      default:
        this.log.debug("Unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }

  }


  _getValveValue(valveService, characteristicName, callback) {

    this.log.debug("_getValue", valveService.getCharacteristic(Characteristic.Name).value, characteristicName);

    this._refreshDevicesStatus();

    switch (characteristicName) {
      case "ValveActive":
        this.log.debug("ValveActive =", valveService.getCharacteristic(Characteristic.Active).value);
        callback(null, valveService.getCharacteristic(Characteristic.Active).value);
        break;

      case "ValveInUse":
        this.log.debug("ValveInUse =", valveService.getCharacteristic(Characteristic.Active).value);
        callback(null, valveService.getCharacteristic(Characteristic.InUse).value);
        break;

      case "ValveSetDuration":
        this.log.debug("ValveSetDuration =", valveService.getCharacteristic(Characteristic.SetDuration).value);
        callback(null, valveService.getCharacteristic(Characteristic.SetDuration).value);
        break;

      case "ValveRemainingDuration":
        this.log.debug("ValveRemainingDuration =", valveService.getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, valveService.getCharacteristic(Characteristic.RemainingDuration).value);
        break;

      default:
        this.log.debug("Unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }

  }


  _login(callback) {
    this.log.info("Login to API to get user_id and token");

    // log us in
    request.post({
      url: "https://api.orbitbhyve.com/v1/session",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "orbit-api-key": "null",
        "orbit-app-id": "Orbit Support Dashboard"
      },
      json: {
        "session": {
          "email": this.email,
          "password": this.password
        }
      },
    }, function (err, response, body) {
      if (!err && response.statusCode == 200) {

        // Save user_id and orbit_api_key
        this.user = body['user_id'];
        this.token = body['orbit_api_key'];
        this.log.info('Logged into Orbit API with user_id =', this.user, ', orbit_api_key =', this.token);
        callback();
      } else {
        this.log.error('Failed to login to Orbit API');
      }
    }.bind(this));
  }


  _fetchDevices() {
    this.log.debug("Fetch the devices");

    // Get the device details
    request.get({
      url: "https://api.orbitbhyve.com/v1/devices",
      headers: {
        "Accept": "application/json",
        "orbit-app-id": "Orbit Support Dashboard",
        "orbit-api-key": this.token
      }
    }, function (err, response, body) {
      if (!err && (!response || response.statusCode == 200)) {
        let jsonBody = JSON.parse(body);
        jsonBody.forEach(function (result) {
          if (result['type'] == "sprinkler_timer") {
            this.log.debug("Found sprinkler '" + result['name'] + "' with id " + result['id']);

            // Generate irrigation service uuid
            let uuid = UUIDGen.generate(result['id']);

            if (this.accessories[uuid]) {
              this.log.debug('Device already exists in accessory cache');
            }
            else {
              this.log.debug('Creating and configuring new device');

              // Create and configure Irrigation Service
              let irrigationAccessory = this._createIrrigationAccessory(uuid, result['id'], result['name'], result['hardware_version'], result['firmware_version'], result['is_connected'], result['status']['runmode']);
              this._configureIrrigationService(irrigationAccessory.getService(Service.IrrigationSystem));

              // Create and configure Values services and link to Irrigation Service
              result['zones'].forEach(function (zone) {
                let valveService = this._createValveService(zone['station'], zone['name']);
                this._configureValveService(irrigationAccessory, valveService);
                irrigationAccessory.getService(Service.IrrigationSystem).addLinkedService(valveService);
                irrigationAccessory.addService(valveService);
              }.bind(this));

              // Register platform accessory
              this.log.debug('Registering platform accessory')
              this.api.registerPlatformAccessories(PluginName, PlatformName, [irrigationAccessory]);
              this.accessories[uuid] = irrigationAccessory;
            }
          }
        }.bind(this));
      } else {
        this.log('Failed to get devices');
      }
    }.bind(this));
  }


  _refreshDevicesStatus() {

    if (this.refreshDevice) {
      this.log.debug("_refreshDevicesStatus");

      this.refreshDevice = false;

      request.get({
        url: "https://api.orbitbhyve.com/v1/devices",
        headers: {
          "Accept": "application/json",
          "orbit-app-id": "Orbit Support Dashboard",
          "orbit-api-key": this.token
        }
      }, function (err, response, body) {

        if (!err && (!response || response.statusCode == 200)) {
          let jsonBody = JSON.parse(body);

          // for each device found check it matches the one we are looking for
          jsonBody.forEach(function (result) {
            this.log.debug("Found device with id " + result['id']);
            let accessory = this.accessories[UUIDGen.generate(result['id'])];
            let irrigationSystemService = accessory.getService(Service.IrrigationSystem);

            // Mark device as active
            irrigationSystemService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);

            // Check if the device is connected
            if (result['is_connected'] == true) {
              irrigationSystemService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.NO_FAULT);
            }
            else {
              irrigationSystemService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.GENERAL_FAULT);
            }

            // Set the Program Mode
            switch (result['status']['run_mode']) {
              case "auto":
                irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);
                break;

              case "manual":
                irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
                break;

              case "off":
                irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
                break;
            }

            if (result['status']['watering_status']) {
              // If the water is running
              this.log.debug("Water is running in " + result['status']['run_mode'] + " mode");

              // Calculate the RemainingDuration & SetDuration
              let currentTime = new Date();
              let startTime = new Date(result['status']['watering_status']['started_watering_station_at']);
              let setDuration = 0;
              if (result['status']['watering_status']['stations'][0]['run_time']) {
                setDuration = (result['status']['watering_status']['stations'][0]['run_time'] * 60);
              }
              startTime.setSeconds(startTime.getSeconds() + setDuration);
              let remainingDuration = Math.round((startTime.getTime() - currentTime.getTime()) / 1000);

              irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
              irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).updateValue(remainingDuration);

              // Find the valve Services
              accessory.services.forEach(function (service) {
                if (Service.Valve.UUID === service.UUID) {

                  // Configure Valve Services
                  if (service.getCharacteristic(Characteristic.ServiceLabelIndex).value == result['status']['watering_status']['stations'][0]['station']) {
                    service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
                    service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                    service.getCharacteristic(Characteristic.SetDuration).updateValue(setDuration);
                    service.getCharacteristic(Characteristic.RemainingDuration).updateValue(remainingDuration);
                  }
                  else {
                    service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                    service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                    service.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                  }
                }
              }.bind(this));
            }
            else {
              // If the water is not running
              this.log.debug("Water is NOT running");
              irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);

              // Find the valve Services and clear InUse characteristic
              accessory.services.forEach(function (service) {
                if (Service.Valve.UUID === service.UUID) {
                  service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                }
              })
            }
          }.bind(this));
        }
      }.bind(this));

      setTimeout(function () {
        this.refreshDevice = true;
        this.log.debug("Set refreshDevice = true");
      }.bind(this), 5000);
    }

  }


  _setValveSetDuration(valveService, CharacteristicName, value, callback) {
    this.log.debug("_setValue", valveService.getCharacteristic(Characteristic.Name).value, CharacteristicName, value);

    // Update the value run duration
    this.log.info("Set valve", valveService.getCharacteristic(Characteristic.Name).value, " duration to ", value);
    valveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);
    callback();
  }


  _setValveActive(irrigationAccessory, valveService, CharacteristicName, value, callback) {
    this.log.debug("_setValue", valveService.getCharacteristic(Characteristic.Name).value, CharacteristicName, value);

    // Create objects and id for easy reference
    let irrigationSystemService = irrigationAccessory.getService(Service.IrrigationSystem);
    let deviceId = irrigationAccessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value;
    let valueId = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;

    // Prepare message for API
    let message = "";
    let run_time = valveService.getCharacteristic(Characteristic.SetDuration).value / 60;
    if (value == Characteristic.Active.ACTIVE) {
      // Turn on the valve
      this.log.info("Activate valve", valveService.getCharacteristic(Characteristic.Name).value);
      message = '{"event":"change_mode","device_id":"' + deviceId + '","stations":[{"station":' + valueId + ',"run_time":' + run_time + '}],"mode":"manual"}';
    } else {
      // Turn off the valve
      this.log.info("Deactivate valve", valveService.getCharacteristic(Characteristic.Name).value);
      message = '{"event":"skip_active_station","device_id":"' + deviceId + '"}';
    }
    callback();

    // Open the WebSocket connection and send the message
    this.log.debug("Connecting to the B-Hyve Events WebSockets API...");
    let ws = new WebSocket("wss://api.orbitbhyve.com/v1/events");
    ws.on('open', function open() {
      this.log.debug("Connected");
      ws.send('{"event":"app_connection","orbit_session_token":"' + this.token + '","subscribe_device_id":"' + deviceId + '"}');
      ws.send(message);
      this.log.debug("Message sent: ", message);
    }.bind(this));

    // Incoming data
    ws.on('message', function incoming(data) {
      let jsonData = JSON.parse(data);

      switch (jsonData['event']) {

        case "watering_in_progress_notification":
          this.log.debug("Watering_in_progress_notification Station", jsonData['current_station'], "Runtime", jsonData['run_time']);

          // Update Irrigation System Service
          irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
          irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);

          // Find the valve Services
          irrigationAccessory.services.forEach(function (service) {
            if (Service.Valve.UUID === service.UUID) {

              // Update Valve Services
              if (service.getCharacteristic(Characteristic.ServiceLabelIndex).value == jsonData['current_station']) {
                service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.ACTIVE);
                service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                service.getCharacteristic(Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);
              } else {
                service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.INACTIVE);
                service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              }
            }
          });
          break;

        case "watering_complete":
          this.log.debug("Watering_complete");
          irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
          valveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
          break;

        case "change_mode":
          this.log.debug("Change_mode", jsonData['mode']);
          switch (jsonData['mode']) {
            case "auto":
              irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);
              break;
            case "manual":
              irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
              break;
            case "off":
              irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
              break;
          }
          break;

        case "program_changed":
          this.log.debug("Program_change - do nothing");
          break;

        default:
          this.log.warn("Message received: " + jsonData['event']);
          break;
      }
    }.bind(this));
    ws.on('close', function clear() {
      this.log.debug("Disconnected");
    }.bind(this));
  }

}

module.exports = PlatformOrbit;