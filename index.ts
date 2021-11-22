"use strict";
import leoconfig from 'leo-config';
import LeoStream from './lib/stream/leo-stream';
import logging from './lib/logging';
import aws from './lib/leo-aws';
import * as AWS from 'aws-sdk';
import fs from 'fs';
import ini from 'ini';
import {execSync} from 'child_process';
import LeoConfig from './lib/configuration';

function SDK(id, data?: any): LeoSdk {
	if (typeof id !== "string") {
		data = id;
		id = data.id || "default_bot";
	}

	let configuration = new LeoConfig(data);

	let awsConfig = leoconfig.leoaws || configuration.aws;

	if (awsConfig.profile) {
		let profile = awsConfig.profile;
		let configFile = `${process.env.HOME || process.env.HOMEPATH}/.aws/config`;
		if (fs.existsSync(configFile)) {
			let config = ini.parse(fs.readFileSync(configFile, 'utf-8'));
			let p = config[`profile ${profile}`];
			if (p && p.mfa_serial) {
				let cacheFile = `${process.env.HOME || process.env.HOMEPATH}/.aws/cli/cache/${profile}--${p.role_arn.replace(/:/g, '_').replace(/[^A-Za-z0-9\-_]/g, '-')}.json`;
				let data: any = {};
				try {
					data = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
				} catch (e) {
					// Ignore error, Referesh Credentials
					data = {};
				} finally {
					console.log("Using cached AWS credentials", profile);
					if (!data.Credentials || new Date() >= new Date(data.Credentials.Expiration)) {
						execSync('aws sts get-caller-identity --duration-seconds 28800 --profile ' + profile);
						data = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
					}
				}
                // TODO: TS - what is this supposed to do?
                // @ts-ignore
				configuration.credentials = new aws.STS().credentialsFrom(data, data);
			} else {
				console.log("Switching AWS Profile", profile);
				configuration.credentials = new aws.SharedIniFileCredentials(awsConfig);
			}
		} else {
			console.log("Switching AWS Profile", awsConfig.profile);
			configuration.credentials = new aws.SharedIniFileCredentials(awsConfig);
		}
	}

	let logger = null;
	if (data && data.logging) {
		logger = logging(id, configuration);
	}

	let leoStream = new LeoStream(configuration);

    let constructor = function(id, data) {
        return SDK(id, data);
    } as LeoSdkConstructor;

    return Object.assign(constructor, {
		configuration: configuration,
		destroy: (callback) => {
			if (logger) {
				logger.end(callback);
			}
		},
		/**
		 * Stream for writing events to a queue
		 * @param {string} id - The id of the bot
		 * @param {string} outQueue - The queue into which events will be written
		 * @param {Object} config - An object that contains config values that control the flow of events to outQueue
		 * @return {stream} Stream
		 */
		load: leoStream.load.bind(leoStream),

		/**
		 * Process events from a queue.
		 * @param {Object} opts
		 * @param {string} opts.id - The id of the bot
		 * @param {string} opts.inQueue - The queue from which events will be read
		 * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue
		 * @param {function} opts.batch - A function to batch data from inQueue (optional)
		 * @param {function} opts.each - A function to transform data from inQueue or from batch function, and offload from the platform
		 * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
		 * @return {stream} Stream
		 */
		offload: leoStream.offload.bind(leoStream),

		/**
		 * Enrich events from one queue to another.
		 * @param {Object} opts
		 * @param {string} opts.id - The id of the bot
		 * @param {string} opts.inQueue - The queue from which events will be read
		 * @param {string} opts.outQueue - The queue into which events will be written
		 * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue and to outQueue
		 * @param {function} opts.transform - A function to transform data from inQueue to outQueue
		 * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
		 * @return {stream} Stream
		 */
		enrich: leoStream.enrich.bind(leoStream),

		read: leoStream.fromLeo.bind(leoStream),
		write: leoStream.toLeo.bind(leoStream),
		put: function(bot_id, queue, payload, callback) {
			let stream = this.load(bot_id, queue, {
				kinesis: {
					records: 1
				}
			});
			stream.write(payload);
			stream.end(callback);
		},
		checkpoint: leoStream.toCheckpoint.bind(leoStream),
		streams: leoStream,
		bot: leoStream.cron,
		aws: {
			dynamodb: leoStream.dynamodb,
			s3: leoStream.s3,
			cloudformation: new aws.CloudFormation({
				region: configuration.aws.region,
				credentials: configuration.credentials
			})
		}
	});
}
const defaultSdk = SDK(false);
module.exports = defaultSdk;

export interface LeoSdkConstructor {
    (config: Partial<LeoConfig>): LeoSdk;
    (id: string, config: Partial<LeoConfig>): LeoSdk;
}

export interface LeoSdk extends LeoSdkConstructor {
    configuration: LeoConfig;
    logger?: any;
    /**
     * Stream for writing events to a queue
     * @param {string} id - The id of the bot
     * @param {string} outQueue - The queue into which events will be written
     * @param {Object} config - An object that contains config values that control the flow of events to outQueue
     * @return {stream} Stream
     */
    load: LeoStream['load'];

    /**
     * Process events from a queue.
     * @param {Object} opts
     * @param {string} opts.id - The id of the bot
     * @param {string} opts.inQueue - The queue from which events will be read
     * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue
     * @param {function} opts.batch - A function to batch data from inQueue (optional)
     * @param {function} opts.each - A function to transform data from inQueue or from batch function, and offload from the platform
     * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
     * @return {stream} Stream
     */
    offload: LeoStream['offload'];

    /**
     * Enrich events from one queue to another.
     * @param {Object} opts
     * @param {string} opts.id - The id of the bot
     * @param {string} opts.inQueue - The queue from which events will be read
     * @param {string} opts.outQueue - The queue into which events will be written
     * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue and to outQueue
     * @param {function} opts.transform - A function to transform data from inQueue to outQueue
     * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
     * @return {stream} Stream
     */
    enrich: LeoStream['enrich'];

    read: LeoStream['fromLeo'];
    write: LeoStream['toLeo'];
    checkpoint: LeoStream['toCheckpoint'];
    streams: LeoStream;
    bot: LeoStream['cron'];
    aws: {
        dynamodb: LeoStream['dynamodb'];
        s3: LeoStream['s3'];
        cloudformation: AWS.CloudFormation
    };
}
