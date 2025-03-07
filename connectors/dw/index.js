var LeoConfiguration = require("../../lib/configuration");

function DW(configure) {
	let configuration = new LeoConfiguration(configure);
	let api = require("./toDW")(configuration);
	return Object.assign((config) => {
		return new DW(config)
	}, {
		configuration: configuration,
		write: api.write,
		stream: api.stream,
		run: api.run
	})
}

module.exports = new DW();
