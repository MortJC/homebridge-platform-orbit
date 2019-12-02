const PluginName = 'homebridge-platform-orbit';
const PlatformName = 'orbit';
const request = require("request");
const WebSocket = require("ws");
const cache = require('memory-cache');

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
    this.memCache = new cache.Cache();

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
    this._cachedDevicesRequest(function (err, response, body) {
      if (!err && (!response || response.statusCode == 200)) {
        let jsonBody = JSON.parse(body);
        jsonBody.forEach(function (result) {
          if (result['type'] == "sprinkler_timer") {
            this.log.debug("Found sprinkler '" + result['name'] + "' with id " + result['id']);

            // Generate irrigation service uuid
            var uuid = UUIDGen.generate(result['id']);

            if (this.accessories[uuid]) {
              this.log.debug('Device already exists in accessory cache');
            }
            else {
              this.log.debug('Creating and configuring new device');

              // Create and configure Irrigation Service
              var newAccessory = this._createIrrigationService(uuid, result['id'], result['name'], result['hardware_version'], result['firmware_version'], result['is_connected'], result['status']['runmode']);
              this._configureIrrigationService(newAccessory, result['id']);

              // Create and configure Values services and link to Irrigation Service
              result['zones'].forEach(function (zone) {
                var valve = this._createValveService(zone['station'], zone['name']);
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
    let irigationSystem = new Accessory(name, uuid);
    irigationSystem.addService(Service.IrrigationSystem, name);
    irigationSystem.updateReachability(true);

    // Check if the device is connected
    if (is_connected == true) {
      irigationSystem.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } else {
      irigationSystem.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }

    // Set the Program Mode
    switch (runmode) {
      case "auto":
        irigationSystem.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED);
        break;
      case "manual":
        irigationSystem.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
        break;
      case "off":
        irigationSystem.getService(Service.IrrigationSystem).setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
        break;
    }

    // Create AccessoryInformation Service
    irigationSystem.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return irigationSystem;
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
    //on('set', this._setValue.bind(this, id, 0, "DeviceActive"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValue.bind(this, id, 0, "DeviceInUse"));
    //.on('set', this._setValue.bind(this, id, 0, "DeviceInUse"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.ProgramMode)
      .on('get', this._getValue.bind(this, id, 0, "DeviceProgramMode"));

    irrigationSystem.getService(Service.IrrigationSystem)
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValue.bind(this, id, 0, "DeviceRemainingDuration"));
  }

  _createValveService(id, name) {
    this.log.debug("Create Valve service" + name + " with id " + id);

    // Create Vavle Service
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
      .on('get', this._getValue.bind(this, deviceId, id, "ValveActive"));
    //.on('set', this._setValue.bind(this, "ValveActive", id));

    valve
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveInUse"));
    //.on('set', this._setValue.bind(this, deviceId, id, "ValveInUse"));

    valve
      .getCharacteristic(Characteristic.SetDuration)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveSetDuration"));
    //.on('set', this._setValue.bind(this, deviceId, id, "ValveSetDuration"));

    valve
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValue.bind(this, deviceId, id, "ValveRemainingDuration"));
  }

  _getValue(deviceId, valveId, characteristicName, callback) {

    this.log.debug("GET getValue", deviceId, valveId, characteristicName);

    switch (characteristicName) {

      case "DeviceActive":
        this.log.debug("DeviceActive = ACTIVE");
        callback(null, Characteristic.Active.ACTIVE);
        break;

      case "DeviceProgramMode":
        this.log.debug("DeviceProgramMode = PROGRAM_SCHEDULED");
        callback(null, Characteristic.ProgramMode.PROGRAM_SCHEDULED);
        break;

      case "DeviceInUse":
        this.log.debug("DeviceInUse = NOT_IN_USE");
        callback(null, Characteristic.InUse.NOT_IN_USE);
        break;

      case "DeviceRemainingDuration":
        this.log.debug("DeviceRemainingDuration = 0");
        callback(null, 0);
        //callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
        break;

      case "ValveActive":
        this.log.debug("ValveActive = INACTIVE");
        callback(null, Characteristic.Active.INACTIVE);
        //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.Active).value);
        break;

      case "ValveInUse":
        this.log.debug("ValveInUse = NOT_IN_USE");
        callback(null, Characteristic.InUse.NOT_IN_USE);
        //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.InUse).value);
        break;

      case "ValveSetDuration":
        this.log.debug("ValveSetDuration = 0");
        callback(null, 0);
        //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.SetDuration).value);
        break;

      case "ValveRemainingDuration":
        this.log.debug("ValveRemainingDuration = 0");
        callback(null, 0);
        //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.RemainingDuration).value);
        break;

      default:
        this.log.debug("Unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }
  }

  _getValue2(deviceId, valveId, characteristicName, callback) {

    this.log.debug("GET getValue", deviceId, valveId, characteristicName);

    this._cachedDevicesRequest(function (err, response, body) {

      if (!err && (!response || response.statusCode == 200)) {
        let jsonBody = JSON.parse(body);

        // for each device found check it matches the one we are looking for
        jsonBody.forEach(function (result) {
          if (result['id'] == deviceId) {
            this.log.debug("Found device with id " + result['id']);

            switch (characteristicName) {

              case "DeviceActive":
                this.log.debug("DeviceActive = ACTIVE");
                callback(null, Characteristic.Active.ACTIVE);
                break;

              case "DeviceProgramMode":
                switch (result['status']['runmode']) {
                  case "auto":
                    this.log.debug("DeviceProgramMode = PROGRAM_SCHEDULED");
                    callback(null, Characteristic.ProgramMode.PROGRAM_SCHEDULED);
                    break;
                  case "manual":
                    this.log.debug("DeviceProgramMode = PROGRAM_SCHEDULED_MANUAL_MODE_");
                    callback(null, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
                    break;
                  case "off":
                    this.log.debug("DeviceProgramMode = NO_PROGRAM_SCHEDULED");
                    callback(null, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
                    break;
                }
                break;

              case "DeviceInUse":
                if (result['status']['watering_status']) {
                  this.log.debug("DeviceInUse = IN_USE");
                  callback(null, Characteristic.InUse.IN_USE);
                }
                else {
                  this.log.debug("DeviceInUse = NOT_IN_USE");
                  callback(null, Characteristic.InUse.NOT_IN_USE);
                }
                break;

              case "DeviceRemainingDuration":
                this.log.debug("DeviceRemainingDuration = 0");
                callback(null, 0);
                //callback(null, this.IrrigationSystem.getCharacteristic(Characteristic.RemainingDuration).value);
                break;

              case "ValveActive":
                this.log.debug("ValveActive = INACTIVE");
                callback(null, Characteristic.Active.INACTIVE);
                //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.Active).value);
                break;

              case "ValveInUse":
                this.log.debug("ValveInUse = NOT_IN_USE");
                callback(null, Characteristic.InUse.NOT_IN_USE);
                //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.InUse).value);
                break;

              case "ValveSetDuration":
                this.log.debug("ValveSetDuration = 0");
                callback(null, 0);
                //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.SetDuration).value);
                break;

              case "ValveRemainingDuration":
                this.log.debug("ValveRemainingDuration = 0");
                callback(null, 0);
                //callback(null, this.Valve[valveId].getCharacteristic(Characteristic.RemainingDuration).value);
                break;

              default:
                this.log.debug("Unknown CharacteristicName called", characteristicName);
                callback();
                break;
            }

          }
        }.bind(this));
      } else {
        this.log("Could not get device details");
      }
    }.bind(this));
  }

  _cachedDevicesRequest(callback) {
    let apiUrl = "https://api.orbitbhyve.com/v1/devices";
    let apiHeaders = {
      "Accept": "application/json",
      "orbit-app-id": "Orbit Support Dashboard",
      "orbit-api-key": this.token
    }

    // Get device details using 30 sec cache
    let cacheContent = this.memCache.get(apiUrl);
    if (cacheContent) {
      callback(null, null, cacheContent);
    }
    else {
      request.get({
        url: apiUrl,
        headers: apiHeaders
      }, function (err, response, body) {

        if (!err && response.statusCode == 200) {
          this.memCache.put(apiUrl, body, 300000);
          callback(err, response, body);
        }
      }.bind(this));
    }
  }

  _setValue(CharacteristicName, stationId, value, callback) {
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