"use strict";
import {homedir} from 'os';
import path from 'path';
import fs from 'fs';
import extend from 'extend';
import aws from './lib/leo-aws';
import async from 'async';
import crypto from 'crypto';
import moment from 'moment';

let homeDir = homedir();
let configPath = path.resolve(`${homeDir}/.leo`, "config.json");
let configDir = path.dirname(configPath);
let parsed = parse();

let options = parsed.options;
let commands = parsed.commands;


if (commands[0] == "show") {
	let p = options.leoprofile || "default";
	console.log(`\nProfile: ${p}`);
	// TODO: TS - get isn't defined
	// @ts-ignore
	console.log(JSON.stringify(get()[p] || {}, null, 2));
} else {
	require("./lib/generateProfile")(commands[0], options, null, () => {});
}

function parse(): any {
	let optionsMap = {
		p: {
			name: "leoprofile",
			consume: 1
		},
		profile: {
			name: "leoprofile",
			consume: 1
		},
		kinesis: {
			name: "kinesis",
			consume: 1
		},
		s3: {
			name: "s3",
			consume: 1
		},
		firehose: {
			name: "firehose",
			consume: 1
		},
		r: {
			name: "region",
			consume: 1
		},
		region: {
			name: "region",
			consume: 1
		},
		s: {
			name: "stack",
			consume: 1
		},
		stack: {
			name: "stack",
			consume: 1
		},
		"aws-profile": {
			name: "awsprofile",
			consume: 1
		},
		awsprofile: {
			name: "awsprofile",
			consume: 1
		},
		"a": {
			name: "awsprofile",
			consume: 1
		}
	};
	let options = {};
	let commands = [];
	let regex = /^-(.)$|^--(.*)$/;
	let args = [].concat(process.argv.concat(process.execArgv));
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		var o = arg.match(regex);
		if (arg != "--" && o) {
			var c = optionsMap[o[1] || o[2]] || {
				name: o[1],
				consume: 0
			};
			var key = c.name;

			if (c.consume == 0) {
				options[key] = true;
			} else {
				if (!(args[i + c.consume] || "").match(regex)) {
					options[key] = args[i + c.consume];
					i += c.consume;
				}
			}
		} else if (i > 1) {
			commands.push(arg)
		}
	}

	return {
		options,
		commands
	};
}
