"use strict";
import extend from 'extend';
import file from './leo-sdk-config';
import type * as AWS from 'aws-sdk';
import {callable} from './util';

@callable
export class LeoConfig implements LeoBusConfig, LeoAwsConfig {
	bus?: LeoBusConfig;
	aws?: LeoAwsConfig;
	resources?: LeoResourcesConfig;
	_meta?: {region?: string};
	kinesis?: string;
	stream?: string;
	s3?: string;
	firehose?: string;
	region?: string;
	profile?: string;
	registry?: any;
	credentials?: AWS.Credentials;
	leo?: any;

	private doValidation = true;
	private updateListeners: Array<(config: LeoConfig) => void> = [];

	constructor(data?: boolean | Partial<LeoConfig>) {
		if (typeof data === "boolean") {
			this.doValidation = data;
			data = undefined;
		}

		this.update(data as Partial<LeoConfig>);

		if (this.doValidation) {
			this.validate();
		}
	}

	onUpdate(callback: (config: LeoConfig) => void): void {
		this.updateListeners.push(callback);
	}

	update(newConfig: Partial<LeoConfig> | LeoResourcesConfig | undefined | null): LeoConfig {
		let config: LeoConfig;
		newConfig = newConfig || global.leosdk;

		// Detect if they gave us a LeoResourcesConfig and turn it into a LeoConfig
		if (newConfig != null && ('LeoKinesisStream' in newConfig || 'LeoS3' in newConfig || 'LeoFirehoseStream' in newConfig)) {
			newConfig = {
				region: newConfig.Region,
				resources: newConfig,
				firehose: newConfig.LeoFirehoseStream,
				kinesis: newConfig.LeoKinesisStream,
				s3: newConfig.LeoS3
			};
		}

		var resources = {
			resources: process.env.Resources && JSON.parse(process.env.Resources) || {}
		};
		if ("leosdk" in process.env) {
			resources = JSON.parse(process.env["leosdk"]);
		}
		let profile = (typeof newConfig === "string" ? newConfig : null) || process.env.LEO_DEFAULT_PROFILE || "default";

		if (!file[profile] && profile != "default" && this.doValidation) {
			throw new Error(`Profile "${profile}" does not exist!`);
		}
		config = extend(true, {}, file[profile] || {}, resources, typeof newConfig === "object" ? newConfig : {});
		this.applyConfig(config);
		this.updateListeners.map(hook => hook(this));
		return this;
	}

	validate() {
		let errors = [];
		if (!this.aws.region) {
			errors.push("region")
		}
		if (!this.stream) {
			errors.push("kinesis")
		}
		if (!this.bus.s3) {
			errors.push("s3")
		}
		if (!this.bus.firehose) {
			errors.push("firehose")
		}
		if (errors.length > 0) {
			throw new Error("Invalid Settings: Missing " + errors.join(", "));
		}
	}
	setProfile(profile) {
		return this.update(profile);
	}

	private applyConfig(newConfig: LeoConfig) {
		newConfig = extend(true, {}, newConfig);
		this.bus = this.bus || {};
		this.aws = this.aws || {};
		this._meta = this._meta || {};
		var bus = newConfig.bus = newConfig.bus || {};
		var aws = newConfig.aws = newConfig.aws || {};

		if (newConfig.kinesis && !newConfig.stream) {
			newConfig.stream = newConfig.kinesis;
		}

		if (newConfig.s3 && !bus.s3) {
			bus.s3 = newConfig.s3;
		}

		if (newConfig.firehose && !bus.firehose) {
			bus.firehose = newConfig.firehose;
		}

		if (!newConfig.region) {
			newConfig.region = aws.region || (newConfig.resources && newConfig.resources.Region) || 'us-west-2'
		}

		if (newConfig.region && !aws.region) {
			aws.region = newConfig.region;
		}

		if (newConfig.profile && !aws.profile) {
			aws.profile = newConfig.profile;
		}

		let u = newConfig.update;
		delete newConfig.update;
		extend(true, this, newConfig);
		this._meta.region = this.aws.region;

		newConfig.update = u;
	}
}
export default LeoConfig;
module.exports = LeoConfig;

export interface LeoBusConfig {
	s3?: string;
	firehose?: string;
}
export interface LeoAwsConfig {
	region?: string;
	profile?: string;
}
export interface LeoResourcesConfig {
	LeoSystem?: any;
	LeoSettings?: any;
	LeoCron?: any;
	LeoEvent?: any;
	LeoStream?: any;
	Region?: string;
	LeoKinesisStream?: any;
	LeoS3?: any;
	LeoFirehoseStream?: any;
}

declare global {
	namespace NodeJS {
		interface Process {
			__config?: LeoConfig;
		}
	}
}
