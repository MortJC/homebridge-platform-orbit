const requestpromise = require("request-promise");
const ReconnectingWebSocket = require('reconnecting-websocket');
const WS = require('ws');

const endpoint = 'https://api.orbitbhyve.com/v1';

const WS_PINGINTERVAL = 25000 // Websocket get's timed out after 30s, so ping every 25s

class OrbitAPI {
    constructor(log, email, password) {
        this.log = log;
        this._email = email;
        this._password = password;
        this._token = null;
        this._rws = new WebSocketProxy();

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

        this._wsp = new WebSocketProxy(log);
        this._zones = [];
    }


    _addZone(station, name) {
        this._zones.push({ "station": station, "name": name });
    }


    openConnection() {
        this.log.debug('openConnection');
        this._wsp.connect(this._token, this._id)
            .then(ws => ws.send(JSON.stringify({
                event: "app_connection",
                orbit_session_token: this._token
            })));
    }

    onMessage(listner) {
        this.log.debug('onMessage');
        this._wsp.connect(this._token, this._id)
            .then(ws => ws.addEventListener('message', msg => {
                listner(msg.data, this._id);
            }));
    }


    sync() {
        this.log.debug('sync');
        this._wsp.connect(this._token, this._id)
            .then(ws => ws.send(JSON.stringify({
                event: "sync",
                device_id: this._id
            })));
    }


    startZone(station, run_time) {
        this.log.debug('startZone', station, run_time);
        this._wsp.connect(this._token, this._id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this._id,
                timestamp: new Date().toISOString(),
                stations: [
                    { "station": station, "run_time": run_time }
                ]
            }));
    }


    stopZone() {
        this.log.debug('stopZone');
        this._wsp.connect(this._token, this._id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this._id,
                timestamp: new Date().toISOString(),
                stations: []
            }));
    }
}

class WebSocketProxy {
    constructor(log) {
        this._rws = null;
        this._ping = null;
        this.log = log;
    }

    connect(token, deviceId) {
        if (this._rws) {
            return Promise.resolve(this._rws);
        }

        return new Promise((resolve, reject) => {
            this._rws = new ReconnectingWebSocket(`${endpoint}/events`, [], {
                WebSocket: WS,
                connectionTimeout: 1000,
                maxRetries: 10
            });

            // Intercept send events for logging
            const origSend = this._rws.send.bind(this._rws);
            this._rws.send = (data, options, callback) => {
                if (typeof data === 'object') {
                    data = JSON.stringify(data);
                }
                this.log.debug('TX', data);
                origSend(data, options, callback);
            };

            // Open
            this._rws.addEventListener('open', () => {
                this._rws.send({
                    event: 'app_connection',
                    orbit_session_token: token,
                    subscribe_device_id: deviceId,
                });
                resolve(this._rws);
            });

            // Message
            this._rws.addEventListener('message', msg => {
                this.log.debug('RX', msg.data);
            });

            // Ping
            this._ping = setInterval(() => {
                this._rws.send({ event: 'ping' });
            }, WS_PINGINTERVAL);

            // Error
            this._rws.addEventListener('error', msg => {
                this.log.error('WebSocket Error', msg);
                this._rws.close();
                reject(msg);
            });

        });
    }
}

module.exports = OrbitAPI;