# homebridge-platform-orbit
Orbit Irrigation System platform plugin for [HomeBridge](https://github.com/nfarina/homebridge).

## Installation

1. Install this plugin using: npm install -g homebridge-platform-orbit
2. Edit ``config.json`` and add your login detail.
3. Run Homebridge

## Config.json example

"platforms": [
	{
		"platform": "orbit",
		"name" : "orbit",
		"email": "joe.blogs@gmail.com",
		"password": "MySecretPassword"
	}
]