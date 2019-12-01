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

  configureAccessory(accessory) {
    // Configure handlers for cache accessories
    this.log('Remembered accessory, configuring handlers', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;

    // Configure Irrigation Service
    this._configureIrrigationService(accessory);

    accessory.services.forEach(function (service) {
      //this.log.debug(service);

      if (Service.Valve.UUID === service.UUID){

        // Configure Valve Services
        this._configureValve(service);
      }
    }.bind(this));
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
        this.user = body['user_id'];
        this.token = body['orbit_api_key'];
        this.log.info('Logged into Orbit BHyve API with user_id =', this.user, ', orbit_api_key =', this.token);
        callback();
      } else {
        this.log.error('Failed to login to Orbit BHyve API');
      }
    }.bind(this));
  }

  _fetchDevices() {
    this.log.debug("Fetch the devices");

    // Get the device details
    request.get({
      url: "https://api.orbitbhyve.com/v1/devices?user_id=" + this.user,
      headers: {
        "Accept": "application/json",
        "orbit-api-key": this.token,
        "orbit-app-id": "Orbit Support Dashboard"
      }
    }, function (err, response, body) {
      if (!err && response.statusCode == 200) {
        body = JSON.parse(body);
        body.forEach(function (result) {
          if (result['type'] == "sprinkler_timer") {
            this.log.info("Found sprinkler '" + result['name'] + "' with id " + result['id']);

            // Generate irrigation service uuid
            var uuid = UUIDGen.generate(result['id']);

            if (this.accessories[uuid]) {
              this.log.info('Device already exists in cache');
            }
            else {
              this.log.info('Creating and configuring new device');

              // Create and configure Irrigation Service
              var newAccessory = this._createIrrigationService(uuid, result['name'], result['name'], result['firmware_version'], result['is_connected'], result['status']['runmode']);
              this._configureIrrigationService(newAccessory);

              // Create and configure Values services and link to Irrigation Service
              result['zones'].forEach(function (zone) {
                var valve = this._createValve(zone['name'], zone['station']);
                this._configureValve(valve);
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

  _createIrrigationService(uuid, name, hardware_version, firmware_version, is_connected, runmode) {
    this.log.debug('Create Irrigation service', name);

    let newAccessory = new Accessory(name, uuid);
    newAccessory.addService(Service.IrrigationSystem, name);
    newAccessory.updateReachability(true);

    // Check if the device is connected
    if (is_connected == true) {
      newAccessory.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } else {
      newAccessory.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }

    // Set the Program Mode
    switch (runmode) {
      case "auto":
        newAccessory.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED);
        break;
      case "manual":
        newAccessory.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
        break;
      case "off":
        newAccessory.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
        break;
    }

    // Create AccessoryInformation Service
    newAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return newAccessory;
  }

  _configureIrrigationService(newAccessory) {
    this.log.debug('Configure Irrigation service', newAccessory.getService(Service.IrrigationSystem).getCharacteristic(Characteristic.Name).value)

    // Create IrrigationSystem Service
    newAccessory.getService(Service.IrrigationSystem)
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);

    newAccessory.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getDevice.bind(this, "DeviceActive"));
    //on('set', this._setValue.bind(this, "DeviceActive"));

    newAccessory.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.ProgramMode)
      .on('get', this._getDevice.bind(this, "DeviceProgramMode"));

    newAccessory.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getDevice.bind(this, "DeviceInUse"));
    //.on('set', this._setValue.bind(this, "DeviceInUse"));

    newAccessory.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getDevice.bind(this, "DeviceRemainingDuration"));
  }

  _createValve(name, id) {
    this.log.debug("Create Valve service '" + name + "' with id " + id);
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

  _configureValve(valve, id) {
    this.log.debug("Configure Valve service", valve.getCharacteristic(Characteristic.Name).value);

    var id = valve.getCharacteristic(Characteristic.ServiceLabelIndex).value;

    valve
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValve.bind(this, "ValveActive", id));
    //.on('set', this._setValue.bind(this, "ValveActive", id));

    valve
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValve.bind(this, "ValveInUse", id));
    //.on('set', this._setValue.bind(this, "ValveInUse", id));

    valve
      .getCharacteristic(Characteristic.SetDuration)
      .on('get', this._getValve.bind(this, "ValveSetDuration", id));
    //.on('set', this._setValue.bind(this, "ValveSetDuration", id));

    valve
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValve.bind(this, "ValveRemainingDuration", id));
  }

  _getDevice(CharacteristicName, callback) {
    this.log.debug("getDevice", CharacteristicName);
    switch (CharacteristicName) {
      case "DeviceActive":
        callback(null, Characteristic.Active.ACTIVE);
        break;
      case "DeviceProgramMode":
        callback(null, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
        break;
      case "DeviceInUse":
        callback(null, Characteristic.InUse.NOT_IN_USE);
        break;
      case "DeviceRemainingDuration":
        callback(null, 0);
        break;
      default:
        this.log("Unknown CharacteristicName called", CharacteristicName);
        callback();
        break;
    }
  }

  _getValve(CharacteristicName, stationId, callback) {
    this.log.debug("getValve", stationId, CharacteristicName);
    switch (CharacteristicName) {
      case "ValveActive":
        callback(null, Characteristic.Active.INACTIVE);
        break;
      case "ValveInUse":
        callback(null, Characteristic.InUse.NOT_IN_USE);
        break;
      case "ValveSetDuration":
        callback(null, 0);
        break;
      case "ValveRemainingDuration":
        callback(null, 0);
        break;
      default:
        this.log("Unknown CharacteristicName called", CharacteristicName);
        callback();
        break;
    }
  }

  _getValue2(CharacteristicName, stationId, callback) {
    this.log("GET Station", stationId, CharacteristicName);
    switch (CharacteristicName) {
      case "!DeviceActive":
        // Get the device details
        request.get({
          url: "https://api.orbitbhyve.com/v1/devices?user_id=" + this.user,
          headers: {
            "Accept": "application/json",
            "orbit-api-key": this.token,
            "orbit-app-id": "Orbit Support Dashboard"
          }
        }, function (err, response, body) {
          if (!err && response.statusCode == 200) {
            body = JSON.parse(body);
            body.forEach(function (result) {
              if (result['type'] == "sprinkler_timer") {
                this.id = result['id'];
                this.log("Found sprinkler '" + this.name + "' with id " + result['id'] + " and state " + result['status']['watering_status']);

                // If the water is running
                if (result['status']['watering_status']) {
                  this.log("Water is running in " + result['status']['run_mode'] + " mode");
                  // Try / catch statement will catch us when the API is down
                  try {
                    // Calculate the RemainingDuration & SetDuration
                    var time_current = new Date();
                    var time_remaining = new Date(result['status']['watering_status']['started_watering_station_at']);
                    time_remaining.setSeconds(time_remaining.getSeconds() + (result['status']['watering_status']['stations'][0]['run_time'] * 60));
                    var tempRemainingDuration = Math.round((time_remaining.getTime() - time_current.getTime()) / 1000);
                    for (var i = 1; i <= this.zones; i++) {
                      if (i == result['status']['watering_status']['stations'][0]['station']) {
                        this.Valve[i].getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
                        this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                        this.Valve[i].getCharacteristic(Characteristic.RemainingDuration).updateValue(tempRemainingDuration);
                      } else {
                        this.Valve[i].getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                        this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                        this.Valve[i].getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                      }
                    }
                  } catch (err) {
                    this.log("Could not find calculate the remaining duration, assuming default duration");
                  }
                }
                // If the water is not running
                else {
                  this.log("Water is NOT running");
                  for (var i = 1; i <= this.zones; i++) {
                    this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                    // Set the preferred run Duration
                    //if(result['manual_preset_runtime_sec'] != 0) {
                    //	this.Valve[i].getCharacteristic(Characteristic.SetDuration).updateValue(result['manual_preset_runtime_sec']);
                    //}
                  }
                }
              }
            }.bind(this));
          } else {
            this.log("Could not get Orbit B-Hyve device details");
          }
        }.bind(this));
        callback(null, Characteristic.Active.ACTIVE);
        break;
      case "DeviceProgramMode":
        this.log("DeviceProgramMode =", this.IrrigationSystem.getCharacteristic(Characteristic.ProgramMode).value);
        callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.ProgramMode).value);
        break;
      case "DeviceActive":
        //this.log("DeviceActive =", this.IrrigationSystem.getCharacteristic(Characteristic.Active).value);
        //callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.Active).value);
        callback(null, Characteristic.Active.ACTIVE);
        break;
      case "DeviceInUse":
        this.log("DeviceInUse =", this.IrrigationSystem.getCharacteristic(Characteristic.InUse).value);
        callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.InUse).value);
        break;
      case "DeviceRemainingDuration":
        this.log("DeviceRemainingDuration =", this.IrrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
        break;
      case "ValveActive":
        this.log("ValveActive =", this.Valve[stationId].getCharacteristic(Characteristic.Active).value);
        callback(null, this.Valve[stationId].getCharacteristic(Characteristic.Active).value);
        break;
      case "ValveInUse":
        this.log("ValveInUse =", this.Valve[stationId].getCharacteristic(Characteristic.InUse).value);
        callback(null, this.Valve[stationId].getCharacteristic(Characteristic.InUse).value);
        break;
      case "ValveSetDuration":
        this.log("ValveSetDuration =", this.Valve[stationId].getCharacteristic(Characteristic.SetDuration).value);
        callback(null, this.Valve[stationId].getCharacteristic(Characteristic.SetDuration).value);
        break;
      case "ValveRemainingDuration":
        this.log("ValveRemainingDuration =", this.Valve[stationId].getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, this.Valve[stationId].getCharacteristic(Characteristic.RemainingDuration).value);
        break;
      default:
        this.log("Unknown CharacteristicName called", CharacteristicName);
        callback();
        break;
    }
  }

  _setValue2(CharacteristicName, stationId, value, callback) {
    this.log("SET", CharacteristicName, "Value", value, "Station", stationId);
    switch (CharacteristicName) {
      case "DeviceActive":
        callback();
        break;
      case "ValveActive":
        var message = "";
        run_time = this.Valve[stationId].getCharacteristic(Characteristic.SetDuration).value / 60;
        if (value == Characteristic.Active.ACTIVE) {
          message = '{"event":"change_mode","device_id":"' + this.id + '","stations":[{"station":' + stationId + ',"run_time":' + run_time + '}],"mode":"manual"}';
        } else {
          message = '{"event":"skip_active_station","device_id":"' + this.id + '"}';
        }
        callback();
        // Load the WebSocket connection
        this.log("WS | Connecting to the B-Hyve Events WebSockets API...");
        ws = new WebSocket("wss://api.orbitbhyve.com/v1/events");
        ws.on('open', function open() {
          this.log("WS | Connected");
          ws.send('{"event":"app_connection","orbit_session_token":"' + this.token + '","subscribe_device_id":"' + this.id + '"}');
          ws.send(message);
          this.log("WS | Message sent: ", message);
        }.bind(this));
        ws.on('message', function incoming(data) {
          this.log("WS | Message received: " + data);
          data = JSON.parse(data);
          switch (data['event']) {
            case "watering_in_progress_notification":
              this.log("WS | watering_in_progress_notification Station", data['current_station'], "Runtime", data['run_time']);
              this.IrrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
              this.IrrigationSystem.getCharacteristic(Characteristic.RemainingDuration).updateValue(data['run_time'] * 60);
              // Reset status
              for (var i = 1; i <= this.zones; i++) {
                if (i == data['current_station']) {
                  this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.ACTIVE);
                  this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                  this.Valve[i].getCharacteristic(Characteristic.RemainingDuration).updateValue(data['run_time'] * 60);
                } else {
                  this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.INACTIVE);
                  this.Valve[i].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                }
              }
              break;
            case "watering_complete":
              this.log("WS | watering_complete");
              this.IrrigationSystem.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              this.Valve[stationId].getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              break;
              break;
            case "change_mode":
              this.log("WS | change_mode");
              switch (data['mode']) {
                case "auto":
                  this.IrrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);
                  break;
                case "manual":
                  this.IrrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
                  break;
                case "off":
                  this.IrrigationSystem.getCharacteristic(Characteristic.ProgramMode).updateValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
                  break;
              }
              break;
            case "program_changed":
              this.log("WS | program_change - do nothing");
              break;
            default:
              this.log("WS | Unknown WS message received");
              this.log("WS | Message received: " + data);
              break;
          }
        }.bind(this));
        ws.on('close', function clear() {
          this.log("WS | Disconnected");
        }.bind(this));
        break;
      case "ValveSetDuration":
        this.Valve[stationId].getCharacteristic(Characteristic.SetDuration).updateValue(value);
        callback();
        break;
      default:
        this.log("Unknown CharacteristicName called", CharacteristicName);
        callback();
        break;
    }
  }
}

module.exports = PlatformOrbit;