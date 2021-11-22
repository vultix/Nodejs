"use strict";
import merge from 'lodash.merge';
import * as fastCsv from 'fast-csv';
import leo_logger from 'leo-logger';
import backoff from 'backoff';
import moment from 'moment';
import stream, {PassThrough} from 'stream';
import https from 'https';
import AWS from './leo-aws';
import {FlushWriteStream} from './flushwrite.js';
import zlib from 'zlib';
import split2 from 'split2';
import {obj as pumpify} from 'pumpify';
import pump from 'pump';
import {obj as through2} from 'through2';
import {
	BufferedStream,
	ErrorCallback,
	FlushCallback,
	LeoEvent,
	LeoStreamOptions,
	LeoTransformFunction,
	ReadableStream,
	TransformFunction,
	TransformStream,
	WritableStream
} from './types';

var s3 = new AWS.S3({
	apiVersion: '2006-03-01',
	httpOptions: {
		agent: new https.Agent({
			keepAlive: true
		})
	}
});
const logger = leo_logger('stream');

export namespace ls {
	export function commandWrap(opts: LeoStreamOptions | LeoTransformFunction<any, any>, func?: LeoTransformFunction<any, any>): TransformFunction {
		if (typeof opts === "function") {
			func = opts;
			opts = {};
		}
		opts = merge({
			hasCommands: '__cmd',
			ignoreCommands: {}
		}, opts || {}) as LeoStreamOptions;

		if (Array.isArray(opts.ignoreCommands)) {
			opts.ignoreCommands = opts.ignoreCommands.reduce((all, one) => {
				all[one] = true;
				return all;
			}, {});
		}


		let commands = {
			//By Default just pass the command along
			cmd: opts.cmd || ((obj, done) => {
				done(null, obj);
			})
		};
		for (var key in opts) {
			if (key.match(/^cmd/)) {
				let cmd = key.replace(/^cmd/, '').toLowerCase();
				commands[cmd] = opts[key];
			}
		}
		let throughCommand: TransformFunction;
		//They need to specify false to turn this off
		if (opts.hasCommands !== false) {
			throughCommand = function(obj, enc, done) {
				//Only available on through streams (not on write streams);
				let push = this.push && this.push.bind(this);
				try {
					if (obj && obj.__cmd && (opts as LeoStreamOptions).ignoreCommands[obj.__cmd] !== true) {
						let cmd = obj.__cmd.toLowerCase();
						if (cmd in commands) {
							commands[cmd].call(this, obj, done, push);
						} else {
							commands.cmd.call(this, obj, done, push);
						}
					} else {
						func.call(this, obj, done, push);
					}
				} catch (err) {
					logger.error(err);
					done(err);
				}
			};
		} else {
			throughCommand = function(obj, enc, done) {
				//Only available on through streams (not on write streams);
				let push = this.push && this.push.bind(this);
				try {
					func.call(this, obj, done, push);
				} catch (err) {
					logger.error(err);
					done(err);
				}
			};
		}

		return throughCommand;
	}

	export function passthrough<T>(opts): TransformStream<T, T>  {
		return new PassThrough(opts);
	}
	export function through<T, U>(func: LeoTransformFunction<T, U>, flush?: FlushCallback): TransformStream<T, U>;
	export function through<T, U>(opts: LeoStreamOptions, func: LeoTransformFunction<T, U>, flush?: FlushCallback): TransformStream<T, U>;
	export function through<T, U>(opts: LeoTransformFunction<T, U> | LeoStreamOptions, func?: LeoTransformFunction<T, U> | FlushCallback, flush?: FlushCallback)  {
		if (typeof opts === "function") {
			flush = flush || (func as FlushCallback);
			func = opts;
			opts = {};
		}
		return through2(opts, ls.commandWrap(opts, func), flush ? function(done) {
			flush.call(this, done, this.push.bind(this));
		} : null);
	}

	export function writeWrapped(opts, func?: any, flush?: any) {
		if (typeof opts === "function") {
			flush = flush || func;
			func = opts;
			opts = undefined;
		}
		return FlushWriteStream.obj(opts, ls.commandWrap(opts, func), flush ? function(done) {
			flush.call(this, done);
		} : null);
	}
	export function cmd(watchCommands: any, singleFunc): TransformStream<any, any>  {
		if (typeof singleFunc == "function") {
			watchCommands = {
				[watchCommands]: singleFunc
			};
		}
		for (var key in watchCommands) {
			if (!key.match(/^cmd/) && typeof watchCommands[key] == "function") {
				watchCommands["cmd" + key] = watchCommands[key];
			}
		}
		return ls.through(watchCommands, (obj, done) => done(null, obj));
	}
	export function buffer<T>(opts, each, emit, flush): BufferedStream<T>  {
		opts = merge({
			time: opts && opts.time ||  {
				seconds: 10
			},
			size: 1024 * 200,
			records: 1000,
			buffer: 1000,
			debug: true
		}, opts);

		let streamType = opts.writeStream ? ls.writeWrapped : ls.through;

		let label = opts.label ? (opts.label + ' ') : '';
		var size = 0;
		var records = 0;
		var timeout = null;

		let isSizeConstrained = false;
		let isRecordConstrained = false;
		let isTimeConstrained = false;

		function reset() {
			isSizeConstrained = false;
			isRecordConstrained = false;
			isTimeConstrained = false;
			records = 0;
			size = 0;
			clearTimeout(timeout);
			timeout = null;
		}

		function doEmit(last = false, done) {
			if (records) {
				logger.debug(`${label}emitting ${last ? 'due to stream end' : ''} ${isSizeConstrained ? 'due to size' : ''} ${isTimeConstrained ? 'due to time' : ''}  ${isRecordConstrained ? 'due to record count' : ''}  records:${records} size:${size}`);
				let data = {
					records: records,
					size: size,
					isLast: last
				};
				reset();
				emit.call(stream, (err, obj) => {
					logger.debug(label + "emitting done", err);
					if (obj != undefined) {
						stream.push(obj);
					}
					if (err) {
						stream.emit("error", err);
					}
					if (done) {
						done(err);
					}
				}, data);
			} else {
				reset();
				logger.debug(label + "Stream ended");
				if (done) {
					done(null, null);
				}
			}
		}

		var stream = streamType(merge({
			cmdFlush: (obj, done) => {
				doEmit(false, () => {
					//want to add the flush statistics and send it further
					done(null, obj);
				});
			},
			highWaterMark: opts.highWaterMark || undefined
		}, opts.commands), function(o, done) {
			each.call(stream, o, (err, obj) => {
				if (obj) {
					if (obj.reset === true) {
						reset();
					}
					records += obj.records || 1;
					size += obj.size || 1;
					if (!timeout) {
						timeout = setTimeout(() => {
							isTimeConstrained = true;
							stream.writable && stream.write({
								__cmd: "flush",
								timeout: true,
								flush: true
							});
						}, Math.min(2147483647, moment.duration(opts.time).asMilliseconds())); // Max value allowed by setTimeout
					}
					isSizeConstrained = size >= opts.size;
					isRecordConstrained = records >= opts.records;
					if (isSizeConstrained || isRecordConstrained) {
						doEmit(false, done);
					} else {
						done(err, null);
					}
				} else {
					done(err, null);
				}
			});
		}, (done) => {
			doEmit(true, () => {
				if (flush) {
					flush.call(stream, done);
				} else {
					done();
				}
			});
		}) as BufferedStream<T>;
		stream.reset = reset;
		stream.flush = function(done) {
			doEmit(false, done);
		};
		stream.updateLimits = (limits) => {
			opts = merge(opts, limits);
		};
		return stream;
	}
	export function bufferBackoff(each, emit, retryOpts, opts, flush) {
		retryOpts = merge({
			randomisationFactor: 0,
			initialDelay: 1,
			maxDelay: 1000,
			failAfter: 10
		}, retryOpts);
		opts = merge({
			records: 25,
			size: 1024 * 1024 * 2,
			time: opts.time || {
				seconds: 2
			}
		}, opts || {});

		var records, size;

		function reset() {
			records = [];
		}
		reset();

		let lastError = null;

		var retry = backoff.fibonacci({
			randomisationFactor: 0,
			initialDelay: 1,
			maxDelay: 1000
		});
		retry.failAfter(retryOpts.failAfter);
		retry.success = function() {
			retry.reset();
			retry.emit("success");
		};
		retry.run = function(callback) {
			let fail = (err) => {
				retry.removeListener('success', success);
				callback(lastError || 'failed');
			};
			let success = () => {
				retry.removeListener('fail', fail);
				reset();
				callback();
			};
			retry.once('fail', fail).once('success', success);
			retry.backoff();
		};
		retry.on('ready', function(number, delay) {
			if (records.length === 0) {
				retry.success();
			} else {
				logger.info("sending", records.length, number, delay);
				emit(records, (err, records) => {
					if (err) {
						lastError = err;
						logger.info(`All records failed`, err);
						retry.backoff();
					} else if (records.length) {
						lastError = err;
						logger.info(`${records.length} records failed`, err);
						retry.backoff();
					} else {
						logger.info("Success");
						retry.success();
					}
				});
			}
		});

		return this.buffer({
			writeStream: true,
			label: opts.label,
			time: opts.time,
			size: opts.size,
			records: opts.records,
			buffer: opts.buffer,
			debug: opts.debug,
			commands: opts.commands
		}, (record, done) => {
			each(record, (err, obj, units = 1, size = 1) => {
				if (err) {
					done(err);
				} else {
					records.push(obj);
					done(null, {
						size: size,
						records: units
					});
				}
			});
		}, retry.run, function (done) {
			logger.info(opts.label + " On Flush");
			if (flush) {
				flush.call(stream, done);
			} else {
				done();
			}
		});
	}

	export function pipeline<T1, D extends WritableStream<T1>>(write: WritableStream<T1>, drain: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline<T1, T2, D extends WritableStream<T2>>(write: WritableStream<T1>, t1: TransformStream<T1, T2>, t2: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline<T1, T2, T3, D extends WritableStream<T3>>(write: WritableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline<T1, T2, T3, T4, D extends WritableStream<T4>>(write: WritableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, t4: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline<T1, T2, T3, T4, T5, D extends WritableStream<T5>>(write: WritableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, t4: TransformStream<T4, T5>, t5: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline<T1, T2, T3, T4, T5, T6, D extends WritableStream<T6>>(write: WritableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, t4: TransformStream<T4, T5>, t5: TransformStream<T5, T6>, t6: D, errorCallback?: ErrorCallback): D extends ReadableStream<infer U> ? TransformStream<T1, U> : WritableStream<T1>;
	export function pipeline(...args: any[]) {
		return pumpify(...args)
	}

	export const split = split2;
	export const gzip = zlib.createGzip;
	export const gunzip = zlib.createGunzip;
	export const write = FlushWriteStream.obj;

	export function pipe<T1>(read: ReadableStream<T1>, write: WritableStream<T1>, errorCallback?: ErrorCallback): WritableStream<T1>;
	export function pipe<T1, T2>(read: ReadableStream<T1>, t1: TransformStream<T1, T2>, write: WritableStream<T2>, errorCallback?: ErrorCallback): WritableStream<T2>;
	export function pipe<T1, T2, T3>(read: ReadableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, write: WritableStream<T3>, errorCallback?: ErrorCallback): WritableStream<T3>;
	export function pipe<T1, T2, T3, T4>(read: ReadableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, write: WritableStream<T4>, errorCallback?: ErrorCallback): WritableStream<T4>;
	export function pipe<T1, T2, T3, T4, T5>(read: ReadableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, t4: TransformStream<T4, T5>, write: WritableStream<T5>, errorCallback?: ErrorCallback): WritableStream<T5>;
	export function pipe<T1, T2, T3, T4, T5, T6>(read: ReadableStream<T1>, t1: TransformStream<T1, T2>, t2: TransformStream<T2, T3>, t3: TransformStream<T3, T4>, t4: TransformStream<T4, T5>, t5: TransformStream<T5, T6>, write: WritableStream<T6>, errorCallback?: ErrorCallback): WritableStream<T6>;
	export function pipe(...args: any[]) {
		return pump(...args)
	}
	// export const pipe = pump;
	export function stringify(): TransformStream<any, string>  {
		return ls.through((obj, done) => {
			done(null, JSON.stringify(obj) + "\n");
		});
	}
	export function parse<T>(skipErrors = false): TransformStream<any, T>  {
		return pumpify(split2(), ls.through<any, string>((obj, done) => {
			if (!obj) {
				done();
			} else {
				try {
					obj = JSON.parse(obj);
				} catch (err) {
					done(skipErrors ? undefined : err);
					return;
				}
				done(null, obj);
			}
		}));
	}
	export function fromCSV(fieldList, opts): TransformStream<any, any> {
		opts = merge({
			headers: fieldList,
			ignoreEmpty: true,
			trim: true,
			escape: '\\',
			nullValue: "\\N",
			delimiter: '|'
		}, opts || {});

		var parse = fastCsv.parse(opts);
		var transform = ls.through<any, any>((obj, done) => {
			for (var i in obj) {
				if (obj[i] === opts.nullValue) {
					obj[i] = null;
				}
			}
			done(null, obj);
		});

		let errorArgs = arguments;
		parse.on("error", () => {
			logger.error(errorArgs);
		});

		return pumpify(parse, transform);
	}
	export function toCSV(fieldList, opts): any  {
		opts = merge({
			nullValue: "\\N",
			delimiter: ',',
			escape: '"'
		}, opts || {});
		return fastCsv.format({
			headers: fieldList,
			delimiter: opts.delimiter,
			escape: opts.escape,
			quote: opts.quote,
			transform: function(row) {
				for (var key in row) {
					if (row[key] === null || row[key] === undefined) {
						row[key] = opts.nullValue;
					}
					if (row[key] && row[key].match) {
						if (row[key].match(/\n/, '')) {
							row[key] = row[key].replace(/\n/g, '');
						}
					}
				}
				return row;
			}
		});
	}
	export function toS3(Bucket, File)  {
		var callback = null;
		var pass = new PassThrough();
		s3.upload({
			Bucket: Bucket,
			Key: File,
			Body: pass
		}, (err) => {
			logger.log("done uploading", err);
			callback(err);
		});
		return new FlushWriteStream((s, enc, done) => {
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
	export function fromS3(file, opts)  {
		opts = merge({}, opts);
		return (opts.s3 || s3).getObject({
			Bucket: file.bucket || file.Bucket,
			Key: file.key || file.Key,
			Range: file.range || undefined
		}).createReadStream();
	}
	export function asEvent(opts) {
		opts = merge({
			id: "unknown"
		}, opts);
		if (typeof opts.kinesis_number != "function") {
			var kn = opts.kinesis_number;
			opts.kinesis_number = function() {
				return kn;
			};
		}
		return ls.through((data, done) => {
			done(null, {
				id: opts.id,
				event: opts.event,
				payload: data,
				kinesis_number: opts.kinesis_number(data)
			});
		});
	}
	export function log(prefix) {
		var log = console.log;
		if (prefix) {
			log = function() {
				console.log.apply(null, [prefix].concat(Array.prototype.slice.call(arguments)));
			};
		}
		return ls.through({
			cmd: (obj, done) => {
				if (typeof obj == "string") {
					log(obj);
				} else {
					log(JSON.stringify(obj, null, 2));
				}
				done(null, obj);
			}
		}, (obj, callback) => {
			if (typeof obj == "string") {
				log(obj);
			} else {
				log(JSON.stringify(obj, null, 2));
			}
			callback(null, obj);
		});
	}
	export function devnull(shouldLog = false): WritableStream<any> {
		let s = new stream.Writable({
			objectMode: true,
			write(chunk, encoding, callback) {
				callback();
			}
		});
		if (shouldLog) {
			return ls.pipeline(ls.log(shouldLog === true ? "devnull" : shouldLog), s);
		} else {
			return s;
		}
	}
	export function counter(label, records = 10000): TransformStream<LeoEvent<any>, LeoEvent<any>> {
		if (typeof label === 'number') {
			records = label;
			label = null;
		}
		if (label != null) {
			label += " ";
		}
		let count = 0;
		let start = Date.now();
		return ls.through((o, d) => {
			count++;
			count % records === 0 && console.log(`${label}${count} ${Date.now()-start} ${o.eid||""}`);
			d(null, o);
		})
	}
	export function process(id, func, outQueue) {
		var firstEvent;
		var units;

		function reset() {
			firstEvent = null;
			units = 0;
		}
		reset();

		return ls.through<LeoEvent<any>, LeoEvent<any>>((obj, done) => {
			if (!firstEvent) {
				firstEvent = obj;
			}
			units += obj.units || 1;
			func(obj.payload, obj, (err, r, rOpts) => {
				rOpts = rOpts || {};
				if (err) {
					done(err);
				} else if (r === true) { //then we handled it, though it didn't create an object
					done(null, {
						id: id,
						event_source_timestamp: obj.event_source_timestamp,
						payload: undefined,
						correlation_id: {
							source: obj.event,
							start: obj.eid,
							units: obj.units || 1
						}
					});
				} else if (r) { //then we are actually writing an object
					done(null, {
						id: id,
						event: outQueue,
						payload: r,
						event_source_timestamp: obj.event_source_timestamp,
						correlation_id: {
							source: obj.event,
							start: obj.eid,
							units: obj.units || 1
						}
					});
				} else {
					done();
				}
			});
		});
	}
	export function batch(opts) {
		if (typeof opts === "number") {
			opts = {
				count: opts
			};
		}
		opts = merge({
			count: undefined,
			bytes: undefined,
			time: undefined,
			highWaterMark: 2
		}, opts);

		var buffer = [];

		logger.debug("Batch Options", opts);

		let push = (stream, data) => {

			if (buffer.length) {
				let payload = buffer.splice(0);
				let first = payload[0].correlation_id || {};
				let last = payload[payload.length - 1].correlation_id || {};
				let correlation_id = {
					source: first.source,
					start: first.start,
					end: last.end || last.start,
					units: payload.length
				};
				stream.push({
					id: payload[0].id,
					payload: payload,
					bytes: data.size,
					correlation_id: correlation_id,
					event_source_timestamp: payload[0].event_source_timestamp,
					timestamp: payload[payload.length - 1].timestamp,
					event: payload[0].event,
					eid: payload[payload.length - 1].eid,
					units: payload.length
				});
			}
		};
		var stream = ls.buffer({
			label: "batch",
			time: opts.time,
			size: opts.size || opts.bytes,
			records: opts.records || opts.count,
			buffer: opts.buffer,
			highWaterMark: opts.highWaterMark,
			debug: opts.debug
		}, function(obj, callback) {
			let size = 0;
			if (typeof obj === "string") {
				size += Buffer.byteLength(obj);
			} else if (opts.field) {
				var o = obj && obj[opts.field];
				size += Buffer.byteLength(typeof o === "string" ? o : JSON.stringify(o));
			} else {
				size += Buffer.byteLength(JSON.stringify(obj));
			}

			buffer.push(obj);
			callback(null, {
				size: size,
				records: 1
			});
		}, function emit(callback, data) {
			push(stream, data);
			callback();
		}, function flush(callback) {
			logger.debug("Batch On Flush");
			callback();
		});
		stream.options = opts;
		return stream;
	}
}

export default ls;
