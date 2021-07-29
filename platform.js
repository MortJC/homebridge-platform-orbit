const OrbitAPI = require('./orbitapi.js');

class PlatformOrbit {


  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.timeEnding = [];

    if (!config || !config["email"] || !config["password"]) {
      this.log.error("Platform config incorrect or missing. Check the config.json file.");
    }
    else {

      this.email = config["email"];
      this.password = config["password"];
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
                let irrigationAccessory = new PlatformAccessory(device._name, uuid);
                let irrigationSystemService = this._createIrrigationAccessory(irrigationAccessory, device._id, device._name, device._hardware_version, device._firmware_version, device._is_connected);
                this._configureIrrigationService(irrigationSystemService);

                // Create and configure Values services and link to Irrigation Service
                device._zones.forEach(function (zone) {
                  let valveService = this._createValveService(irrigationAccessory, zone['station'], zone['name']);
                  this._configureValveService(device, valveService);
                  irrigationSystemService.addLinkedService(valveService);
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


  _createIrrigationAccessory(irrigationAccessory, id, name, hardware_version, firmware_version, is_connected) {
    this.log.debug('Create Irrigation service', id);

    // Create new Irrigation System Service
    let irrigationSystemService = irrigationAccessory.addService(Service.IrrigationSystem, name)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED)
      .setCharacteristic(Characteristic.RemainingDuration, 0);

    // Check if the device is connected
    if (is_connected == true) {
      irrigationSystemService.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } else {
      irrigationSystemService.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }

    // Create AccessoryInformation Service
    irrigationAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.Model, hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);

    return irrigationSystemService;
  }


  _configureIrrigationService(irrigationSystemService) {
    this.log.debug('Configure Irrigation service', irrigationSystemService.getCharacteristic(Characteristic.Name).value)

    irrigationSystemService
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getIrrigationSystemValue.bind(this, irrigationSystemService, "Active"))
      .on('set', this._setIrrigationSystemActive.bind(this, irrigationSystemService));

    irrigationSystemService
      .getCharacteristic(Characteristic.ProgramMode)
      .on('get', this._getIrrigationSystemValue.bind(this, irrigationSystemService, "ProgramMode"));

    irrigationSystemService
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getIrrigationSystemValue.bind(this, irrigationSystemService, "InUse"));

    irrigationSystemService
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getIrrigationSystemValue.bind(this, irrigationSystemService, "RemainingDuration"));
  }


  _createValveService(irrigationAccessory, station, name) {
    this.log.debug("Create Valve service " + name + " with station " + station);

    // Create Valve Service
    let valve = irrigationAccessory.addService(Service.Valve, name, station);
    valve
      .setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
      .setCharacteristic(Characteristic.SetDuration, 300)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.ServiceLabelIndex, station)
      .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
      .setCharacteristic(Characteristic.Name, name);

    this.timeEnding[station];

    return valve
  }


  _configureValveService(device, valveService) {
    this.log.debug("Configure Valve service", valveService.getCharacteristic(Characteristic.Name).value);

    // Configure Valve Service
    valveService
      .getCharacteristic(Characteristic.Active)
      .on('get', this._getValveValue.bind(this, valveService, "Active"))
      .on('set', this._setValveActive.bind(this, device, valveService));

    valveService
      .getCharacteristic(Characteristic.InUse)
      .on('get', this._getValveValue.bind(this, valveService, "InUse"));

    valveService
      .getCharacteristic(Characteristic.ValveType)
      .on('get', this._getValveValue.bind(this, valveService, "ValveType"));

    valveService
      .getCharacteristic(Characteristic.SetDuration)
      .on('get', this._getValveValue.bind(this, valveService, "SetDuration"))
      .on('set', this._setValveSetDuration.bind(this, valveService, "SetDuration"));

    valveService
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this._getValveValue.bind(this, valveService, "RemainingDuration"))

  }


  _getIrrigationSystemValue(irrigationSystemService, characteristicName, callback) {

    this.log.debug("_getIrrigationSystemValue", irrigationSystemService.getCharacteristic(Characteristic.Name).value, characteristicName);

    switch (characteristicName) {

      case "Active":
        this.log.debug("IrrigationSystem Active = ", irrigationSystemService.getCharacteristic(Characteristic.Active).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.Active).value);
        break;

      case "ProgramMode":
        this.log.debug("IrrigationSystem ProgramMode = ", irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value);
        break;

      case "InUse":
        this.log.debug("IrrigationSystem InUse = ", irrigationSystemService.getCharacteristic(Characteristic.InUse).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.InUse).value);
        break;

      case "RemainingDuration":
        this.log.debug("IrrigationSystem RemainingDuration = ", irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value);
        callback(null, irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value);
        break;

      default:
        this.log.debug("IrrigationSystem unknown CharacteristicName called", characteristicName);
        callback();
        break;
    }

  }


  _setIrrigationSystemActive(irrigationSystemService, value, callback) {
    this.log.debug("_setIrrigationSystemActive", irrigationSystemService.getCharacteristic(Characteristic.Name).value, value ? "ACTIVE" : "INACTIVE");
    callback();
  }

  _getValveValue(valveService, characteristicName, callback) {

    this.log.debug("_getValveValue", valveService.getCharacteristic(Characteristic.Name).value, characteristicName);

    switch (characteristicName) {
      case "Active":
        this.log.debug("Valve Active = ", valveService.getCharacteristic(Characteristic.Active).value ? "ACTIVE" : "INACTIVE");
        callback(null, valveService.getCharacteristic(Characteristic.Active).value);
        break;

      case "InUse":
        this.log.debug("Valve InUse = ", valveService.getCharacteristic(Characteristic.InUse).value ? "IN_USE" : "NOT_IN_USE");
        callback(null, valveService.getCharacteristic(Characteristic.InUse).value);
        break;

      case "ValveType":
        this.log.debug("Valve ValveType = ", valveService.getCharacteristic(Characteristic.ValveType).value);
        callback(null, valveService.getCharacteristic(Characteristic.ValveType).value);
        break;

      case "SetDuration":
        this.log.debug("Valve SetDuration = ", valveService.getCharacteristic(Characteristic.SetDuration).value);
        callback(null, valveService.getCharacteristic(Characteristic.SetDuration).value);
        break;

      case "RemainingDuration":
        // Calc remain duration
        let station = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;
        let timeRemaining = Math.max(Math.round((this.timeEnding[station] - Date.now()) / 1000), 0);
        if (isNaN(timeRemaining)) {
          timeRemaining = 0;
        }
        //valveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(timeRemaining);
        this.log.debug("Valve RemainingDuration =", timeRemaining);
        callback(null, timeRemaining);
        break;

      default:
        this.log.debug("Valve unknown CharacteristicName called", characteristicName);
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
    this.log.debug("_setValueActive", valveService.getCharacteristic(Characteristic.Name).value, value ? "ACTIVE" : "INACTIVE");

    // Prepare message for API
    let station = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;
    let run_time = valveService.getCharacteristic(Characteristic.SetDuration).value / 60;

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
            let station = service.getCharacteristic(Characteristic.ServiceLabelIndex).value;
            if (station == jsonData['current_station']) {
              service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
              service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
              service.getCharacteristic(Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);
              this.timeEnding[station] = Date.now() + parseInt(jsonData['run_time']) * 60 * 1000; 
            } else {
              service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
              service.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
              service.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
            }
          };
        }.bind(this));
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
            service.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
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