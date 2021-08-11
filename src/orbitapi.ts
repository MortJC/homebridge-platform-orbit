import { Logger } from "homebridge";

import bent from 'bent';
import WS from 'ws';
import ReconnectingWebSocket from 'reconnecting-websocket';

const endpoint = 'https://api.orbitbhyve.com/v1';
const ws_endpoint = 'wss://api.orbitbhyve.com/v1';

const WSpingINTERVAL = 25000 // Websocket get's timed out after 30s, so ping every 25s

export class OrbitAPI {

    private readonly log: Logger;
    private readonly email: string;
    private readonly password: string;
    private token: string;

    constructor(log: Logger, email: string, password: string) {
        this.log = log;
        this.email = email;
        this.password = password;
        this.token = "";
    }

    async login() {
        // Log in
        try {
            const postJSON = bent('POST', 'json');
            let response = await postJSON(endpoint + "/session",
                {
                    "session": {
                        "email": this.email,
                        "password": this.password
                    }
                },
                {
                    "orbit-app-id": "Orbit Support Dashboard",
                    "orbit-api-key": "null"
                });
            this.token = response['orbit_api_key'];
        } catch (error) {
            throw error;
        }
    }

    async getDevices(): Promise<OrbitDeviceAPI[]> {
        let devices: OrbitDeviceAPI[] = [];

        // Get the device details
        try {
            const getJSON = bent('GET', 'json');
            let response = await getJSON(endpoint + "/devices", {},
                {
                    "orbit-app-id": "Orbit Support Dashboard",
                    "orbit-api-key": this.token
                });
            response.forEach((result: any) => {
                if (result['type'] == "sprinkler_timer") {

                    // Create the device
                    let device = new OrbitDeviceAPI(this.log, this.token, result['id'], result['name'], result['hardware_version'], result['firmware_version'], result['is_connected']);

                    // Create zones
                    result['zones'].forEach((zone: any) => {
                        device.addZone(zone['station'], zone['name']);
                    });

                    devices.push(device);
                }
            });
            return devices;
        } catch (error) {
            throw error;
        }
    }

}


export class OrbitDeviceAPI {
    private readonly log: Logger;
    private readonly token: string;
    public readonly id: string;
    public readonly name: string;
    public readonly hardware_version: string;
    public readonly firmware_version: string;
    public readonly is_connected: boolean;
    public readonly zones: {}[];
    private messageQueue: string[];
    private rws: ReconnectingWebSocket;


    constructor(log: Logger, token: string, id: string, name: string, hardware_version: string, firmware_version: string, is_connected: boolean) {
        this.log = log;
        this.token = token;
        this.id = id;
        this.name = name;
        this.hardware_version = hardware_version;
        this.firmware_version = firmware_version;
        this.is_connected = is_connected;
        this.zones = [];
        this.messageQueue = []

        // Create the Reconnecting Web Socket
        this.rws = new ReconnectingWebSocket(`${ws_endpoint}/events`, [], {
            WebSocket: WS,
            connectionTimeout: 10000,
            maxReconnectionDelay: 64000,
            minReconnectionDelay: 2000,
            reconnectionDelayGrowFactor: 2
        });

        // Intercept send events for logging and queuing
        const origSend = this.rws.send.bind(this.rws);
        this.rws.send = (data: string) => {
            if (this.rws.readyState === WS.OPEN) {
                this.log.debug('TX', data);
                origSend(data);
            }
            else {
                this.messageQueue.push(data);
            }
        };

        // Ping
        setInterval(() => {
            this.rws.send(JSON.stringify({ event: 'ping' }));
        }, WSpingINTERVAL);

        // On Open, process any queued messages
        this.rws.onopen = (openEvent: WS.OpenEvent) => {
            this.log.debug('WebSocket', openEvent.type);
            while (this.messageQueue.length > 0) {
                let data: string = this.messageQueue.shift()!;
                this.log.debug('TX', data);
                origSend(data);
            }
        };

        // On Close
        this.rws.onclose = (closeEvent: WS.CloseEvent) => {
            this.log.debug('WebSocket', closeEvent.type);
        };

        // On Error
        this.rws.onerror = (errorEvent: WS.ErrorEvent) => {
            this.log.error('WebSocket Error', errorEvent);
            this.rws.close();
        };
    }


    addZone(station: string, name: string) {
        this.zones.push({ "station": station, "name": name });
    }


    openConnection() {
        this.log.debug('openConnection');
        this.rws.send(JSON.stringify({
            event: "app_connection",
            orbit_session_token: this.token,
            subscribe_device_id: this.id
        }));
    }


    onMessage(listner: Function) {
        this.log.debug('onMessage');
        this.rws.onmessage = (messageEvent: MessageEvent) => {
            this.log.debug('RX', messageEvent.data);
            listner(messageEvent.data);
        };
    }


    sync() {
        this.log.debug('sync');
        this.rws.send(JSON.stringify({
            event: "sync",
            device_id: this.id
        }));
    }


    startZone(station: number, run_time: number) {
        this.log.debug('startZone', station, run_time);
        this.rws.send(JSON.stringify({
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
        this.rws.send(JSON.stringify({
            event: "change_mode",
            mode: "manual",
            device_id: this.id,
            timestamp: new Date().toISOString(),
            stations: []
        }));
    }
}