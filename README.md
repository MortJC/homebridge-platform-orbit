# homebridge-platform-orbit
Orbit Irrigation System platform plugin for [HomeBridge](https://github.com/nfarina/homebridge).

## Installation
1. Install this plugin using: npm install -g homebridge-platform-orbit
2. Edit ``config.json`` and add your login detail.
3. Run Homebridge

## Config.json example
```
"platforms": [
	{
		"platform": "orbit",
		"name" : "orbit",
		"email": "joe.blogs@gmail.com",
		"password": "MySecretPassword"
	}
]
```
## Credit
1. [codyc1515](https://github.com/codyc1515/homebridge-orbit-bhyve) who's code provide an initial framework as to how to set up various homebridge services and interact with the orbit device.
2. [blacksmithlabs](https://github.com/blacksmithlabs/orbit-bhyve-remote) who's code provide the method of using websockets to interact with the orbit device.