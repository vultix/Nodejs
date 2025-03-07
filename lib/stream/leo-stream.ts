"use strict";
import pump from 'pump';
import split from 'split2';
import zlib from 'zlib';
import write from 'flush-write-stream';
import AWS from '../leo-aws';
import https from 'https';
import {PassThrough} from 'stream';
import moment from 'moment';
import async from 'async';
import backoff from 'backoff';
import extend from 'extend';
import leoS3 from './helper/leos3';
import chunkEventStream from './helper/chunkEventStream';
import cronlib from '../cron';
import dynamo from '../dynamodb';
import refUtil from '../reference';
import _streams from '../streams';
import leo_logger from 'leo-logger';
import {promiseStreams} from 'leo-streams';
import es from 'event-stream';
import {LeoEvent, LeoStats, LeoStatsCheckpoint, LeoStreamOptions, StatsStream} from '../types';
import LeoConfig from '../configuration';
import {callable} from '../util';

const logger = leo_logger("leo-stream");
const twoHundredK = 1024 * 200;
const FIVE_MB_IN_BYTES = 1024 * 1024 * 5;

var pad = "0000000";
var padLength = -1 * pad.length;

@callable
export class LeoStream {
	configuration = this.configure;
	cron = new cronlib(this.configure);
	dynamodb = new dynamo(this.configure);
	s3 = new AWS.S3({
		apiVersion: '2006-03-01',
		httpOptions: {
			agent: new https.Agent({
				keepAlive: true
			})
		},
		credentials: this.configure.credentials,
		// s3ForcePathStyle: true,
		// endpoint: new AWS.Endpoint('http://localhost:4572')
	});

	through = _streams.through;
	passThrough = PassThrough;
	write = _streams.writeWrapped;
	cmd = _streams.cmd;
	pipeline = _streams.pipeline;
	split = _streams.split;
	gzip = _streams.gzip;
	gunzip = _streams.gunzip;
	pipe = _streams.pipe;
	stringify = _streams.stringify;
	parse = _streams.parse;
	fromCSV = _streams.fromCSV;
	toCSV = _streams.toCSV;
	asEvent = _streams.asEvent;
	log = _streams.log;
	devnull = _streams.devnull;
	counter = _streams.counter;
	buffer = _streams.buffer;
	bufferBackoff = _streams.bufferBackoff;
	batch = _streams.batch;

	private kinesis = new AWS.Kinesis({
		region: this.configure.aws.region,
		credentials: this.configure.credentials
	});
	private firehose = new AWS.Firehose({
		region: this.configure.aws.region,
		credentials: this.configure.credentials
	});
	private leo = this.configure.leo;
	private readonly CRON_TABLE = this.configure.resources.LeoCron;
	private readonly EVENT_TABLE = this.configure.resources.LeoEvent;

	constructor(private configure: LeoConfig) {
		configure.onUpdate((newConfigure) => {
			console.log("leo-stream.js config changed");
			[this.kinesis, this.firehose, this.s3].map(service => service.config.update({
				region: newConfigure.aws.region,
				credentials: newConfigure.credentials
			}));
		});

		process.__config = process.__config || configure;
		process.__config.registry = process.__config.registry || {};
		configure.registry = extend(true, process.__config.registry, configure.registry || {});

		if (global.isOverride) {
			global.isOverride(this);
		}
	}

	toGzipChunks(event, opts) {
		return chunkEventStream(this, event, opts);
	}
	toS3GzipChunks(event, opts, onFlush) {
		return leoS3(this, event, this.configure, opts, onFlush);
	}
	toS3(Bucket, File)  {
		var callback = null;
		var pass = new PassThrough();
		this.s3.upload({
			Bucket: Bucket,
			Key: File,
			Body: pass
		}, (err) => {
			logger.info("done uploading", err);
			callback(err);
		});
		return write((s, enc, done) => {
			if (!pass.write(s)) {
				pass.once('drain', () => {
					done();
				});
			} else {
				done();
			}
		}, (cb) => {
			callback = cb;
			pass.end();
		});
	}
	fromS3(file)  {
		let obj = this.s3.getObject({
			Bucket: file.bucket || file.Bucket,
			Key: file.key || file.Key,
			Range: file.range || undefined
		});
		let stream = obj.createReadStream();
		stream.destroy = stream.destroy || (() => {
			obj.abort();
		});
		[
			"httpHeaders",
			"httpUploadProgress",
			"httpDownloadProgress",
		].map(event=>{
			obj.on(event, (...args)=>{
				// console.log("Event:", event);
				stream.emit(event, ...args);
			});
		});
		return stream;
	}
	logSourceRead(id, inSystem, recordCount, opts, callback) {
		var types: any = {};

		[].slice.call(arguments).forEach(a => {
			var b = types[typeof (a)];
			if (!b) {
				b = types[typeof (a)] = [];
			}
			b.push(a);
		});

		/*
			id - the first string argument if there are 2 or more strings, otherwise it comes from config.registry.id
			inSystem - the second string argument if there are 2 or more strings, otherwise it is the first string
			callback - the first function argument
			opts - the  first object argument, otherwise {}
			recordCount - the first number, otherwise 0
		*/
		callback = types.function && types.function[0];
		opts = types.object && types.object[0] || {};
		id = types.string && types.string.length >= 2 && types.string[0] || this.configure.registry.id;
		inSystem = types.string && (types.string.length == 1 ? types.string[0] : types.string[1]);
		recordCount = types.number && types.number[0] || 0;
		opts = opts || {};

		inSystem = refUtil.ref(inSystem, "system").asQueue(opts.subqueue).id;
		id = refUtil.botRef(id).id;

		this.cron.checkpoint(id, inSystem, {
			eid: moment.now(),
			records: recordCount,
			started_timestamp: opts.timestamp,
			timestamp: opts.timestamp || moment.now(),
			source_timestamp: opts.source_timestamp || opts.event_source_timestamp || moment.now()
		}, function (err, data) {
			logger.error(err, data);
			if (callback) callback();
		});
	}
	logTargetWrite(id, outSystem, recordCount, opts, callback) {
		logger.info(id, outSystem);
		id = refUtil.botRef(id).id;
		outSystem = refUtil.ref(outSystem, "system").asQueue(opts.subqueue).id;
		if (typeof opts == "function") {
			callback = opts;
			opts = {};
		}
		opts = opts || {};
		this.putEvent(id, outSystem, {
			records: recordCount
		}, {
			metadata: {
				units: recordCount
			}
		}, callback);
	}
	load(id, outQueue, opts) {
		this.configure.validate();
		opts = Object.assign({
			useS3: false,
			autoDetectPayload: true
		}, opts || {});
		var args = [];

		args.push(this.through<LeoEvent<any>, LeoEvent<any>>((obj, done) => {
			var e;
			if (opts.autoDetectPayload && (obj.payload || obj.correlation_id)) {
				e = obj;
			} else {
				e = {
					payload: obj
				};
			}
			e.id = e.id || id;
			e.event = e.event || outQueue;
			if (!e.event_source_timestamp) {
				e.event_source_timestamp = moment.now();
			}
			if (!e.timestamp) {
				e.timestamp = moment.now();
			}
			done(null, e);
		}));
		if (opts.useS3 && !opts.firehose) {
			args.push(leoS3(this, outQueue, this.configure, {prefix: opts.prefix || id}));
		} else if (!opts.firehose) {
			// TODO: This should be part of auto switch
			args.push(promiseStreams.throughPromise(async (obj, push) => {
				let size = Buffer.byteLength(JSON.stringify(obj));
				if (size > twoHundredK * 3) {
					logger.info('Sending event to S3 because it exceeds the max size for DDB. ', size);
					await promiseStreams.pipelineAsync(
						es.readArray([obj]),
						leoS3(this, outQueue, this.configure, {prefix: opts.prefix || id}),
						promiseStreams.passThrough(newobj => {
							push(newobj);
						})
					);
				} else {
					push(obj);
				}
			}));
		}

		args.push(this.toLeo(id, opts));
		// else {
		// 	args.push(this.autoSwitch(outQueue, opts))
		// }
		args.push(this.toCheckpoint({
			debug: opts.debug,
			force: opts.force
		}));

		return this.pipeline.apply(this, args);
	}
	enrich(opts, callback) {
		this.configure.validate();
		var id = opts.id;
		var inQueue = opts.inQueue;
		var outQueue = opts.outQueue;
		var func = opts.transform || opts.each;
		let config = opts.config || {};

		config.start = config.start || opts.start;
		config.debug = opts.debug;

		var args = [];
		args.push(this.fromLeo(id, inQueue, config));

		if (opts.batch) {
			args.push(this.batch(opts.batch));
		}

		args.push(this.process(id, func, outQueue));
		if (opts.useS3 && !opts.firehose) {
			args.push(leoS3(this, outQueue, this.configure, {prefix: id}));
		}
		args.push(this.toLeo(id, opts));
		args.push(this.toCheckpoint({
			debug: opts.debug
		}));
		args.push(callback);
		return this.pipe.apply(this, args);
	}
	offload(opts, callback) {
		this.configure.validate();
		var id = opts.id;
		var inQueue = opts.inQueue || opts.queue;
		var func = opts.each || opts.transform;
		var batch: any = {
			size: 1,
			map: (payload, meta, done) => done(null, payload)
		};

		if (typeof opts.size != "object" && (opts.count || opts.records || opts.units || opts.time || opts.bytes)) {
			opts.size = {};
			opts.size.count = opts.count || opts.records || opts.units;
			opts.size.time = opts.time;
			opts.size.bytes = opts.size || opts.bytes;
			opts.size.highWaterMark = opts.highWaterMark || 2;

		}

		if (!opts.batch || typeof opts.batch === "number") {
			batch.size = opts.batch || batch.size;
		} else {
			batch.size = opts.batch.size || batch.size;
			batch.map = opts.batch.map || batch.map;
		}
		if (typeof batch.size != "object") {
			batch.size = {
				count: batch.size
			};
		}
		batch.size.highWaterMark = batch.size.highWaterMark || 2;

		var batchSize = typeof batch.size === "number" ? batch.size : (batch.size.count || batch.size.records);
		return this.pipe(
			this.fromLeo(id, inQueue, opts),
			this.through<any, any>((obj, done) => {
				batch.map(obj.payload, obj, (err, r, rOpts) => {
					rOpts = rOpts || {};
					if (err || !r) {
						done(err);
					} else {
						obj.payload = r;
						done(null, obj);
					}
				});
			}),
			this.batch(batch.size),
			this.through<any, any>({
				highWaterMark: 1
			}, (batch, done) => {
				batch.units = batch.payload.length;
				let last = batch.payload[batch.units - 1];
				if (batchSize == 1) {
					done(null, last);
				} else {
					batch.event_source_timestamp = last.event_source_timestamp;
					batch.event = last.event;
					batch.eid = last.eid;
					done(null, batch);
				}
			}),
			this.process(id, func, null, undefined, {
				highWaterMark: 1
			}),
			this.toCheckpoint({
				debug: opts.debug
			}), callback);
	}
	process(id, func, outQueue, onflush?: any, opts: LeoStreamOptions = {}) {
		var firstEvent;
		var lastEvent;
		var units;
		opts = Object.assign({}, opts || {});

		if (typeof outQueue == "function") {
			onflush = outQueue;
			outQueue = undefined;
		}
		if (onflush) {
			let flush = onflush;
			onflush = function (done) {
				let context = {
					push: (r, rOpts) => {
						rOpts = rOpts || {};
						if (typeof rOpts == "string") {
							rOpts = {
								queue: rOpts
							};
						}
						if (r === true || r) {
							this.push({
								id: id,
								event: rOpts.queue || outQueue,
								payload: r === true ? undefined : r,
								event_source_timestamp: rOpts.event_source_timestamp || lastEvent.event_source_timestamp,
								correlation_id: {
									source: rOpts.event || lastEvent.event,
									start: rOpts.eid || lastEvent.eid,
									units: rOpts.units || lastEvent.units || 1
								}
							});
						}
					}
				};
				flush.call(context, (err, r, rOpts) => {
					rOpts = rOpts || {};
					if (typeof rOpts == "string") {
						rOpts = {
							queue: rOpts
						};
					}
					if (err) {
						done(err);
					} else {
						context.push(r, rOpts);
						done();
					}
				});
			};
		}

		function reset() {
			firstEvent = null;
			units = 0;
		}

		reset();

		return this.through<LeoEvent<any>, LeoEvent<any>>({
			highWaterMark: opts.highWaterMark
		}, function (obj, done) {
			if (!firstEvent) {
				firstEvent = obj;
			}
			lastEvent = obj;
			units += obj.units || 1;
			let context = {
				push: (r, rOpts) => {
					rOpts = rOpts || {};
					if (typeof rOpts == "string") {
						rOpts = {
							queue: rOpts
						};
					}
					if (r === true) { //then we handled it, though it didn't create an object
						this.push({
							id: id,
							event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
							eid: rOpts.eid || obj.eid,
							correlation_id: {
								source: obj.event,
								start: rOpts.eid || obj.eid,
								units: rOpts.units || obj.units || 1
							}
						});
					} else if (r) { //then we are actually writing an object
						this.push({
							id: id,
							event: rOpts.queue || outQueue,
							payload: r,
							event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
							eid: rOpts.eid || obj.eid,
							correlation_id: {
								source: obj.event,
								[rOpts.partial === true ? 'partial_start' : 'start']: rOpts.eid || obj.eid,
								units: rOpts.units || obj.units || 1
							}
						});
					}
				}
			};

			/**calledDone is so that we support the common pattern of i
			 * if(condition) {
			 *   return done();
			 *}
			 **/
			let calledDone = false;
			let result = func.call(context, obj.payload, obj, (err, r, rOpts) => {
				calledDone = true;
				rOpts = rOpts || {};
				if (typeof rOpts == "string") {
					rOpts = {
						queue: rOpts
					};
				}
				if (err) {
					done(err);
				} else if (r === true) { //then we handled it, though it didn't create an object
					done(null, {
						id: id,
						event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
						eid: rOpts.eid || obj.eid,
						correlation_id: {
							source: obj.event,
							start: rOpts.eid || obj.eid,
							units: rOpts.units || obj.units || 1
						}
					});
				} else if (r) { //then we are actually writing an object
					done(null, {
						id: id,
						event: rOpts.queue || outQueue,
						payload: r,
						event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
						eid: rOpts.eid || obj.eid,
						correlation_id: {
							source: obj.event,
							start: rOpts.eid || obj.eid,
							units: rOpts.units || obj.units || 1
						}
					});
				} else {
					done();
				}
			});
			//They did a promise
			if (result && result.then) {
				result.then(() => done(null, {
					id: id,
					event_source_timestamp: obj.event_source_timestamp,
					eid: obj.eid,
					correlation_id: {
						source: obj.event,
						start: obj.eid,
						units: obj.units || 1
					}
				})).catch(done);
			} else if (!calledDone && result) {
				done(null, {
					id: id,
					event: outQueue,
					payload: result,
					event_source_timestamp: obj.event_source_timestamp,
					eid: obj.eid,
					correlation_id: {
						source: obj.event,
						start: obj.eid,
						units: obj.units || 1
					}
				});
			}
		}, onflush);
	}
	toLeo(ID, opts?: any)  {
		opts = opts || {};
		let defaults = {
			s3: {
				records: 1,
				useS3: true,
				time: {
					milliseconds: 1000 * 10
				},
				chunk: {
					label: "chunk",
					useS3: true
				}
			},
			firehose: {
				records: 10000,
				size: 1024 * 900,
				useS3: false,
				time: {
					milliseconds: 1000
				}
			},
			kinesis: {
				records: 100,
				size: 1024 * 200,
				time: {
					milliseconds: 200
				}
			}
		};
		var type = "kinesis";
		if (opts.useS3 && !opts.firehose) { //why would both of these be set?
			type = "s3";
		} else if (opts.firehose) {
			type = "firehose";
		}
		opts = Object.assign({
			label: "toLeo",
			debug: true,
			enableLogging: true,
			chunk: {
				label: "chunk"
			},
			checkpoint: false
		}, defaults[type], opts || {});

		var records, correlations;

		function reset() {
			records = [];
			correlations = [];
		}
		reset();

		var retry = backoff.fibonacci({
			randomisationFactor: 0,
			initialDelay: 1,
			maxDelay: 1000
		});
		retry.failAfter(10);
		retry.success = function() {
			retry.reset();
			retry.emit("success");
		};
		retry.run = function(callback) {
			let fail = (err) => {
				retry.removeListener('success', success);
				callback(err || 'failed');
			};
			let success = () => {
				retry.removeListener('fail', fail);
				var c = correlations;
				reset();
				p.emit("flushed", {
					id: ID,
					correlations: c
				});
				callback(null, {
					__cmd: "checkpoint",
					id: ID,
					correlations: c
				});
			};

			retry.once('fail', fail).once('success', success);
			retry.backoff();
		};
		retry.on('ready', (number, delay) => {
			if (records.length === 0) {
				retry.success();
			} else if (opts.firehose) {
				logger.debug("sending", records.length, number, delay);
				logger.time("firehose request");
				this.firehose.putRecordBatch({
					Records: [{
						Data: records.join('')
					}],
					DeliveryStreamName: this.configure.bus.firehose
				}, function(err, data) {
					logger.debug(process.memoryUsage());
					if (err) {
						logger.error(err);
						retry.backoff();
					} else if (data.FailedPutCount && data.FailedPutCount > 0) {
						var left = [];
						for (var i = 0; i < data.RequestResponses.length; i++) {
							var row = data.RequestResponses[i];
							if (row.ErrorCode) {
								left.push(records[i]);
							}
						}
						logger.info(`Count failed firehose put record batch (failed, retry):(${data.FailedPutCount},${left.length})`);
						records = left;
						retry.backoff();
					} else {
						logger.timeEnd("firehose request");
						retry.success();
					}
				});

			} else {
				logger.debug("sending", records.length, number, delay);
				logger.time("kinesis request");
				this.kinesis.putRecords({
					Records: records.map((r) => {
						return {
							Data: r,
							PartitionKey: "0",
							ExplicitHashKey: (opts.partitionHashKey || 0).toString()
						};
					}),
					StreamName: this.configure.stream
				}, function(err, data) {
					if (err) {
						logger.error(err);
						retry.backoff();
					} else if (data.FailedRecordCount && data.FailedRecordCount > 0) {
						var left = [];
						for (var i = 0; i < data.Records.length; i++) {
							var row = data.Records[i];
							if (row.ErrorCode) {
								left.push(records[i]);
							}
						}
						logger.info(`Count failed kinesis put records (failed, retry):(${data.FailedRecordCount},${left.length})`);
						records = left;
						retry.backoff();
					} else {
						logger.timeEnd("kinesis request");
						retry.success();
					}
				});
			}
		});

		var chunkOpts = Object.assign({
			records: 100,
			size: 1024 * 200,
			time: {
				milliseconds: 200
			},
			debug: false,
			enableLogging: true,
			snapshot: opts.snapshot
		}, opts.chunk || {});
		chunkOpts.gzip = !opts.firehose;

		var p = this.buffer(opts, function(obj, callback) {
			if (obj.records > 0) {
				if (obj.gzip) {
					records.push(obj.gzip);
				} else if (obj.s3) {
					records.push(zlib.gzipSync(JSON.stringify(obj) + "\n"));
				}
			}
			if (obj.correlations) {
				if (Array.isArray(obj.correlations)) {
					correlations = correlations.concat(obj.correlations);
				} else {
					correlations.push(obj.correlations);
				}
			}
			delete obj.buffer;
			callback(null, (obj.gzip || obj.s3) && {
				records: 1,
				size: obj.gzipSize
			});
		}, retry.run, function flush(callback) {
			logger.info("toLeo On Flush");
			callback();
		});

		let streams = [];
		streams.push(chunkEventStream(this, null, chunkOpts));
		streams.push(p);
		if (opts.checkpoint) {
			// streams.push(this.cmd({
			// 	onCheckpoint: (obj, done) => {
			// 		console.log(obj);
			// 		done(null, obj);
			// 	}
			// }));
		}
		return this.pipeline.apply(this, streams);
	}
	toManualCheckpoint(id, opts)  {
		var cp = this.toCheckpoint(Object.assign({
			records: Number.POSITIVE_INFINITY,
			time: {
				days: 20
			},
			size: Number.POSITIVE_INFINITY
		}, opts));
		var pass: any = this.pipeline(
			this.process(id, (a, e, d) => d(null, true), null),
			this.through((obj, done) => {
				var result = cp.write(obj);
				if (!result) {
					cp.once("drain", () => {
						done();
					});
				} else {
					done();
				}
				return;
			}));

		pass.finish = (cb) => cp.end(cb);
		pass.flush = (cb) => cp.flush(cb);
		// TODO: TS - BufferedStream doesn't seem to have a get method on it
		// pass.get = (bot, queue) => cp.get(bot, queue);
		return pass;
	}
	stats(id, event, opts)  {
		let newStats = (): LeoStats => {
			return {
				eid: null,
				units: 0,
				source_timestamp: null,
				started_timestamp: null,
				ended_timestamp: null
			};
		};
		let stats = newStats();
		let stream = this.through<any, any>((event, done) => {
			let timestamp = Date.now();
			let start = (event.event_source_timestamp || timestamp);

			stats.source_timestamp = stats.source_timestamp ? Math.min(start, stats.source_timestamp) : start;
			stats.started_timestamp = stats.started_timestamp ? Math.max(timestamp, stats.started_timestamp) : timestamp;
			stats.ended_timestamp = stats.ended_timestamp ? Math.max(timestamp, stats.ended_timestamp) : timestamp;
			stats.eid = event.eid;
			stats.units += event.units || 1;
			stats.start_eid = stats.start_eid || event.eid;
			done(null, event);
		}) as StatsStream;

		const checkpoint = (params, done) => {
			if (typeof params === "function") {
				done = params;
				params = {};
			}
			let data = Object.assign(stats, params);
			logger.debug("Stats", data);
			if (id && event && data.units > 0) {
				this.cron.checkpoint(id, event, data, (err) => {
					err && console.log("Stats error:", err);
					stats = newStats();
					done(err, data);
				});
			} else {
				done(null, data);
			}
		};

		stream.checkpoint = checkpoint as LeoStatsCheckpoint;

		stream.checkpoint.stream = this.through((o, d) => d(null, o), (done) => {
			stream.checkpoint(opts || {}, done);
		});
		stream.get = function() {
			return stats;
		};
		return stream;
	}
	checkpoint(opts, stream)  {
		opts = Object.assign({
			records: 1000,
			time: {
				seconds: 10
			},
			debug: false
		}, opts || {});

		let newStats = () => {
			return {};
		};

		let getStats = (botId, queue) => {
			botId = refUtil.botRefId(botId);
			queue = refUtil.refId(queue);
			if (!(botId in stats)) {
				stats[botId] = {};
			}
			if (!(queue in stats[botId])) {
				stats[botId][queue] = {
					eid: null,
					units: 0,
					source_timestamp: null,
					started_timestamp: null,
					ended_timestamp: null
				};
			}

			return stats[botId][queue];
		};
		let stats = newStats();

		if (stream == null) {
			stream = this.through(function(event, done) {
				done(null, event);
			});
		}

		stream.visit = (event, done) => {
			let timestamp = event.timestamp || Date.now();
			let start = (event.event_source_timestamp || timestamp);

			let stat = getStats(event.id, event.event);

			stat.source_timestamp = stat.source_timestamp ? Math.min(start, stat.source_timestamp) : start;
			stat.started_timestamp = stat.started_timestamp ? Math.max(timestamp, stat.started_timestamp) : timestamp;
			stat.ended_timestamp = stat.ended_timestamp ? Math.max(timestamp, stat.ended_timestamp) : timestamp;
			stat.eid = event.eid;
			stat.units += event.units || 1;
			stat.start_eid = stat.start_eid || event.eid;

			if (done) {
				done(null, event);
			}
		};

		stream.checkpoint = function(params, done) {
			if (typeof params === "function") {
				done = params;
				params = {};
			}

			logger.debug("Stats", stats);

			var tasks = [];
			for (var id in stats) {
				var bot = stats[id];
				for (var queue in bot) {
					let checkpoint = Object.assign(bot[queue], params);
					if (checkpoint.units > 0) {
						tasks.push((done) => {
							//cron.checkpoint(id, queue, checkpoint, done);
							console.log("Did checkpoint", id, queue, checkpoint);
							done();
						});
					}
				}
			}
			async.parallelLimit(tasks, 10, (err, results) => {
				err && console.log("Stats error:", err);
				stats = newStats();
				done(err);
			});
		};
		stream.checkpoint.stream = this.through((o, d) => d(null, o), (done) => {
			stream.checkpoint(opts || {}, done);
		});
		stream.on("checkpoint", (opts) => {
			// TODO: TS - this done parameter isn't defined, what is it supposed to reference?
			// @ts-ignore
			stream.checkpoint(opts || {}, done);
		});
		stream.getCheckpoint = function(botId, queue) {
			return getStats(botId, queue);
		};


		let write = stream._write;
		stream._write = function(event, enc, done) {
			let r = write(event, enc, (err, data) => {
				if (!err) {
					stream.visit(event);
				}
				return done(err, data);
			});
			return r;
		};
		stream.on("finish", function() {
			console.log("finish");
			stream.checkpoint(opts || {}, () => {});
		});
		stream.on("end", function() {
			console.log("end", arguments);
			stream.checkpoint(opts || {}, () => {});
		});

		return stream;
	}
	toCheckpoint(opts)  {
		opts = Object.assign({
			records: 1000,
			time: {
				seconds: 10
			},
			debug: false
		}, opts || {});

		var checkpoints = {};

		const doCheckpoint = (callback) => {
			logger.debug(JSON.stringify(checkpoints, null, 2));

			var tasks = [];
			for (var id in checkpoints) {
				var bot = checkpoints[id];
				for (var event in bot) {
					var checkpoint = bot[event];
					tasks.push((done) => {
						this.cron.checkpoint(id, event, checkpoint, done);
					});
				}
			}
			async.parallelLimit(tasks, 10, (err, results) => {
				checkpoints = {};
				callback(err);
			});
		}

		let result = this.buffer({
			writeStream: true,
			label: "toCheckpoint",
			time: opts.time,
			size: opts.size,
			records: opts.records,
			buffer: opts.buffer,
			debug: opts.debug,
			commands: {
				ignoreCommands: ["checkpoint"]
			}
		}, function(update, callback) {
			var id = update.id;
			var correlations = update.correlations;

			if (!correlations && update.correlation_id && update.correlation_id.source) {

				let timestamp = update.timestamp || Date.now();
				let start = (update.event_source_timestamp || timestamp);
				correlations = [{
					[update.correlation_id.source]: {
						start: update.correlation_id.start || undefined,
						end: update.correlation_id.end || update.correlation_id.start,
						records: update.correlation_id.units || 1,
						source_timestamp: start,
						timestamp: timestamp
					}
				}];
			}

			if (!(id in checkpoints)) {
				checkpoints[id] = {};
			}
			var c = checkpoints[id];

			var records = 0;
			correlations.forEach((correlation) => {
				for (var event in correlation) {
					var u = correlation[event];
					if (!(event in c)) {
						c[event] = {
							eid: u.end,
							records: u.records,
							source_timestamp: u.source_timestamp,
							ended_timestamp: u.timestamp,
							started_timestamp: u.timestamp,
							force: opts.force
						};
					} else {
						c[event].eid = u.end;
						c[event].records += u.records;
						c[event].source_timestamp = Math.min(c[event].source_timestamp, u.source_timestamp);
						c[event].ended_timestamp = Math.max(c[event].ended_timestamp, u.timestamp);
						c[event].started_timestamp = Math.max(c[event].started_timestamp, u.timestamp);
					}

					records += u.records;
				}
			});

			callback(null, {
				records: records
			});

		}, doCheckpoint, function flush(callback) {
			logger.debug("all checkpointed");
			callback();
		});
		(result as any).get = function(bot, queue) {
			let b = queue && bot && checkpoints[refUtil.botRef(bot).id];
			return b && b[refUtil.ref(queue).id];
		};
		return result;
	}
	fromLeo(ID, queue, opts) {
		opts = opts || {};
		queue = refUtil.ref(queue).queue(opts.subqueue).id;
		if (!opts.stopTime && this.configure.registry && this.configure.registry.context) {
			opts.stopTime = moment.now() + (this.configure.registry.context.getRemainingTimeInMillis() * 0.8);
		}
		if (!opts.stopTime && opts.runTime) {
			opts.stopTime = moment().add(opts.runTime).valueOf();
		}

		logger.info(opts);
		opts = Object.assign({
			buffer: 16,
			loops: 100,
			start: null,
			limit: Number.POSITIVE_INFINITY,
			size: Number.POSITIVE_INFINITY,
			debug: false,
			stopTime: moment().add(240, "seconds"),
			stream_query_limit: opts.fast_s3_read ? 1000 : 50,
			fast_s3_read: false,
			fast_s3_read_parallel_fetch_max_bytes: FIVE_MB_IN_BYTES
		}, opts || {});
		logger.info(opts);

		var pass = new PassThrough({
			highWaterMark: opts.buffer,
			objectMode: true
		}) as any;
		var hasTime = true;

		// tracks if we've passed destroy on the passthrough
		let isPassDestroyed = false;

		pass.destroy = function() {
			hasTime = false;
			// we have destroyed pass
			isPassDestroyed = true;
			hasTimeTimeout && clearTimeout(hasTimeTimeout);
		};

		pass.on("end", () => {
			hasTimeTimeout && clearTimeout(hasTimeTimeout);
		});
		let hasTimeTimeout = setTimeout(() => {
			pass.destroy();
			console.log("Called timeout");
		}, opts.stopTime - Date.now());

		let newStats = (): LeoStats => {
			return {
				eid: null,
				units: 0,
				source_timestamp: null,
				started_timestamp: null,
				ended_timestamp: null
			};
		};
		let stats = newStats();
		let updateStats = (event) => {
			let timestamp = Date.now();
			let start = (event.event_source_timestamp || timestamp);

			stats.source_timestamp = stats.source_timestamp ? Math.min(start, stats.source_timestamp) : start;
			stats.started_timestamp = stats.started_timestamp ? Math.max(timestamp, stats.started_timestamp) : timestamp;
			stats.ended_timestamp = stats.ended_timestamp ? Math.max(timestamp, stats.ended_timestamp) : timestamp;
			stats.eid = event.eid;
			stats.units += event.units || 1;
			stats.start_eid = stats.start_eid || event.eid;
		};
		pass.checkpoint = (params, done) => {
			if (typeof params === "function") {
				done = params;
				params = {};
			}
			let data = Object.assign(stats, params);
			logger.debug("Stats", data);
			if (ID && queue && data.units > 0) {
				this.cron.checkpoint(ID, queue, data, (err) => {
					err && console.log("Stats error:", err);
					stats = newStats();
					done(err, data);
				});
			} else {
				done(null, data);
			}
		};
		pass.get = function() {
			return stats;
		};
		this.dynamodb.docClient.batchGet({
			RequestItems: {
				[this.CRON_TABLE]: {
					Keys: [{
						id: ID
					}]
				},
				[this.EVENT_TABLE]: {
					Keys: [{
						event: queue
					}]
				}
			}
		},  (err, docs) => {
			if (err) {
				if (err.message == 'The provided key element does not match the schema') {
					console.log(ID, queue);
				}
				throw new Error(err.toString());
			} else if (docs.UnprocessedKeys !== undefined && Object.keys(docs.UnprocessedKeys).length > 0) {
				throw new Error("Not enough capacity to read");
			}


			var start = null;
			var leoEvent, leoCron;
			if (Object.keys(docs.UnprocessedKeys).length >= 1) {
				pass.end();
				return;
			} else if (!docs.Responses || !docs.Responses[this.EVENT_TABLE] || docs.Responses[this.EVENT_TABLE].length === 0) { //There are no events that are processable
				pass.end();
				return;
			} else {
				leoEvent = docs.Responses[this.EVENT_TABLE][0];
			}


			//start from today earliest if no checkpoint specified.
			let defaultCheckpointStart = "z/" + moment().format("YYYY/MM/DD");
			let archive_end = null;

			let snapshotNext = null;
			let snapshotStart = null;
			let snapshotEnd = null;
			let usingSnapshot = false;
			let usingArchive = false;
			let originalQueue = queue;
			if (leoEvent) {
				if (leoEvent.snapshot) {
					snapshotNext = leoEvent.snapshot.next;
					snapshotStart = leoEvent.snapshot.start;
				}
				if (leoEvent.archive) {
					archive_end = leoEvent.archive.end;
				}
			}
			var queueRef = refUtil.refId(queue);
			leoCron = docs.Responses && docs.Responses[this.CRON_TABLE] && docs.Responses[this.CRON_TABLE][0];
			if (opts.start) {
				start = opts.start + " "; //we want it to start after this one
			} else if (this.configure.registry && this.configure.registry.__cron && this.configure.registry.__cron.starteid && this.configure.registry.__cron.starteid[queueRef]) {
				start = this.configure.registry.__cron.starteid[queueRef];
			} else if (docs.Responses && docs.Responses[this.CRON_TABLE] && docs.Responses[this.CRON_TABLE][0]) { //There are no cron jobs, not possible to stream
				if (leoCron.checkpoint && !leoEvent.v) {
					start = leoCron.checkpoint;
				} else if (leoCron.checkpoints && leoCron.checkpoints.read && leoCron.checkpoints.read[queueRef]) {
					start = leoCron.checkpoints.read[queueRef].checkpoint || defaultCheckpointStart;
				} else {
					start = defaultCheckpointStart;
				}
			} else {
				start = defaultCheckpointStart;
			}


			console.log("Reading event from", start);

			//We want to first use a _snapshot if it exists
			//This means they have to set it to "z/" manually in order to get a snapshot, we won't do a snapshot by default.
			if ((start == "z/" || start == "z/ ") && snapshotStart) {
				start = snapshotStart;
			}
			//If we are using the snapshot, we go to a special queue
			//This could be checkpointed OR because they specified "z/" and converted it
			if (start.match(/^_snapshot/)) {
				queue += "/_snapshot";
				usingSnapshot = true;

				//Don't want to move onto the next snapshot
				snapshotEnd = start.replace(/[^/]+$/, '9999999999');
			}

			if (archive_end && archive_end.localeCompare(start) > 0) {
				queue += "/_archive";
				usingArchive = true;
			}

			if (start === null) { //We will not run unless we got a start
				pass.end();
				return;
			}

			var checkpointData = ["registry", "__cron", "checkpoints", "read"].reduce((o, f) => o[f] = o[f] || {}, this.configure);
			checkpointData[queueRef] = leoCron && leoCron.checkpoints && leoCron.checkpoints.read && leoCron.checkpoints.read[queueRef];

			var count = 0;
			pass.throttledWrite = (obj, callback) => {
				count++;
				start = obj.eid + " "; //we want it to continue after this one
				updateStats(obj);
				obj.event = originalQueue;
				if (!pass.write(obj)) {
					logger.debug("back pressure");
					pass.once('drain', () => {
						logger.debug("back pressure done");
						callback();
					});
				} else {
					callback();
				}
			};

			function max(...numbers: number[]): number {
				var max = numbers[0];
				for (var i = 1; i < numbers.length; ++i) {
					if (numbers[i] != null && numbers[i] != undefined) {
						max = max > numbers[i] ? max : numbers[i];
					}
				}
				return max;
			}

			let getEvents;
			let max_eid: string;
			let table_name: string;
			let eid: string;
			let range_key: string;

			if (leoEvent.v >= 2 || !leoEvent.max_eid) {
				max_eid = (this.configure.registry && this.configure.registry.__cron && this.configure.registry.__cron.maxeid) || opts.maxOverride || leoEvent.max_eid || '';
				table_name = this.configure.resources.LeoStream;
				eid = "eid";
				range_key = "end";

				getEvents = (callback) => {
					var params = {
						TableName: table_name,
						KeyConditionExpression: "#event = :event and #key between :start and :maxkey",
						ExpressionAttributeNames: {
							"#event": "event",
							"#key": range_key,
						},
						Limit: opts.stream_query_limit || 50,
						ExpressionAttributeValues: {
							":event": queue,
							":maxkey": usingSnapshot ? snapshotEnd.replace("_snapshot/", "") + 9 : max_eid,
							":start": usingSnapshot ? start.replace("_snapshot/", "") : start
						},
						"ReturnConsumedCapacity": 'TOTAL'
					};
					logger.debug(params);
					this.dynamodb.docClient.query(params, function (err, data) {
						logger.debug("Consumed Capacity", data && data.ConsumedCapacity);
						if (err) {
							logger.error(err);
							callback(err);
							return;
						}
						callback(null, data.Items);
					});
				};
			} else {
				max_eid = max(leoEvent.kinesis_number, leoEvent.s3_kinesis_number, leoEvent.initial_kinesis_number, leoEvent.s3_new_kinesis_number).toString(10);
				table_name = "Leo";
				eid = "kinesis_number";
				range_key = "kinesis_number";

				getEvents = (callback) => {
					let q = refUtil.ref(queueRef).queue().id;
					this.leo.getEvents(ID, q, Object.assign({}, opts, {
						start: start
					}), (err, events, checkpoint) => {
						err && logger.error(err);
						callback(err, events);
					});
				};
			}

			var hasMoreEvents = true;
			var hasLoops = opts.loops;
			var totalCount = 0;
			var totalSize = 0;

			if (usingSnapshot || max_eid.localeCompare(start) > 0) {
				async.whilst(() => {
						logger.debug("checking next loop, loops remaining ", hasLoops, ", Time Remaining:", opts.stopTime - moment.now());
						hasTime = hasTime && (opts.stopTime > moment.now());
						logger.debug(totalCount, opts.limit, totalSize, opts.size, hasMoreEvents, hasTime, hasLoops, max_eid, start, (usingSnapshot || max_eid.localeCompare(start)));
						return totalCount < opts.limit && totalSize < opts.size && hasMoreEvents && hasTime && hasLoops && (usingSnapshot || max_eid.localeCompare(start) > 0);
					}, (done) => {
						var count = 0;
						hasLoops--;
						getEvents((err, items) => {
							if (err) {
								return done(err);
							}
							logger.debug("found", items.length, "items");
							if (items.length == 0) {
								if (usingSnapshot) { //Then let's go back to the real queue
									queue = originalQueue;
									start = snapshotNext;
									usingSnapshot = false;
									return done();
								} else if (usingArchive) { //Then let's go back to the real queue
									queue = originalQueue;
									usingArchive = false;
									return done();
								} else {
									logger.debug("no more events");
									hasMoreEvents = false;
									return done();
								}
							}

							var counts = 0;
							var size = 0;
							var bytes = 0;
							let s3_streams = {};
							let last_s3_index = 0;
							let get_s3_stream = (index) => {
								let agg_bytes = 0;
								// Connect to as many S3 files as possible while only holding the configured mbs of
								// event data in front of it
								for (; last_s3_index < items.length && bytes < opts.fast_s3_read_parallel_fetch_max_bytes; last_s3_index++) {
									agg_bytes += items[last_s3_index].size; // Accounts for any non S3 data between S3 files

									// Create a stream for this S3 file
									if (items[last_s3_index].s3 != null) {

										// Add to the total bytes waiting to be processed
										bytes += agg_bytes;
										s3_streams[last_s3_index] = {
											bytes: agg_bytes,
											stream: create_s3_stream(items[last_s3_index])
										};
										agg_bytes = 0;
									}
								}
								return s3_streams[index].stream;
							};

							// Remove this streams byte count from the bytes waiting to be processed
							let free_s3_stream = (index) => {
								if (s3_streams[index] != null) {
									bytes -= s3_streams[index].bytes;
								}
								delete s3_streams[index];
							}


							let create_s3_stream = (item) => {
								if (item.s3 && item.end.localeCompare(start) > 0) {
									if (item.start) {
										var _parts = item.start.split(/-/);
										var prefix = _parts[0];
										var idOffset = parseInt(_parts[1]);
									}

									let createEId = null;
									if (usingSnapshot) {
										createEId = function(eid) {
											return "_snapshot/" + prefix + "-" + (pad + (idOffset + eid)).slice(padLength);
										};
									} else {
										createEId = function(eid) {
											return prefix + "-" + (pad + (idOffset + eid)).slice(padLength);
										};
									}
									var fileOffset = null;
									var fileEnd = item.gzipSize;

									for (let i = 0; i < item.offsets.length; i++) {
										var offset = item.offsets[i];

										let endEID;
										if (item.archive) {
											endEID = offset.end;
										} else {
											endEID = createEId(offset.end);
										}

										if (start.localeCompare(endEID) < 0) {
											if (fileOffset == null) {
												fileOffset = offset.gzipOffset;
												idOffset += offset.start;
											}
										}
									}

									var file = item.s3;
									file.range = `bytes=${fileOffset}-${fileEnd}`;
									return this.fromS3(file);
								}
								return null;
							}

							async.eachOfSeries(items, (item, i, done) => {
									var cb = done;
									done = (err) => {
										if (item.s3 != null) {
											free_s3_stream(i);
										}
										// TODO: TS - What arguments are trying to be referenced here?
										// @ts-ignore
										process.nextTick(() => cb.apply(cb, arguments));
									};
									if (totalCount >= opts.limit || totalSize >= opts.size || !hasTime || isPassDestroyed) {
										return done();
									}
									if (item.start) {
										var _parts = item.start.split(/-/);
										var prefix = _parts[0];
										var idOffset = parseInt(_parts[1]);
									}

									let createEId = null;
									if (usingSnapshot) {
										createEId = function(eid) {
											return "_snapshot/" + prefix + "-" + (pad + (idOffset + eid)).slice(padLength);
										};
									} else {
										createEId = function(eid) {
											return prefix + "-" + (pad + (idOffset + eid)).slice(padLength);
										};
									}

									if (item.s3) {
										if (item.end.localeCompare(start) > 0) { //Then it is greater than the event they were looking at
											//let's figure out where we should jump into this file.
											let s3Stream;

											if (opts.fast_s3_read) {
												s3Stream = get_s3_stream(i);
											} else {
												var fileOffset = null;
												var fileEnd = item.gzipSize;
												var recordOffset = 0;

												for (let i = 0; i < item.offsets.length; i++) {
													var offset = item.offsets[i];

													let endEID;
													if (item.archive) {
														endEID = offset.end;
													} else {
														endEID = createEId(offset.end);
													}

													if (start.localeCompare(endEID) < 0) {
														logger.debug(start, offset.start, offset.end);
														counts += offset.records; //is this right?
														size += offset.size; //this isn't exact when getting in the middle of a file, but close enough
														if (fileOffset == null) {
															fileOffset = offset.gzipOffset;
															idOffset += offset.start;
														}
														if (counts >= opts.limit || size >= opts.size) {
															fileEnd = offset.gzipOffset + offset.gzipSize - 1;
															break;
														}
													}
												}

												var file = item.s3;
												file.range = `bytes=${fileOffset}-${fileEnd}`;
												logger.debug(file.range);
												s3Stream = this.fromS3(file);
											}
											var eid = 0;
											let gzipStream = zlib.createGunzip();
											gzipStream.setEncoding('utf8');
											gzipStream.on('error', function(err) {
												logger.debug("Skipping gzip");
											});
											pump(s3Stream, gzipStream, split((value) => {
												try {
													return {
														length: Buffer.byteLength(value),
														obj: JSON.parse(value)
													};
												} catch (e) {
													//If we cancel the download early, we don't want to die here.
													return null;
												}
											}), this.write((obj, done) => {
												var e = obj.obj;
												if (!item.archive) {
													e.eid = createEId(eid++);
												}
												let isGreaterThanStart = e.eid.localeCompare(start) > 0;

												if (!isPassDestroyed && isGreaterThanStart && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
													totalCount++;
													totalSize += obj.length;
													pass.throttledWrite(e, done);
												} else { //otherwise it means we had a number in the middle of a file
													if (isPassDestroyed || totalCount >= opts.limit || totalSize >= opts.size) {
														//we might as well close this this stream;
														s3Stream.destroy();
													}
													logger.debug("skipping s3", start, e.eid);
													done();
												}
											}), (err) => {
												if (err && err.code != "RequestAbortedError" && !(isPassDestroyed && err.code == "Z_BUF_ERROR")) {
													logger.error(err);
													done(err);
												} else {
													done();
												}
											});
										} else {
											done();
										}
									} else if (!item.gzip || item.gzip == true) {
										item.eid = item.kinesis_number;
										delete item.kinesis_number;
										// v1 getEvents already unzipped the payload
										if (item.gzip && leoEvent.v >= 2) {
											try {
												item.payload = JSON.parse(zlib.gunzipSync(item.payload).toString());
											} catch (e) {
												item.payload = {};
											}
										} else if (typeof item.payload === "string") {
											item.payload = JSON.parse(item.payload);
										}

										if (!isPassDestroyed && item.eid.localeCompare(start) > 0 && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
											totalCount++;
											pass.throttledWrite(item, done);
										} else { //otherwise it means we had a number in the middle of a file
											logger.debug("skipping gzip");
											done();
										}
									} else if (item.gzip) {
										var gzip = zlib.createGunzip();
										gzip.setEncoding('utf8');
										gzip.on('error', function(err) {
											logger.debug("Skipping gzip");
										});
										pump(gzip, split(JSON.parse), this.write((e, done) => {
											e.eid = createEId(e.eid);
											if (!isPassDestroyed && e.eid.localeCompare(start) > 0 && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
												totalCount++;
												pass.throttledWrite(e, done);
											} else { //otherwise it means we had a number in the middle of a file
												logger.debug("skipping gzipped");
												done();
											}
										}), (err) => {
											if (err) {
												logger.error(err);
												done(err);
											} else {
												logger.debug("gzipped event read finished", item.records, totalCount);
												done();
											}
										});
										gzip.end(item.gzip);
									}
								},
								function(err) {
									start = items[items.length - 1].end + " ";
									logger.debug("done with this loop", err || "");
									if (err) {
										pass.emit("error", err);
									} else {
										done();
									}
								});
						});
					},
					(err) => {
						logger.debug("Calling Pass.end");
						if (err) logger.error(err);
						pass.end();
					});
			} else {
				logger.debug("no events");
				pass.end();
				return;
			}
		});

		return pass;
	}

	toLeoMass(queue, configure)  {
		// TODO: TS - does pipeline called with a single argument do anything?
		// @ts-ignore
		return this.pipeline(leoS3(this, queue, this.configure));

	}
	toDynamoDB(table, opts) {
		opts = Object.assign({
			records: 25,
			size: 1024 * 1024 * 2,
			time: {
				seconds: 2
			}
		}, opts || {});

		var records, size;

		let keysArray = [opts.hash];
		opts.range && keysArray.push(opts.range);
		let key = opts.range ? (obj) => {
			return `${obj[opts.hash]}-${obj[opts.range]}`;
		} : (obj) => {
			return `${obj[opts.hash]}`;
		};
		let assign = (self, key, obj) => {
			self.data[key] = obj;
			return false;
		};
		if (opts.merge) {
			assign = (self, key, obj) => {
				if (key in self.data) {
					// TODO: TS - where is this merge supposed to come from?
					// @ts-ignore
					self.data[key] = merge(self.data[key], obj);
					return true;
				} else {
					self.data[key] = obj;
					return false;
				}
			};
		}

		function reset() {
			if (opts.hash || opts.range) {
				records = {
					length: 0,
					data: {},
					push(obj) {
						this.length++;
						return assign(this, key(obj), obj);
					},
					map(each) {
						return Object.keys(this.data).map(key => each(this.data[key]));
					}
				};
			} else {
				records = [];
			}
		}

		reset();

		var retry = backoff.fibonacci({
			randomisationFactor: 0,
			initialDelay: 100,
			maxDelay: 1000
		});
		retry.failAfter(10);
		retry.success = function () {
			retry.reset();
			retry.emit("success");
		};
		retry.run = function (callback) {
			let fail = (err) => {
				retry.removeListener('success', success);
				callback(err || 'failed');
			};
			let success = () => {
				retry.removeListener('fail', fail);
				reset();
				callback();
			};
			retry.once('fail', fail).once('success', success);

			retry.fail = function (err) {
				retry.reset();
				callback(err);
			};
			retry.backoff();
		};
		retry.on('ready', (number, delay) => {
			if (records.length === 0) {
				retry.success();
			} else {
				logger.info("sending", records.length, number, delay);
				logger.time("dynamodb request");

				let keys = [];
				let lookup = {};
				let all = records.map((r) => {
					let wrapper = {
						PutRequest: {
							Item: r
						}
					};
					if (opts.merge && opts.hash) {
						lookup[key(r)] = wrapper;
						keys.push({
							[opts.hash]: r[opts.hash],
							[opts.range]: opts.range && r[opts.range]
						});
					}
					return wrapper;
				});
				let getExisting = opts.merge ? ((done) => {
					this.dynamodb.batchGetTable(table, keys, {}, done);
				}) : done => done(null, []);

				let tasks = [];
				for (let ndx = 0; ndx < all.length; ndx += 25) {
					let myRecords = all.slice(ndx, ndx + 25);
					tasks.push((done) => {
						let retry = {
							backoff: (err?: any) => {
								done(null, {
									backoff: err || "error",
									records: myRecords
								});
							},
							fail: (err) => {
								done(null, {
									fail: err || "error",
									records: myRecords
								});
							},
							success: () => {
								done(null, {
									success: true,
									//records: myRecords
								});
							}
						};
						this.dynamodb.docClient.batchWrite({
								RequestItems: {
									[table]: myRecords
								},
								"ReturnConsumedCapacity": 'TOTAL'
							},
							function (err, data) {
								if (err) {
									logger.info(`All ${myRecords.length} records failed! Retryable: ${err.retryable}`, err);
									logger.error(myRecords);
									if (err.retryable) {
										retry.backoff(err);
									} else {
										retry.fail(err);
									}
								} else if (table in data.UnprocessedItems && Object.keys(data.UnprocessedItems[table]).length !== 0) {
									//reset();
									//data.UnprocessedItems[table].map(m => records.push(m.PutRequest.Item));
									myRecords = data.UnprocessedItems[table];
									retry.backoff();
								} else {
									logger.info(table, "saved");
									retry.success();
								}
							});
					});
				}
				getExisting((err, existing) => {
					if (err) {
						return retry.fail(err);
					}
					existing.map(e => {
						let newObj = lookup[key(e)];
						// TODO: TS - where is this merge supposed to come from?
						// @ts-ignore
						newObj.PutRequest.Item = merge(e, newObj.PutRequest.Item);
					});
					async.parallelLimit(tasks, 10, (err, results) => {
						if (err) {
							retry.fail(err);
						} else {
							let fail = false;
							let backoff = false;
							reset();
							results.map(r => {
								fail = fail || r.fail;
								backoff = backoff || r.backoff;
								if (!r.success) {
									r.records.map(m => records.push(m.PutRequest.Item));
								}
							});

							if (fail) {
								retry.fail(fail);
							} else if (backoff) {
								retry.backoff(backoff);
							} else {
								retry.success();
							}
						}
					});
				});
			}
		});
		return this.buffer({
			writeStream: true,
			label: "toDynamoDB",
			time: opts.time,
			size: opts.size,
			records: opts.records,
			buffer: opts.buffer,
			debug: opts.debug
		}, function (obj, done) {
			size += obj.gzipSize;
			records.push(obj);

			done(null, {
				size: obj.gzipSize,
				records: 1
			});
		}, retry.run, function flush(done) {
			logger.info("toDynamoDB On Flush");
			done();
		});
	}
	putEvent(id, event, obj, opts, callback) {
		if (typeof opts == "function") {
			callback = opts;
			opts = {};
		}

		var stream = this.load(id, event, opts);
		stream.write(obj);
		stream.end(err => {
			err && logger.info("Error:", err);
			callback(err);
		});

	}
	magic(streams, opts) {
		let sublogger = logger.sub("autoswitch");
		streams.map((s, i) => {
			s.minDurationMS = s.minDurationMS || moment.duration(s.minDuration || {
				seconds: 5
			}).asMilliseconds();

			if (typeof s.canSustainLoad == "number") {
				let maxRecordsPerSecond = s.canSustainLoad;
				s.canSustainLoad = (stats) => {
					var result = stats.recordsPerSecondAvg <= maxRecordsPerSecond && (stats.recordsPerSecond <= maxRecordsPerSecond || stats.recordsPerSecondHistory[0] <= maxRecordsPerSecond);
					return result;
				};
			}
			s.canSustainLoad = s.canSustainLoad || (() => false);
			s.label = s.label || i.toString();
		});


		opts = Object.assign({
			historyLength: 5,
			sampleInterval: {
				milliseconds: 500
			}
		}, opts);

		let sampleIntervalMS = moment.duration(opts.sampleInterval).asMilliseconds();
		let stats: any = {
			recordsPerSecondHistory: [0],
			recordsPerSecond: 0,
			recordsPerSecondAvg: 0,
			records: 0,
			start: moment.now()
		};
		let lastSwitch = Date.now();

		let current;
		let getBestStream = () => {
			if (current && (Date.now() - lastSwitch) < current.minDurationMS) {
				return current;
			}
			return (streams.find((s) => s.canSustainLoad(stats)) || streams[streams.length - 1]);
		};
		current = getBestStream();


		let startStream = this.through((obj, done) => {
			stats.records++;
			let now = stats.now = moment.now();
			let nextStream = getBestStream();
			if (now - stats.start >= sampleIntervalMS) {
				stats.recordsPerSecondHistory.unshift(stats.recordsPerSecond);
				if (stats.recordsPerSecondHistory.length > opts.historyLength) {
					stats.recordsPerSecondHistory.pop();
				}
				stats.recordsPerSecondAvg = stats.recordsPerSecondHistory.reduce((sum, cur) => sum + cur) / stats.recordsPerSecondHistory.length;
				stats.recordsPerSecond = stats.records / ((now - stats.start) || 1) * 1000;
				sublogger.debug("Stats:", JSON.stringify(stats, null, 2));
				stats.start = now;
				stats.records = 0;
			}

			if (nextStream != current) {
				sublogger.log(`Switching from ${current.label} to ${nextStream.label}`, JSON.stringify(stats, null, 2));
				// Stop source from writting new events
				startStream.unpipe(current.stream);

				// Wait for current to drain
				current.stream.once("switch", () => {
					sublogger.log(`Flushed ${current.label} complete, switched to ${nextStream.label}`);
					lastSwitch = Date.now();

					// Switch the streams
					current.stream.unpipe();
					current = nextStream;
					startStream.pipe(current.stream);
					current.stream.pipe(endStream);
					done(null, obj);
				});
				current.stream.write({
					__cmd: "flush",
					from_auto_switch: true
				});
			} else {
				done(null, obj);
			}
		}, (done) => {
			// End all streams except current
			let errors = [];
			async.eachOf(streams, (s, i, done) => {
				if (s == current) {
					done();
				} else {
					s.stream.end((err) => {
						if (err) {
							errors.push(err);
						}
						done();
					});
				}
			}, () => {
				// TODO: TS - handle errors more elegantly
				// @ts-ignore
				done(errors.length ? errors : null);
			});
		});
		let endStream = this.through({
			"cmdFlush": (obj, done) => {
				sublogger.log("ready to switch");
				current.stream.emit("switch");
				done(null, obj.from_auto_switch ? undefined : obj);
			}
		}, (obj, done) => done(null, obj));

		// Hook up all event listeners
		// unpipe so data isn't flowing to everything yet
		streams.map(s => {
			if (s != current) {
				this.pipe(startStream, s.stream, endStream);
				startStream.unpipe(s.stream);
				s.stream.unpipe();
			}
		});

		// Hook up everything for the current stream
		return this.pipeline(startStream, current.stream, endStream);
	}
	autoSwitch(outQueue, opts) {
		opts = Object.assign({
			recordsPerSecond: 100,
			sampleInterval: {
				milliseconds: 100
			}
		}, opts);

		let sampleIntervalMS = moment.duration(opts.sampleInterval).asMilliseconds();
		let stats: any = {
			isS3: false,
			recordsPerSecond: 0,
			records: 0,
			lastSwitch: moment.now(),
			start: moment.now()
		};
		// TODO: TS - toLeo seems like it should require an ID, not opts
		let toLeo = this.toLeo(opts);
		let end = this.through((obj, done) => done(null, obj), (done) => {
			logger.info("Calling flush for end");
			done();
		});

		let cnt = 0;
		let kinesisStream = this.pipeline(toLeo, end);
		// TODO: TS - should we handle the todo below?
		// @ts-ignore
		let leoS3S = leoS3(this, outQueue, this.configure); //TODO: if this ever gets used, pass in a opts paramater with a prefix of the botId
		let s3Stream = this.pipeline(leoS3S, kinesisStream);
		let stream = kinesisStream; //this.pipeline(toLeo, end);

		let start = this.through(function (obj, done) {
			stats.records++;
			let now = stats.now = moment.now();
			stats.recordsPerSecond = stats.records / ((now - stats.start) || 1) * 1000;
			logger.info(now - stats.start, sampleIntervalMS, stats.records, stats.recordsPerSecond);
			if (now - stats.start >= sampleIntervalMS) {
				cnt++;
				logger.debug("Stats:", JSON.stringify(stats));
				stats.start = now;
				stats.records = 0;
			}

			if (!stats.isS3 && stats.recordsPerSecond >= opts.recordsPerSecond) {
				logger.debug("Switching to S3 stream", JSON.stringify(stats));
				//stream.end((err) => {
				//	logger.info("Back", err)
				stats.isS3 = true;
				stats.lastSwitch = moment.now();
				//	stream = this.pipeline(leoS3(this, outQueue, this.configure), toLeo, end);
				stream = s3Stream;
				stream.write(obj);
				done();
				//});
				// stream.end((err) => {
				// 	logger.info("Back:", err)
				// 	stats.isS3 = true;
				// 	stats.lastSwitch = moment.now();
				// 	logger.debug("Switching", JSON.stringify(stats));
				// 	stream = this.pipeline(leoS3(), toLeo, end);
				// 	stream.write(obj);
				// 	done(err);
				// });
			} else if (stats.isS3 && stats.recordsPerSecond < opts.recordsPerSecond) {
				logger.debug("Switching to Kinesis stream", JSON.stringify(stats));

				leoS3S.once("drain", () => {
					//stream.end((err) => {
					//	logger.info("Back", err)
					stats.isS3 = false;
					stats.lastSwitch = moment.now();
					//stream = this.pipeline(toLeo, end);
					stream = kinesisStream;
					stream.write(obj);
					done();
					//});
				});
				// stream.end((err) => {
				// 	stats.isS3 = false;
				// 	stats.lastSwitch = moment.now();
				// 	logger.debug("Switching", JSON.stringify(stats));
				// 	stream = this.pipeline(toLeo, end);
				// 	stream.write(obj);
				// 	done(err);
				// });
			} else {
				logger.info("Normal Write");
				stream.write(obj);
				done();
			}
		}, function flush(done) {
			logger.debug("On Flush Stats:", JSON.stringify(stats));
			done();
		});
		let s = this.pipeline(start, end);
		s.on("error", (err) => {
			logger.info("Kinesis Stream error:", err);
		})
			.on("end", () => logger.info("ending kinesis stream"))
			.on("finish", () => logger.info("finishing kinesis stream"));

		return s;
	}
}

export default LeoStream;
module.exports = LeoStream;
