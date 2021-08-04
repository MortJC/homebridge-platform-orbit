const bent = require('bent');
const ws = require('ws');
const reconnectingwebsocket = require('reconnecting-websocket');

const endpoint = 'https://api.orbitbhyve.com/v1';
const ws_endpoint = 'wss://api.orbitbhyve.com/v1';

const WS_PINGINTERVAL = 25000 // Websocket get's timed out after 30s, so ping every 25s

class OrbitAPI {
    constructor(log, email, password) {
        this.log = log;
        this._email = email;
        this._password = password;
        this._token = null;
        this._rws = new WebSocketProxy();

    }

    async getToken() {
        // log us in
        try {
            const postJSON = bent('POST', 'json');
            let response = await postJSON(endpoint + "/session",
                {
                    "session": {
                        "email": this._email,
                        "password": this._password
                    }
                },
                {
                    "orbit-app-id": "Orbit Support Dashboard",
                    "orbit-api-key": "null"
                });
            this._token = response['orbit_api_key'];
        } catch (error) {
            throw error;
        }
    }

    async getDevices() {
        let devices = [];

        // Get the device details
        try {
            const getJSON = bent('GET', 'json');
            let response = await getJSON(endpoint + "/devices", {},
                {
                    "orbit-app-id": "Orbit Support Dashboard",
                    "orbit-api-key": this._token
                });
            response.forEach(function (result) {
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
        } catch (error) {
            throw error;
        }
    }

}


class OrbitDeviceAPI {
    constructor(log, token, id, name, hardware_version, firmware_version, is_connected) {
        this._token = token;
        this.id = id;
        this.name = name;
        this.hardware_version = hardware_version;
        this.firmware_version = firmware_version;
        this.is_connected = is_connected;
        this.log = log;

        this._wsp = new WebSocketProxy(log);
        this.zones = [];
    }


    _addZone(station, name) {
        this.zones.push({ "station": station, "name": name });
    }


    openConnection() {
        this.log.debug('openConnection');
        this._wsp.connect(this._token, this.id)
            .then(ws => ws.send(JSON.stringify({
                event: "app_connection",
                orbit_session_token: this._token
            })));
    }

    onMessage(listner) {
        this.log.debug('onMessage');
        this._wsp.connect(this._token, this.id)
            .then(ws => ws.addEventListener('message', msg => {
                listner(msg.data);
            }));
    }


    sync() {
        this.log.debug('sync');
        this._wsp.connect(this._token, this.id)
            .then(ws => ws.send(JSON.stringify({
                event: "sync",
                device_id: this._id
            })));
    }


    startZone(station, run_time) {
        this.log.debug('startZone', station, run_time);
        this._wsp.connect(this._token, this.id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this.id,
                timestamp: new Date().toISOString(),
                stations: [
                    { "station": station, "run_time": run_time }
                ]
            }));
    }


    stopZone() {
        this.log.debug('stopZone');
        this._wsp.connect(this._token, this.id)
            .then(ws => ws.send({
                event: "change_mode",
                mode: "manual",
                device_id: this.id,
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
            try {
                this._rws = new reconnectingwebsocket(`${ws_endpoint}/events`, [], {
                    WebSocket: ws,
                    connectionTimeout: 10000,
                    maxReconnectionDelay: 64000,
                    minReconnectionDelay: 2000,
                    reconnectionDelayGrowFactor: 2
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
            }

            catch (error) {
                // Will not execute
                this.log.error('caught', error.message);
            };

        });
    }
}

module.exports = OrbitAPI;