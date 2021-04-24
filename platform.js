const OrbitAPI = require('./orbitapi.js');

class PlatformOrbit {


  constructor(log, config, api) {
    this.log = log;
    this.config = config;

    if (!config || !config["email"] || !config["password"]) {
      this.log.error("Platform config incorrect or missing. Check the config.json file.");
    }
    else {

      this.email = config["email"];
      this.password = config["password"];
      this.run_time = config["run_time"]
      this.accessories = [];

      this.log('Starting OrbitPlatform using homebridge API', api.version);
      if (api) {

        // save the api for use later
        this.api = api;

        // if finished loading cache accessories
        this.api.on("didFinishLaunching", function () {

          // Fetch the devices
          this._fetchDevices();

        }.bind(this));
      }
    }
  }


  _fetchDevices() {
    this.log.debug("Fetch the devices");

    let orbitAPI = new OrbitAPI(this.log, this.email, this.password);

    // login to the API and get the token
    orbitAPI.getToken()
      .then(function () {

        // get an array of the devices
        orbitAPI.getDevices()
          .then(function (devices) {

            // loop through each device
            devices.forEach(function (device) {

              // Generate irrigation service uuid
              let uuid = UUIDGen.generate(device._id);

              // Check if device is already loaded from cache
              if (this.accessories[uuid]) {
                this.log.debug('Configuring cached device');

                // Configure Irrigation Service
                this._configureIrrigationService(this.accessories[uuid].getService(Service.IrrigationSystem));

                // Find the valve Services
                this.accessories[uuid].services.forEach(function (service) {
                  if (Service.Valve.UUID === service.UUID) {

                    // Configure Valve Service
                    this._configureValveService(device, service);
                  }
                }.bind(this));
              }
              else {
                this.log.debug('Creating and configuring new device');

                // Create and configure Irrigation Service
                let irrigationAccessory = this._createIrrigationAccessory(uuid, device._id, device._name, device._hardware_version, device._firmware_version, device._is_connected);
                this._configureIrrigationService(irrigationAccessory.getService(Service.IrrigationSystem));

                // Create and configure Values services and link to Irrigation Service
                device._zones.forEach(function (zone) {
                  let valveService = this._createValveService(zone['station'], zone['name']);
                  this._configureValveService(device, valveService);
                  irrigationAccessory.getService(Service.IrrigationSystem).addLinkedService(valveService);
                  irrigationAccessory.addService(valveService);
                }.bind(this));

                // Register platform accessory
                this.log.debug('Registering platform accessory');
                this.api.registerPlatformAccessories(PluginName, PlatformName, [irrigationAccessory]);
                this.accessories[uuid] = irrigationAccessory;
              }

              device.openConnection();
              device.onMessage(this._processMessage.bind(this));

              // Send Sync after 2 sec delay
              setTimeout(() => { device.sync(); }, 2000);

            }.bind(this));
          }.bind(this)).catch(function (error) {
            this.log.error('Unable to get devices', error);
          }.bind(this));
      }.bind(this))
      .catch(function (error) {
        this.log.error('Unable to get token', error);
      }.bind(this));
  }


  configureAccessory(accessory) {
    // Added cached devices to the accessories arrary
    this.log('Remembered accessory, configuring handlers', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;
  }


  _createIrrigationAccessory(uuid, id, name, hardware_version, firmware_version, is_connected) {
    this.log.debug('Create Irrigation service', id);

    // Create new Irrigation System Service
    let newPlatformAccessory = new PlatformAccessory(name, uuid);
    newPlatformAccessory.addService(Service.IrrigationSystem, name);
    let irrigationSystemService = newPlatformAccessory.getService(Service.IrrigationSystem);

    // Check if the device is connected
    if (is_connected == true) {
      irrigationSystemService.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } else {
      irrigationSystemService.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }

    // Create AccessoryInformation Service
    newPlatformAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return newPlatformAccessory;
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

    // Use CurrentTime to store the run time ending
    valve.addCharacteristic(Characteristic.CurrentTime);

    return valve
  }


  _configureValveService(device, valveService) {
    this.log.debug("Configure Valve service", valveService.getCharacteristic(Characteristic.Name).value);

    // Configure Valve Service
    valveService
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValveValue.bind(this, valveService, "ValveActive"))
      .on('set', this._setValveActive.bind(this, device, valveService));

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

      default:
        this.log.debug("Unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }

  }


  _getValveValue(valveService, characteristicName, callback) {

    this.log.debug("_getValue", valveService.getCharacteristic(Characteristic.Name).value, characteristicName);

    switch (characteristicName) {
      case "ValveActive":
        this.log.debug("ValveActive =", valveService.getCharacteristic(Characteristic.Active).value);
        callback(null, valveService.getCharacteristic(Characteristic.Active).value);
        break;

      case "ValveInUse":
        this.log.debug("ValveInUse =", valveService.getCharacteristic(Characteristic.InUse).value);
        callback(null, valveService.getCharacteristic(Characteristic.InUse).value);
        break;

      case "ValveSetDuration":
        this.log.debug("ValveSetDuration =", valveService.getCharacteristic(Characteristic.SetDuration).value);
        callback(null, valveService.getCharacteristic(Characteristic.SetDuration).value);
        break;

      case "ValveRemainingDuration":
        // Calc remain duration
        let timeEnding = new Date(parseInt(valveService.getCharacteristic(Characteristic.CurrentTime).value));
        let timeNow = Date.now();
        let timeRemaining = Math.max(Math.round((timeEnding - timeNow) / 1000), 0);
        if (isNaN(timeRemaining)) {
          timeRemaining = 0;
        }
        valveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(timeRemaining);
        this.log.debug("ValveRemainingDuration =", timeRemaining);
        callback(null, timeRemaining);
        break;

      default:
        this.log.debug("Unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }

  }


  _setValveSetDuration(valveService, CharacteristicName, value, callback) {
    this.log.debug("_setValue", valveService.getCharacteristic(Characteristic.Name).value, CharacteristicName, value);

    // Update the value run duration
    this.log.info("Set valve", valveService.getCharacteristic(Characteristic.Name).value, " duration to ", value);
    valveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);
    callback();
  }


  _setValveActive(device, valveService, value, callback) {
    this.log.debug("_setValueActive", valveService.getCharacteristic(Characteristic.Name).value, value);

    // Prepare message for API
    let station = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;
    //let run_time = valveService.getCharacteristic(Characteristic.SetDuration).value / 60;
    let run_time = this.run_time

    if (value == Characteristic.Active.ACTIVE) {
      // Turn on the valve
      this.log.info("Start zone", valveService.getCharacteristic(Characteristic.Name).value, "for", run_time, "mins");
      device.startZone(station, run_time);
    } else {
      // Turn off the valve
      this.log.info("Stop zone", valveService.getCharacteristic(Characteristic.Name).value);
      device.stopZone();
    }
    callback();

  }


  _processMessage(message, device_id) {
    // Incoming data
    let jsonData = JSON.parse(message);

    // Create objects and id for easy reference
    let irrigationAccessory = this.accessories[UUIDGen.generate(device_id)];
    let irrigationSystemService = irrigationAccessory.getService(Service.IrrigationSystem);

    switch (jsonData['event']) {

      case "watering_in_progress_notification":
        this.log.debug("Watering_in_progress_notification Station", jsonData['current_station'], "Runtime", jsonData['run_time']);

        // Update Irrigation System Service
        irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);

        // Find the valve Services
        irrigationAccessory.services.forEach(function (service) {
          if (Service.Valve.UUID === service.UUID) {

            // Update Valve Services
            if (service.getCharacteristic(Characteristic.ServiceLabelIndex).value == jsonData['current_station']) {
              service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
              service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
              service.getCharacteristic(Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);
              service.getCharacteristic(Characteristic.CurrentTime).updateValue(Date.now() + parseInt(jsonData['run_time']) * 60 * 1000); // Store timeEnding
            } else {
              service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
              service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
            }
          }
        });
        break;

      case "watering_complete":
      case "device_idle":
        this.log.debug("Watering_complete or device_idle");

        // Update Irrigation System Service
        irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);

        // Find the valve Services 
        irrigationAccessory.services.forEach(function (service) {

          // Update Valve Service
          if (Service.Valve.UUID === service.UUID) {
            service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
          }
        });
        break;

      case "change_mode":
        this.log.debug("change_mode", jsonData['mode']);

        // Update the ProgramMode
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
        this.log.debug("program_change - do nothing");
        break;

      case "rain_delay":
        this.log.debug("rain_delay - do nothing");
        break;

      case "device_connected":
        this.log.debug("device_connected");
        irrigationSystemService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.NO_FAULT);
        break;

      case "device_disconnected":
        this.log.debug("device_disconnected");
        irrigationSystemService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.GENERAL_FAULT);
        break;

      case "clear_low_battery":
        this.log.debug("clear_low_battery - do nothing");
        break;

      default:
        this.log.warn("Unhandled message received: " + jsonData['event']);
        break;
    }
  }

}

module.exports = PlatformOrbit;