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
              let newAccessory = this._createIrrigationService(uuid, result['id'], result['name'], result['hardware_version'], result['firmware_version'], result['is_connected'], result['status']['runmode']);
              this._configureIrrigationService(newAccessory, result['id']);

              // Create and configure Values services and link to Irrigation Service
              result['zones'].forEach(function (zone) {
                let valve = this._createValveService(zone['station'], zone['name']);
                this._configureValveService(valve, result['id'], zone['station']);
                newAccessory.getService(Service.IrrigationSystem).addLinkedService(valve);
                newAccessory.addService(valve);
              }.bind(this));

              // Register platform accessory
              this.log.debug('Registering platform accessory')
              this.api.registerPlatformAccessories(PluginName, PlatformName, [newAccessory]);
              this.accessories[uuid] = newAccessory;
            }
          }
        }.bind(this));
      } else {
        this.log('Failed to get devices');
      }
    }.bind(this));
  }


  configureAccessory(accessory) {
    // Configure handlers for cache accessories
    this.log('Remembered accessory, configuring handlers', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;

    // Configure Irrigation Service
    this._configureIrrigationService(accessory, accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value);

    // Find the valve Services
    accessory.services.forEach(function (service) {
      if (Service.Valve.UUID === service.UUID) {

        // Configure Valve Service
        this._configureValveService(service, accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value, service.getCharacteristic(Characteristic.ServiceLabelIndex).value);
      }
    }.bind(this));
  }


  _createIrrigationService(uuid, id, name, hardware_version, firmware_version, is_connected, runmode) {
    this.log.debug('Create Irrigation service', id);

    // Create new Irrigation System Service
    let newAccessory = new Accessory(name, uuid);
    newAccessory.addService(Service.IrrigationSystem, name);
    newAccessory.updateReachability(true);
    let irrigationSystem = newAccessory.getService(Service.IrrigationSystem)

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
    irrigationSystem.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return irrigationSystem;
  }


  _configureIrrigationService(irrigationSystem, id) {
    this.log.debug('Configure Irrigation service', id, irrigationSystem.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Name).value)

    // Configure IrrigationSystem Service
    irrigationSystem.getService(Service.IrrigationSystem)
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValue.bind(this, id, 0, "DeviceActive"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValue.bind(this, id, 0, "DeviceInUse"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.ProgramMode)
      .on('get', this._getValue.bind(this, id, 0, "DeviceProgramMode"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValue.bind(this, id, 0, "DeviceRemainingDuration"));
  }


  _createValveService(id, name) {
    this.log.debug("Create Valve service" + name + " with id " + id);

    // Create Valve Service
    let valve = new Service.Valve(name, id);
    valve
      .setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
      .setCharacteristic(Characteristic.SetDuration, 60)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.ServiceLabelIndex, id)
      .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
      .setCharacteristic(Characteristic.Name, name);

    return valve
  }


  _configureValveService(valve, deviceId, id) {
    this.log.debug("Configure Valve service", deviceId, id, valve.getCharacteristic(Characteristic.Name).value);

    // Configure Valve Service
    valve
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveActive"))
      .on('set', this._setValue.bind(this, deviceId, id, "ValveActive"));

    valve
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveInUse"));

    valve
      .getCharacteristic(Characteristic.SetDuration)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveSetDuration"))
      .on('set', this._setValue.bind(this, deviceId, id, "ValveSetDuration"));

    valve
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveRemainingDuration"));

  }


  _getValue(deviceId, valveId, characteristicName, callback) {

    this.log.debug("_getValue", deviceId, valveId, characteristicName);

    let accessory = this.accessories[UUIDGen.generate(deviceId)];
    let irrigationSystem = accessory.getService(Service.IrrigationSystem);
    if (valveId > 0) {
      var valveService = accessory.getServiceByUUIDAndSubType(Service.Valve, valveId);
    }

    switch (characteristicName) {

      case "DeviceActive":

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
              if (result['id'] == deviceId) {
                this.log.debug("Found device with id " + result['id']);

                // Check if the device is connected
                if (result['is_connected'] == true) {
                  irrigationSystem.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.NO_FAULT);
                }
                else {
                  irrigationSystem.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.GENERAL_FAULT);
                }

                // Set the Program Mode
                switch (result['status']['run_mode']) {
                  case "auto":
                    irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);
                    break;

                  case "manual":
                    irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
                    break;

                  case "off":
                    irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
                    break;
                }

                if (result['status']['watering_status']) {
                  // If the water is running
                  this.log.debug("Water is running in " + result['status']['run_mode'] + " mode");

                  // Calculate the RemainingDuration & SetDuration
                  let currentTime = new Date();
                  let startTime = new Date(result['status']['watering_status']['started_watering_station_at']);
                  let setDuration = (result['status']['watering_status']['stations'][0]['run_time'] * 60);
                  startTime.setSeconds(startTime.getSeconds() + setDuration);
                  let remainingDuration = Math.round((startTime.getTime() - currentTime.getTime()) / 1000);

                  irrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                  irrigationSystem.getCharacteristic(Characteristic.RemainingDuration).updateValue(remainingDuration);

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
                  irrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);

                  // Find the valve Services and clear InUse characteristic
                  accessory.services.forEach(function (service) {
                    service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                  })
                }

              }
              this.log.debug("DeviceActive = ACTIVE");
              irrigationSystem.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
              callback(null, Characteristic.Active.ACTIVE);

            }.bind(this));
          } else {
            this.log.warn("Could not get device details");
            this.log.debug("DeviceActive = INACTIVE");
            irrigationSystem.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            callback(null, Characteristic.Active.INACTIVE);
          }
        }.bind(this));
        break;

      case "DeviceProgramMode":
        this.log.debug("DeviceProgramMode =", irrigationSystem.getCharacteristic(Characteristic.ProgramMode).value);
        callback(null, irrigationSystem.getCharacteristic(Characteristic.ProgramMode).value);
        break;

      case "DeviceInUse":
        this.log.debug("DeviceInUse =", irrigationSystem.getCharacteristic(Characteristic.InUse).value);
        callback(null, irrigationSystem.getCharacteristic(Characteristic.InUse).value);
        break;

      case "DeviceRemainingDuration":
        this.log.debug("DeviceRemainingDuration =", irrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, irrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
        break;

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


  _setValue(deviceId, valveId, CharacteristicName, value, callback) {
    this.log.debug("_setValue", valveId, CharacteristicName, value);

    let accessory = this.accessories[UUIDGen.generate(deviceId)];
    let irrigationSystem = accessory.getService(Service.IrrigationSystem);
    if (valveId > 0) {
      var valveService = accessory.getServiceByUUIDAndSubType(Service.Valve, valveId);
    }

    switch (CharacteristicName) {

      case "ValveSetDuration":
        // Update the value run duration
        this.log.info("Set valve", valveId, " duration to ", value);
        valveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);
        callback();
        break;

      case "ValveActive":
        // Prepare message for API
        let message = "";
        let run_time = valveService.getCharacteristic(Characteristic.SetDuration).value / 60;
        if (value == Characteristic.Active.ACTIVE) {
          // Turn on the valve
          this.log.info("Activate valve", valveId);
          message = '{"event":"change_mode","device_id":"' + deviceId + '","stations":[{"station":' + valveId + ',"run_time":' + run_time + '}],"mode":"manual"}';
        } else {
          // Turn off the valve
          this.log.info("Deactivate valve", valveId);
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
              irrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
              irrigationSystem.getCharacteristic(Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);

              // Find the valve Services
              accessory.services.forEach(function (service) {
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
              irrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              valveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              break;

            case "change_mode":
              this.log.debug("Change_mode", jsonData['mode']);
              switch (jsonData['mode']) {
                case "auto":
                  irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);
                  break;
                case "manual":
                  irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
                  break;
                case "off":
                  irrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
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
        break;

      default:
        this.log.warn("Unknown CharacteristicName set =", CharacteristicName);
        callback();
        break;

    }
  }

}

module.exports = PlatformOrbit;