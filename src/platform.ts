import {
  API,
  HAP,
  PlatformAccessory,
  PlatformConfig,
  Logger,
  Service
} from "homebridge";

const PluginName = 'homebridge-platform-orbit';
const PlatformName = 'orbit';

let hap: HAP;

export = (api: API) => {
  hap = api.hap;
  api.registerPlatform(PluginName, PlatformName, PlatformOrbit);
};

import { OrbitAPI, OrbitDeviceAPI } from './orbitapi';

class PlatformOrbit {
  private readonly email: string = "";
  private readonly password: string = "";
  private accessories: { [uuid: string]: PlatformAccessory } = {};


  constructor(public readonly log: Logger, public readonly config: PlatformConfig, public readonly api: API) {
    if (!config || !config["email"] || !config["password"]) {
      this.log.error("Platform config incorrect or missing. Check the config.json file.");
    }
    else {

      this.email = config["email"];
      this.password = config["password"];

      this.log.info('Starting PlatformOrbit using homebridge API', api.version);
      if (api) {

        // save the api for use later
        this.api = api;

        // if finished loading cache accessories
        this.api.on("didFinishLaunching", () => {

          // Load the orbit devices
          this.loadDevices();

        });
      }
    }
  }


  loadDevices() {
    this.log.debug("Loading the devices");

    // login to the API and get the token
    let orbitAPI: OrbitAPI = new OrbitAPI(this.log, this.email, this.password);
    orbitAPI.login()
      .then(() => {

        // get an array of the devices
        orbitAPI.getDevices()
          .then((devices: OrbitDeviceAPI[]) => {

            // loop through each device
            devices.forEach((device: OrbitDeviceAPI) => {

              // Generate irrigation service uuid
              const uuid: string = hap.uuid.generate(device.id);

              // Check if device is already loaded from cache
              if (this.accessories[uuid]) {
                this.log.info('Configuring cached device', device.name);

                // Setup Irrigation Accessory and Irrigation Service
                let irrigationAccessory = this.accessories[uuid];
                irrigationAccessory.context.device = device;
                irrigationAccessory.context.timeEnding = [];
                this.api.updatePlatformAccessories([irrigationAccessory]);
                this.configureIrrigationService(irrigationAccessory.getService(hap.Service.IrrigationSystem)!);

                // Find the valve Services associated with the accessory
                irrigationAccessory.services.forEach((service: any) => {
                  if (hap.Service.Valve.UUID === service.UUID) {

                    // Configure Valve Service
                    this.configureValveService(irrigationAccessory, service);
                  }
                });
              }
              else {
                this.log.info('Creating and configuring new device', device.name);

                // Create Irrigation Accessory and Irrigation Service
                let irrigationAccessory = new this.api.platformAccessory(device.name, uuid);
                irrigationAccessory.context.device = device;
                irrigationAccessory.context.timeEnding = [];
                let irrigationSystemService = this.createIrrigationService(irrigationAccessory);
                this.configureIrrigationService(irrigationSystemService);

                // Create and configure Values services and link to Irrigation Service
                device.zones.forEach((zone: any) => {
                  let valveService = this.createValveService(irrigationAccessory, zone['station'], zone['name']);
                  irrigationSystemService.addLinkedService(valveService);
                  this.configureValveService(irrigationAccessory, valveService);
                });

                // Register platform accessory
                this.log.debug('Registering platform accessory');
                this.api.registerPlatformAccessories(PluginName, PlatformName, [irrigationAccessory]);
                this.accessories[uuid] = irrigationAccessory;
              }

              device.openConnection();
              device.onMessage(this.processMessage.bind(this));
              device.sync();

            });
          }).catch((error) => {
            this.log.error('Unable to get devices', error);
          });
      })
      .catch((error) => {
        this.log.error('Unable to get token', error);
      });
  }


  configureAccessory(accessory: PlatformAccessory) {
    // Add cached devices to the accessories arrary
    this.log.info('Loading accessory from cache', accessory.displayName);
    this.accessories[accessory.UUID] = accessory;
  }


  createIrrigationService(irrigationAccessory: PlatformAccessory): Service {
    this.log.debug('Create Irrigation service', irrigationAccessory.context.device.id);

    // Update AccessoryInformation Service
    irrigationAccessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Name, irrigationAccessory.context.device.name)
      .setCharacteristic(hap.Characteristic.Manufacturer, "Orbit")
      .setCharacteristic(hap.Characteristic.SerialNumber, irrigationAccessory.context.device.id)
      .setCharacteristic(hap.Characteristic.Model, irrigationAccessory.context.device.hardware_version)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, irrigationAccessory.context.device.firmware_version);

    // Add Irrigation System Service
    let irrigationSystemService = irrigationAccessory.addService(hap.Service.IrrigationSystem, irrigationAccessory.context.device.name)
      .setCharacteristic(hap.Characteristic.Name, irrigationAccessory.context.device.name)
      .setCharacteristic(hap.Characteristic.Active, hap.Characteristic.Active.ACTIVE)
      .setCharacteristic(hap.Characteristic.InUse, hap.Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(hap.Characteristic.ProgramMode, hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED)
      .setCharacteristic(hap.Characteristic.RemainingDuration, 0)
      .setCharacteristic(hap.Characteristic.StatusFault, irrigationAccessory.context.device.is_connected ? hap.Characteristic.StatusFault.NO_FAULT : hap.Characteristic.StatusFault.GENERAL_FAULT);

    return irrigationSystemService;
  }


  configureIrrigationService(irrigationSystemService: Service) {
    this.log.debug('Configure Irrigation service', irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value)

    // Configure Irrigation System Service
    irrigationSystemService
      .getCharacteristic(hap.Characteristic.Active)
      .onGet(() => {
        this.log.debug("IrrigationSystem", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, "Active = ", irrigationSystemService.getCharacteristic(hap.Characteristic.Active).value ? "ACTIVE" : "INACTIVE");
        return irrigationSystemService.getCharacteristic(hap.Characteristic.Active).value;
      })
      .onSet((value) => {
        this.log.info("Set irrigation system ", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, " to ", value ? "ACTIVE" : "INACTIVE");
        irrigationSystemService.getCharacteristic(hap.Characteristic.Active).updateValue(value);
      });

    irrigationSystemService
      .getCharacteristic(hap.Characteristic.ProgramMode)
      .onGet(() => {
        this.log.debug("IrrigationSystem", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, "ProgramMode = ", irrigationSystemService.getCharacteristic(hap.Characteristic.ProgramMode).value);
        return irrigationSystemService.getCharacteristic(hap.Characteristic.ProgramMode).value;
      });

    irrigationSystemService
      .getCharacteristic(hap.Characteristic.InUse)
      .onGet(() => {
        this.log.debug("IrrigationSystem", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, "InUse = ", irrigationSystemService.getCharacteristic(hap.Characteristic.InUse).value ? "IN_USE" : "NOT_IN_USE");
        return irrigationSystemService.getCharacteristic(hap.Characteristic.InUse).value;
      });

    irrigationSystemService
      .getCharacteristic(hap.Characteristic.StatusFault)
      .onGet(() => {
        this.log.debug("IrrigationSystem", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, "StatusFault = ", irrigationSystemService.getCharacteristic(hap.Characteristic.StatusFault).value ? "GENERAL_FAULT" : "NO_FAULT");
        return irrigationSystemService.getCharacteristic(hap.Characteristic.StatusFault).value;
      });

    irrigationSystemService
      .getCharacteristic(hap.Characteristic.RemainingDuration)
      .onGet(() => {
        this.log.debug("IrrigationSystem", irrigationSystemService.getCharacteristic(hap.Characteristic.Name).value, "RemainingDuration = ", irrigationSystemService.getCharacteristic(hap.Characteristic.RemainingDuration).value);
        return irrigationSystemService.getCharacteristic(hap.Characteristic.RemainingDuration).value;
      });
  }


  createValveService(irrigationAccessory: PlatformAccessory, station: string, name: string): Service {
    this.log.debug("Create Valve service " + name + " with station " + station);

    // Add Valve Service
    let valve = irrigationAccessory.addService(hap.Service.Valve, name, station);
    valve
      .setCharacteristic(hap.Characteristic.Active, hap.Characteristic.Active.INACTIVE)
      .setCharacteristic(hap.Characteristic.InUse, hap.Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(hap.Characteristic.ValveType, hap.Characteristic.ValveType.IRRIGATION)
      .setCharacteristic(hap.Characteristic.SetDuration, 300)
      .setCharacteristic(hap.Characteristic.RemainingDuration, 0)
      .setCharacteristic(hap.Characteristic.IsConfigured, hap.Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(hap.Characteristic.ServiceLabelIndex, station)
      .setCharacteristic(hap.Characteristic.StatusFault, hap.Characteristic.StatusFault.NO_FAULT)
      .setCharacteristic(hap.Characteristic.Name, name);

    return valve
  }


  configureValveService(irrigationAccessory: PlatformAccessory, valveService: Service) {
    this.log.debug("Configure Valve service", valveService.getCharacteristic(hap.Characteristic.Name).value);

    // Configure Valve Service
    valveService
      .getCharacteristic(hap.Characteristic.Active)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "Active = ", valveService.getCharacteristic(hap.Characteristic.Active).value ? "ACTIVE" : "INACTIVE");
        return valveService.getCharacteristic(hap.Characteristic.Active).value;
      })
      .onSet((value) => {
        // Prepare message for API
        let station = valveService.getCharacteristic(hap.Characteristic.ServiceLabelIndex).value;
        let run_time = valveService.getCharacteristic(hap.Characteristic.SetDuration).value as number / 60;

        if (value == hap.Characteristic.Active.ACTIVE) {
          // Turn on the valve
          this.log.info("Start zone", valveService.getCharacteristic(hap.Characteristic.Name).value, "for", run_time, "mins");
          irrigationAccessory.context.device.startZone(station, run_time);
        } else {
          // Turn off the valve
          this.log.info("Stop zone", valveService.getCharacteristic(hap.Characteristic.Name).value);
          irrigationAccessory.context.device.stopZone();
        }
      });

    valveService
      .getCharacteristic(hap.Characteristic.InUse)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "InUse = ", valveService.getCharacteristic(hap.Characteristic.InUse).value ? "IN_USE" : "NOT_IN_USE");
        return valveService.getCharacteristic(hap.Characteristic.InUse).value;
      });

    valveService
      .getCharacteristic(hap.Characteristic.IsConfigured)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "IsConfigured = ", valveService.getCharacteristic(hap.Characteristic.IsConfigured).value ? "CONFIGURED" : "NOT_CONFIGURED");
        return valveService.getCharacteristic(hap.Characteristic.IsConfigured).value;
      })
      .onSet((value) => {
        this.log.info("Set valve ", valveService.getCharacteristic(hap.Characteristic.Name).value, " isConfigured to ", value);
        valveService.getCharacteristic(hap.Characteristic.IsConfigured).updateValue(value);
      });

    valveService
      .getCharacteristic(hap.Characteristic.StatusFault)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "StatusFault = ", valveService.getCharacteristic(hap.Characteristic.StatusFault).value ? "GENERAL_FAULT" : "NO_FAULT");
        return valveService.getCharacteristic(hap.Characteristic.StatusFault).value;
      });

    valveService
      .getCharacteristic(hap.Characteristic.ValveType)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "ValveType = ", valveService.getCharacteristic(hap.Characteristic.ValveType).value);
        return valveService.getCharacteristic(hap.Characteristic.ValveType).value;
      });

    valveService
      .getCharacteristic(hap.Characteristic.SetDuration)
      .onGet(() => {
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "SetDuration = ", valveService.getCharacteristic(hap.Characteristic.SetDuration).value);
        return valveService.getCharacteristic(hap.Characteristic.SetDuration).value;
      })
      .onSet((value) => {
        // Update the value run duration
        this.log.info("Set valve ", valveService.getCharacteristic(hap.Characteristic.Name).value, " SetDuration to ", value);
        valveService.getCharacteristic(hap.Characteristic.SetDuration).updateValue(value);
      });

    valveService
      .getCharacteristic(hap.Characteristic.RemainingDuration)
      .onGet(() => {
        // Calc remain duration
        let station = valveService.getCharacteristic(hap.Characteristic.ServiceLabelIndex).value as number;
        let timeRemaining = Math.max(Math.round((irrigationAccessory.context.timeEnding[station] - Date.now()) / 1000), 0);
        if (isNaN(timeRemaining)) {
          timeRemaining = 0;
        }
        this.log.debug("Valve", valveService.getCharacteristic(hap.Characteristic.Name).value, "RemainingDuration =", timeRemaining);
        return timeRemaining;
      })

    irrigationAccessory.context.timeEnding[valveService.getCharacteristic(hap.Characteristic.ServiceLabelIndex).value as number] = 0;
  }


  processMessage(message: any) {
    // Incoming data
    let jsonData = JSON.parse(message);

    // Find the irrigation system and process message
    let irrigationAccessory: PlatformAccessory = this.accessories[hap.uuid.generate(jsonData['device_id'])];
    let irrigationSystemService: Service = irrigationAccessory.getService(hap.Service.IrrigationSystem)!;

    switch (jsonData['event']) {

      case "watering_in_progress_notification":
        this.log.debug("Watering_in_progress_notification Station", "device =", irrigationAccessory.context.device.name, "station =", jsonData['current_station'], "Runtime =", jsonData['run_time']);

        // Update Irrigation System Service
        irrigationSystemService.getCharacteristic(hap.Characteristic.InUse).updateValue(hap.Characteristic.InUse.IN_USE);

        // Find the valve Services
        irrigationAccessory.services.forEach((service: Service) => {
          if (hap.Service.Valve.UUID === service.UUID) {

            // Update Valve Services
            let station: number = service.getCharacteristic(hap.Characteristic.ServiceLabelIndex).value as number;
            if (station == jsonData['current_station']) {
              service.getCharacteristic(hap.Characteristic.Active).updateValue(hap.Characteristic.Active.ACTIVE);
              service.getCharacteristic(hap.Characteristic.InUse).updateValue(hap.Characteristic.InUse.IN_USE);
              service.getCharacteristic(hap.Characteristic.RemainingDuration).updateValue(jsonData['run_time'] * 60);
              irrigationAccessory.context.timeEnding[station] = Date.now() + parseInt(jsonData['run_time']) * 60 * 1000;
            } else {
              service.getCharacteristic(hap.Characteristic.Active).updateValue(hap.Characteristic.Active.INACTIVE);
              service.getCharacteristic(hap.Characteristic.InUse).updateValue(hap.Characteristic.InUse.NOT_IN_USE);
              service.getCharacteristic(hap.Characteristic.RemainingDuration).updateValue(0);
            }
          };
        });
        break;

      case "watering_complete":
      case "device_idle":
        this.log.debug("Watering_complete or device_idle");

        // Update Irrigation System Service
        irrigationSystemService.getCharacteristic(hap.Characteristic.InUse).updateValue(hap.Characteristic.InUse.NOT_IN_USE);

        // Find the valve Services 
        irrigationAccessory.services.forEach(function (service: Service) {

          // Update Valve hap.Service
          if (hap.Service.Valve.UUID === service.UUID) {
            service.getCharacteristic(hap.Characteristic.Active).updateValue(hap.Characteristic.Active.INACTIVE);
            service.getCharacteristic(hap.Characteristic.InUse).updateValue(hap.Characteristic.InUse.NOT_IN_USE);
            service.getCharacteristic(hap.Characteristic.RemainingDuration).updateValue(0);
          }
        });
        break;

      case "change_mode":
        this.log.debug("change_mode", jsonData['mode']);

        // Update the ProgramMode
        switch (jsonData['mode']) {
          case "off":
            irrigationSystemService.getCharacteristic(hap.Characteristic.ProgramMode).updateValue(hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
            break;
          case "auto":
            irrigationSystemService.getCharacteristic(hap.Characteristic.ProgramMode).updateValue(hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
            break;
          case "manual":
            irrigationSystemService.getCharacteristic(hap.Characteristic.ProgramMode).updateValue(hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_);
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
        irrigationSystemService.getCharacteristic(hap.Characteristic.StatusFault).updateValue(hap.Characteristic.StatusFault.NO_FAULT);
        break;

      case "device_disconnected":
        this.log.debug("device_disconnected");
        irrigationSystemService.getCharacteristic(hap.Characteristic.StatusFault).updateValue(hap.Characteristic.StatusFault.GENERAL_FAULT);
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