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
      this.accessories = [];

      if (api) {

        // save the api for use later
        this.api = api;

        // if finished loading cache accessories
        this.api.on("didFinishLaunching", function () {

          // Load the orbit devices
          this._loadDevices();

        }.bind(this));
      }
    }
  }


  _loadDevices() {
    this.log.debug("Loading the devices");

    // login to the API and get the token
    let orbitAPI = new OrbitAPI(this.log, this.email, this.password);
    orbitAPI.getToken()
      .then(function () {

        // get an array of the devices
        orbitAPI.getDevices()
          .then(function (devices) {

            // loop through each device
            devices.forEach(function (device) {

              // Generate irrigation service uuid
              let uuid = UUIDGen.generate(device.id);
              // if (this.accessories[uuid]) {
              //   this.api.unregisterPlatformAccessories(PluginName, PlatformName, [this.accessories[uuid]]);
              // }

              // Check if device is already loaded from cache
              if (this.accessories[uuid]) {
                this.log.debug('Configuring cached device');

                // Setup Irrigation Accessory and Irrigation Service
                let irrigationAccessory = this.accessories[uuid];
                irrigationAccessory.context.device = device;
                irrigationAccessory.context.timeEnding = [];
                this.api.updatePlatformAccessories([irrigationAccessory]);
                this._configureIrrigationService(irrigationAccessory.getService(Service.IrrigationSystem));

                // Find the valve Services associated with the accessory
                irrigationAccessory.services.forEach(function (service) {
                  if (Service.Valve.UUID === service.UUID) {

                    // Configure Valve Service
                    this._configureValveService(irrigationAccessory, service);
                  }
                }.bind(this));
              }
              else {
                this.log.debug('Creating and configuring new device');

                // Create Irrigation Accessory and Irrigation Service
                let irrigationAccessory = new this.api.platformAccessory(device.name, uuid);
                irrigationAccessory.context.device = device;
                irrigationAccessory.context.timeEnding = [];
                let irrigationSystemService = this._createIrrigationService(irrigationAccessory);
                this._configureIrrigationService(irrigationSystemService);

                // Create and configure Values services and link to Irrigation Service
                device.zones.forEach(function (zone) {
                  let valveService = this._createValveService(irrigationAccessory, zone['station'], zone['name']);
                  irrigationSystemService.addLinkedService(valveService);
                  this._configureValveService(irrigationAccessory, valveService);
                }.bind(this));

                // Register platform accessory
                this.log.debug('Registering platform accessory');
                this.api.registerPlatformAccessories(PluginName, PlatformName, [irrigationAccessory]);
                this.accessories[uuid] = irrigationAccessory;
              }

              device.openConnection();
              device.onMessage(this.processMessage.bind(this));

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
    // Add cached devices to the accessories arrary
    this.log('Loading accessory from cache', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;
  }


  _createIrrigationService(irrigationAccessory) {
    this.log.debug('Create Irrigation service', irrigationAccessory.context.device.id);

    // Add Irrigation System Service
    let irrigationSystemService = irrigationAccessory.addService(Service.IrrigationSystem, irrigationAccessory.context.device.name)
      .setCharacteristic(Characteristic.Name, irrigationAccessory.context.device.name)
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.StatusFault, irrigationAccessory.context.device.is_connected ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);

    // Update AccessoryInformation Service
    irrigationAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, irrigationAccessory.context.device.name)
      .setCharacteristic(Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(Characteristic.SerialNumber, irrigationAccessory.context.device.id)
      .setCharacteristic(Characteristic.Model, irrigationAccessory.context.device.hardware_version)
      .setCharacteristic(Characteristic.FirmwareRevision, irrigationAccessory.context.device.firmware_version);

    return irrigationSystemService;
  }


  _configureIrrigationService(irrigationSystemService) {
    this.log.debug('Configure Irrigation service', irrigationSystemService.getCharacteristic(Characteristic.Name).value)

    // Configure Irrigation System Service
    irrigationSystemService
      .getCharacteristic(Characteristic.Active)
      .onGet(this._getIrrigationSystemValue.bind(this, irrigationSystemService, Characteristic.Active))
      .onSet(this._setIrrigationSystemActive.bind(this, irrigationSystemService));

    irrigationSystemService
      .getCharacteristic(Characteristic.ProgramMode)
      .onGet(this._getIrrigationSystemValue.bind(this, irrigationSystemService, Characteristic.ProgramMode));

    irrigationSystemService
      .getCharacteristic(Characteristic.InUse)
      .onGet(this._getIrrigationSystemValue.bind(this, irrigationSystemService, Characteristic.InUse));

    irrigationSystemService
      .getCharacteristic(Characteristic.StatusFault)
      .onGet(this._getIrrigationSystemValue.bind(this, irrigationSystemService, Characteristic.StatusFault));

    irrigationSystemService
      .getCharacteristic(Characteristic.RemainingDuration)
      .onGet(this._getIrrigationSystemValue.bind(this, irrigationSystemService, Characteristic.RemainingDuration));
  }


  _createValveService(irrigationAccessory, station, name) {
    this.log.debug("Create Valve service " + name + " with station " + station);

    // Add Valve Service
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

    return valve
  }


  _configureValveService(irrigationAccessory, valveService) {
    this.log.debug("Configure Valve service", valveService.getCharacteristic(Characteristic.Name).value);

    // Configure Valve Service
    valveService
      .getCharacteristic(Characteristic.Active)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.Active))
      .onSet(this._setValveActive.bind(this, irrigationAccessory, valveService));

    valveService
      .getCharacteristic(Characteristic.InUse)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.InUse));

    valveService
      .getCharacteristic(Characteristic.IsConfigured)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.IsConfigured))
      .onSet(this._setValveIsConfigured.bind(this, valveService));

    valveService
      .getCharacteristic(Characteristic.StatusFault)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.StatusFault))

    valveService
      .getCharacteristic(Characteristic.ValveType)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.ValveType));

    valveService
      .getCharacteristic(Characteristic.SetDuration)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.SetDuration))
      .onSet(this._setValveSetDuration.bind(this, valveService));

    valveService
      .getCharacteristic(Characteristic.RemainingDuration)
      .onGet(this._getValveValue.bind(this, irrigationAccessory, valveService, Characteristic.RemainingDuration))

    irrigationAccessory.context.timeEnding[valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value] = 0;
  }


  async _getIrrigationSystemValue(irrigationSystemService, characteristic) {

    switch (characteristic) {

      case Characteristic.Active:
        this.log.debug("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "Active = ", irrigationSystemService.getCharacteristic(Characteristic.Active).value ? "ACTIVE" : "INACTIVE");
        return irrigationSystemService.getCharacteristic(Characteristic.Active).value;

      case Characteristic.InUse:
        this.log.debug("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "InUse = ", irrigationSystemService.getCharacteristic(Characteristic.InUse).value ? "IN_USE" : "NOT_IN_USE");
        return irrigationSystemService.getCharacteristic(Characteristic.InUse).value;

      case Characteristic.StatusFault:
        this.log.debug("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "StatusFault = ", irrigationSystemService.getCharacteristic(Characteristic.StatusFault).value ? "GENERAL_FAULT" : "NO_FAULT");
        return irrigationSystemService.getCharacteristic(Characteristic.StatusFault).value;

      case Characteristic.ProgramMode:
        this.log.debug("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "ProgramMode = ", irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value);
        return irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).value;

      case Characteristic.RemainingDuration:
        this.log.debug("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "RemainingDuration = ", irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value);
        return irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).value;

      default:
        this.log.warn("IrrigationSystem",  irrigationSystemService.getCharacteristic(Characteristic.Name).value, "unknown CharacteristicName called", characteristic);
        return null;
    }

  }


  async _setIrrigationSystemActive(irrigationSystemService, value) {
    // Update the iggication system active
    this.log.info("Set irrigation system ", irrigationSystemService.getCharacteristic(Characteristic.Name).value, " to ", value ? "ACTIVE" : "INACTIVE");
    irrigationSystemService.getCharacteristic(Characteristic.Active).updateValue(value);
  }


  async _getValveValue(irrigationAccessory, valveService, characteristic) {

    switch (characteristic) {
      case Characteristic.Active:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "Active = ", valveService.getCharacteristic(Characteristic.Active).value ? "ACTIVE" : "INACTIVE");
        return valveService.getCharacteristic(Characteristic.Active).value;

      case Characteristic.InUse:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "InUse = ", valveService.getCharacteristic(Characteristic.InUse).value ? "IN_USE" : "NOT_IN_USE");
        return valveService.getCharacteristic(Characteristic.InUse).value;

      case Characteristic.IsConfigured:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "IsConfigured = ", valveService.getCharacteristic(Characteristic.IsConfigured).value ? "CONFIGURED" : "NOT_CONFIGURED");
        return valveService.getCharacteristic(Characteristic.IsConfigured).value;

      case Characteristic.StatusFault:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "StatusFault = ", valveService.getCharacteristic(Characteristic.StatusFault).value ? "GENERAL_FAULT" : "NO_FAULT");
        return valveService.getCharacteristic(Characteristic.StatusFault).value;

      case Characteristic.ValveType:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "ValveType = ", valveService.getCharacteristic(Characteristic.ValveType).value);
        return valveService.getCharacteristic(Characteristic.ValveType).value;

      case Characteristic.SetDuration:
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "SetDuration = ", valveService.getCharacteristic(Characteristic.SetDuration).value);
        return valveService.getCharacteristic(Characteristic.SetDuration).value;

      case Characteristic.RemainingDuration:
        // Calc remain duration
        let station = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;
        let timeRemaining = Math.max(Math.round((irrigationAccessory.context.timeEnding[station] - Date.now()) / 1000), 0);
        if (isNaN(timeRemaining)) {
          timeRemaining = 0;
        }
        this.log.debug("Valve", valveService.getCharacteristic(Characteristic.Name).value, "RemainingDuration =", timeRemaining);
        return timeRemaining;

      default:
        this.log.warn("Valve", valveService.getCharacteristic(Characteristic.Name).value, "unknown CharacteristicName called", characteristic);
        return null;
    }

  }


  async _setValveActive(irrigationAccessory, valveService, value) {
    this.log.debug("_setValueActive", valveService.getCharacteristic(Characteristic.Name).value, value ? "ACTIVE" : "INACTIVE");

    // Prepare message for API
    let station = valveService.getCharacteristic(Characteristic.ServiceLabelIndex).value;
    let run_time = valveService.getCharacteristic(Characteristic.SetDuration).value / 60;

    if (value == Characteristic.Active.ACTIVE) {
      // Turn on the valve
      this.log.info("Start zone", valveService.getCharacteristic(Characteristic.Name).value, "for", run_time, "mins");
      irrigationAccessory.context.device.startZone(station, run_time);
    } else {
      // Turn off the valve
      this.log.info("Stop zone", valveService.getCharacteristic(Characteristic.Name).value);
      irrigationAccessory.context.device.stopZone();
    }

  }


  async _setValveSetDuration(valveService, value) {
    this.log.debug("_setValveSetDuration", valveService.getCharacteristic(Characteristic.Name).value, value);

    // Update the value run duration
    this.log.info("Set valve ", valveService.getCharacteristic(Characteristic.Name).value, " duration to ", value);
    valveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);
  }


  async _setValveIsConfigured(valveService, value) {
    this.log.debug("_setValveIsConfigured", valveService.getCharacteristic(Characteristic.Name).value, value);

    // Update the value run duration
    this.log.info("Set valve ", valveService.getCharacteristic(Characteristic.Name).value, " is_configured to ", value);
    valveService.getCharacteristic(Characteristic.IsConfigured).updateValue(value);
  }


  processMessage(message) {
    // Incoming data
    let jsonData = JSON.parse(message);

    // Find the irrigation system and process message
    let irrigationAccessory = this.accessories[UUIDGen.generate(jsonData['device_id'])];
    let irrigationSystemService = irrigationAccessory.getService(Service.IrrigationSystem);

    switch (jsonData['event']) {

      case "watering_in_progress_notification":
        this.log.debug("Watering_in_progress_notification Station", "device =", irrigationAccessory.context.device.name, "station =", jsonData['current_station'], "Runtime =", jsonData['run_time']);

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
              irrigationAccessory.context.timeEnding[station] = Date.now() + parseInt(jsonData['run_time']) * 60 * 1000;
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