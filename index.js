const PlatformOrbit = require('./platform');
const PluginName = 'homebridge-platform-orbit';
const PlatformName = 'orbit';

module.exports = (homebridge) => {
  PlatformAccessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform(PluginName, PlatformName, PlatformOrbit, true);
};