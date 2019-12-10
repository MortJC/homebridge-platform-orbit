// const axios = require('axios');
const requestpromise = require("request-promise");
const WebSocket = require('ws');

const endpoint = 'https://api.orbitbhyve.com/v1';

const WS_TIMEOUT = 300000;

class OrbitAPI {
    constructor(log, email, password) {
        this.log = log;
        this._email = email;
        this._password = password;
        this._token = null;
        this._ws = new WebSocketProxy();

    }

    getToken() {
        // log us in
        return requestpromise.post({
            url: endpoint + "/session",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "orbit-app-id": "Orbit Support Dashboard",
                "orbit-api-key": "null"
            },
            json: {
                "session": {
                    "email": this._email,
                    "password": this._password
                }
            },
        }).then(function (body) {
            // Save orbit_api_key
            this._token = body['orbit_api_key'];
        }.bind(this));
    }

    getDevices() {
        let devices = [];

        // Get the device details
        return requestpromise.get({
            url: endpoint + "/devices",
            headers: {
                "Accept": "application/json",
                "orbit-app-id": "Orbit Support Dashboard",
                "orbit-api-key": this._token
            }
        }).then(function (body) {
            JSON.parse(body).forEach(function (result) {
                if (result['type'] == "sprinkler_timer") {

                    // Create the device
                    let device = new OrbitDeviceAPI(this.log, this._token, result['id'], result['name'], result['hardware_version'], result['firmware_version'], result['is_connected']);

                    // Create zones
                    result['zones'].forEach(function (zone) {
                        device._addZone(zone['station'], zone['name']);
                    }.bind(this));

                    devices.push(device);
                }
            }.bind(this));

            return devices;
        }.bind(this));
    }

}


class OrbitDeviceAPI {
    constructor(log, token, id, name, hardware_version, firmware_version, is_connected) {
        this._token = token;
        this._id = id;
        this._name = name;
        this._hardware_version = hardware_version;
        this._firmware_version = firmware_version;
        this._is_connected = is_connected;
        this.log = log;

        this._ws = new WebSocketProxy(log);
        this._zones = [];
    }


    _addZone(station, name) {
        this._zones.push({ "station": station, "name": name });
    }


    openConnection() {
        this.log.debug('openConnection');
        this._ws.connect(this._token, this._id)
            .then(ws => ws.send(JSON.stringify({
                event: "app_connection",
                orbit_session_token: this._token,
            })));
    }


    onMessage(listner) {
        this.log.debug('onMessage');
        this._ws.connect(this._token, this._id)
            .then(ws => ws.on('message', msg => {
                listner(msg, this._id);
            }));
    }


    sync() {
        this.log.debug('sync');
        this._ws.connect(this._token, this._id)
            .then(ws => ws.send(JSON.stringify({
                event: "sync",
                device_id: this._id,
            })));
    }


    startZone(station, run_time) {
        this.log.debug('startZone', station, run_time);
        this._ws.connect(this._token, this._id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this._id,
                timestamp: new Date().toISOString(),
                stations: [
                    { "station": station, "run_time": run_time }
                ],
            }));
    }


    stopZone() {
        this.log.debug('stopZone');
        this._ws.connect(this._token, this._id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this._id,
                timestamp: new Date().toISOString(),
                stations: [],
            }));
    }
}

class WebSocketProxy {
    constructor(log) {
        this._ws = null;
        this._wsPing = null;
        this._wsHeartbeat = null;
        this.log = log;
    }

    _heartbeat() {
        clearTimeout(this._wsHeartbeat);

        this._wsHeartbeat = setTimeout(() => {
            clearInterval(this._wsPing);
            this._ws.terminate();
            this._ws = null;
        }, WS_TIMEOUT);
    }

    connect(token, deviceId) {
        if (this._ws) {
            return Promise.resolve(this._ws);
        }

        return new Promise((resolve, reject) => {
            this._ws = new WebSocket(`${endpoint}/events`);

            // Intercept send events for logging
            const origSend = this._ws.send.bind(this._ws);
            this._ws.send = (data, options, callback) => {
                if (data.event && data.event !== 'ping') {
                    this._heartbeat();
                }
                if (typeof data === 'object') {
                    data = JSON.stringify(data);
                }
                this.log.debug('TX', data);
                origSend(data, options, callback);
            };

            this._wsPing = setInterval(() => {
                this._ws.send({ event: 'ping' });
            }, 25000);

            this._ws.on('open', () => {
                this._ws.send({
                    event: 'app_connection',
                    orbit_session_token: token,
                    subscribe_device_id: deviceId,
                });

                this._heartbeat();
                resolve(this._ws);
            });

            this._ws.on('message', msg => {
                this.log.debug('RX', msg);
            });

            this._ws.on('close', () => {
                this.log.debug('WebSocket Closed');
                clearInterval(this._wsPing);
            });

            this._ws.on('error', msg => {
                this.log.error('WebSocket Error', msg);
                this._ws.close();

                reject(msg);
            });

        });
    }
}

module.exports = OrbitAPI;