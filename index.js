const PlatformOrbit = require('./platform');
const PluginName = 'homebridge-platform-orbit';
const PlatformName = 'orbit';

module.exports = (homebridge) => {
  global.Accessory = homebridge.platformAccessory;
  global.Service = homebridge.hap.Service;
  global.Characteristic = homebridge.hap.Characteristic;
  global.UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform(PluginName, PlatformName, PlatformOrbit, true);
};