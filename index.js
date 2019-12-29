const PlatformOrbit = require('./platform');

module.exports = (homebridge) => {
  PlatformAccessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  PluginName = 'homebridge-platform-orbit';
  PlatformName = 'orbit';
  
  homebridge.registerPlatform(PluginName, PlatformName, PlatformOrbit, true);
};