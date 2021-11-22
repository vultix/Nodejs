"use strict";
class Ref {
	opts: any;
	type: string;
	id: string;

	constructor(data: any, opts?: any) {

		if (typeof opts === "string") {
			opts = {
				type: opts,
				forcedType: opts
			}
		}
		this.opts = opts = Object.assign({
			type: "queue",
			types: {
				"queue": "queue",
				"system": "system",
				"bot": "bot"
			},
			legacyMode: false
		}, opts);

		this.type = this.opts.forcedType || (this.opts.types[data.type] || this.opts.type).toLowerCase();
		this.id = (data.id == undefined ? data : data.id).toString().replace(/^[seb]_/, "");

		if (typeof data === "object") {
			Object.keys(data).map(key => {
				if (key != "type" && key != "id") {
					this[key] = data[key];
				}
			});
		}

		let parts;
		if (typeof data === "string" && (parts = data.match(/(system|queue|bot):(.*)/i))) {
			var t = parts[1].toLowerCase();
			this.type = this.opts.forcedType || this.opts.types[t] || t;
			this.id = parts[2];
		}
	}

	toString() {
		if (this.opts.legacyMode && this.type === "queue") {
			return `${this.id}`;
		} else {
			return `${this.type}:${this.id}`;
		}
	}
	refId() {
		return this.toString();
	}

	queue(subQueue?: string) {
		subQueue = subQueue && ("." + subQueue) || "";
		if (this.type === "queue") {
			return new Ref({
				id: `${this.id}${subQueue}`,
				type: "queue"
			});
		} else {
			var regex = new RegExp(`^${this.type}\.`);
			return new Ref({
				id: `${this.type}.${this.id.replace(regex, "")}${subQueue}`,
				type: "queue"
			});
		}
	}
	asQueue(subQueue) {
		return this.queue(subQueue);
	}

	owner() {
		if (this.type === "queue") {
			//let a = this.id.match(/^(bot|system)\.(.*?)(?:\.|$)/);
			let a = this.id.match(/^(bot|system)\.(.*?)(?:\.(.*))?$/);
			if (a) {
				return new Ref({
					id: a[2],
					type: a[1],
					queue: a[3] || undefined
				});
			}
		}
		return null;
	}

	static new(data, opts) {
		if (data instanceof Ref) {
			return data;
		} else {
			return new Ref(data, opts);
		}
	}
}

export default {
	refId: function (data, opts?: any) {
		var obj = this.ref(data, opts);
		return obj && obj.toString();
	},
	ref: function (data, opts?: any): Ref {
		return data && Ref.new(data, opts);
	},
	botRefId: function (data, opts?: any) {
		var obj = this.botRef(data, opts);
		return obj && obj.toString();
	},
	botRef: function (data, opts?: any) {
		return data && Ref.new(data, Object.assign({
			type: "bot"
		}, opts));
	},
	fixBotReferences: function (bot, opts?: any) {
		opts = Object.assign({
			checkpoints: false,
			source: true,
			destination: true,
			system: true,
			id: true
		}, opts);

		if (!bot) {
			return bot;
		}
		if (opts.id) {
			bot.id = this.refId(bot.id, "bot");
		}
		var settings = bot.lambda && bot.lambda.settings && bot.lambda.settings[0] || {};
		if (opts.source && settings.source) {
			settings.source = this.refId(settings.source)
		}

		if (opts.destination && settings.destination) {
			settings.destination = this.refId(settings.destination);
		}

		if (opts.system && bot.system) {
			bot.system = this.ref(bot.system, "system")
		}

		if (opts.checkpoints) {
			var checkpoints = {};
			Object.keys(bot.checkpoints).map(type => {
				var obj = checkpoints[type] = {};
				Object.keys(bot.checkpoints[type]).map(id => {
					obj[this.refId(id)] = bot.checkpoints[type][id];
				});
			});
			bot.checkpoints = checkpoints;
		}
		return bot;
	},
	fixSystemReferences: function (system, opts?: any) {
		opts = Object.assign({
			checksums: true,
			crons: true,
			id: true
		}, opts);

		if (opts.id) {
			system.id = this.refId(system.id, "system");
		}

		if (opts.crons && system.crons) {
			system.crons = system.crons.map(id => this.botRefId(id));
		}

		if (opts.checksums && system.checksums) {
			var checksums = {};
			Object.keys(system.checksums).map(id => {
				var refId = this.botRefId(id);
				var obj = system.checksums[id] || {};
				checksums[refId] = Object.assign({}, obj, {
					bot_id: refId,
					system: this.refId(obj.system, "system")
				});
			})
			system.checksums = checksums;
		}

		return system;
	}
};
