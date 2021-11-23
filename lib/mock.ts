import leosdk from '../index';
import es from 'event-stream';

import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import AWS from 'aws-sdk';
import moment from 'moment';

const overrideLeoFunctions = (data: MockData = {}, leo=leosdk) => {
	leo.mocked = true;
	if (Array.isArray(data)) {
		data = {
			queues: data
		};
	}
	data = Object.assign({
		toS3:true,
		write:true,
		read:true,
		cron:true,
		queues: {},
		checkpoints: {},
		toDynamoDB: true,
		testId: process.pid
	}, data);
	let readQueueObjectArray = data.queues;
	leo.configuration.validate = () => true;

	let testId = data.testId;
	leo.mock = leo.mock || { createContext, getData:()=>leo.mock[testId]};
	let mock: any = leo.mock[testId] = {}

	//define various overrides of Leo functions
	if (data.read){
		leo.read = leo.streams.fromLeo = (id, queue) => {
			let returnStream;
			if (Array.isArray(readQueueObjectArray)) {
				returnStream = es.readArray(readQueueObjectArray)
			} else if (isReadableStream(readQueueObjectArray)){
				returnStream = readQueueObjectArray;
			} else if (isReadableStream(readQueueObjectArray[queue])){
				returnStream = readQueueObjectArray[queue];
			} else {
				returnStream = es.readArray(readQueueObjectArray[queue] || []);
			}
			returnStream.checkpoint = (callback) => callback();
			return returnStream
		};
	}

	// TODO: TS - the `leo.write.events` and `leo.streams.toS3.events` setup here are never used
	if (data.write){
		leo.write = leo.streams.toLeo = () => {
			(leo.write as any).events = [];
			return leo.streams.through((data, callback) => {
				(leo.write as any).events.push(data);
				callback();
			});
		};
	}

	if (data.toS3){
		leo.streams.toS3 = (Bucket, File) => {
			let filepath = path.resolve("/tmp/", `${Bucket}/${File}`);
			createPath(path.dirname(filepath));
			return leo.streams.pipeline(
				leo.streams.through((o, done) => {
					done(null, o);
				}),
				leo.streams.through((o, done) => {
					(leo.streams.toS3 as any).events.push(o);
					done(o as any);
				}),
				fs.createWriteStream(filepath)
			);
		}
		(leo.streams.toS3 as any).events = [];
	}

	if (data.fromS3){
		leo.streams.fromS3 = (file) => {
			let Bucket = "/tmp/" + (file.bucket || file.Bucket);
			let Key = file.key || file.Key;
			let Range = file.range || undefined;
			if (typeof data.fromS3 == "string"){
				Bucket = data.fromS3;
				Key = Key.replace(/[\\\/]/g,"_");
			}

			let filepath = path.resolve(Bucket, Key);
			if (!fs.existsSync(filepath)){
				// TODO: TS - this is broken
				// @ts-ignore
				throw AWS.util.error(new Error(), {
					message: 'The specified key does not exist.',
					code: 'NoSuchKey'
				});
			}
			return fs.createReadStream(filepath)
		}
	}

	if (data.cron){
		leo.bot.checkLock = (...args) => args[args.length - 1]();
		leo.bot.reportComplete = (...args) => args[args.length - 1]();
		leo.bot.createLock = (...args) => args[args.length - 1]();
		leo.bot.removeLock = (...args) => args[args.length - 1]();
	}

	if (data.toDynamoDB){
		if (isWritableStream(data.toDynamoDB)){
			leo.streams.toDynamoDB = data.toDynamoDB;
		} else {
			(leo.streams.toDynamoDB as any) = (tableName)=>{
				let table = mock.dynamodb.data[tableName] = mock.dynamodb.data[tableName] || {};
				let key = data.dynamodb.keys[tableName];
				return leo.streams.write((data, callback)=>{
					table[key(data)] = data;
					callback();
				})
			}
		}
	}

	if (data.batchGetTable){
		leo.aws.dynamodb.batchGetTable = (tableName, ids, callback)=>{
			let table = mock.dynamodb.data[tableName] = mock.dynamodb.data[tableName] || {};
			let key = data.dynamodb.keys[tableName];
			let results = [];
			ids.forEach(id=>{
				let data = table[key(id)];
				if (data){
					results.push(data);
				}
			})

			callback(null, results);
		}
	}
	if (data.toDynamoDB || data.batchGetTable){
		mock.dynamodb = mock.dynamodb || {};
		mock.dynamodb.data = mock.dynamodb.data || (data.dynamodb && data.dynamodb.data) || {};
	}

	leo.bot.getCheckpoint = (queue) => data.checkpoints[queue];
	leo.streams.toCheckpoint = () => leo.streams.devnull() as any;
	return leo;
};

interface MockData {
	queues?: any;
	testId?: any;
	read?: any;
	write?: any;
	toS3?: any;
	fromS3?: any;
	cron?: any;
	toDynamoDB?: any;
	dynamodb?: any;
	batchGetTable?: any;
	checkpoints?: any;
}

export interface LeoMock {
	createContext(config: any): any;
	getData(): any;
}

function isReadableStream(test) {
	return test instanceof EventEmitter && typeof (test as any).read === 'function'
}

function isWritableStream(test) {
	return test instanceof EventEmitter && typeof (test as any).write === 'function' && typeof (test as any).end === 'function'
}

const createContext = (config) => {
	let start = Date.now();
	let maxTime = config.Timeout ? config.Timeout * 1000 : moment.duration({ years: 10 }).asMilliseconds();
	return {
		awsRequestId: 'requestid-local' + moment.now().toString(),
		getRemainingTimeInMillis: () => {
			let timeSpent = Date.now() - start;
			return (timeSpent < maxTime) ? (maxTime - timeSpent) : 0;
		},
	};
};

function createPath (dir) {
	if (!fs.existsSync(dir)) {
		var parent = path.dirname(dir);
		if (parent) {
			createPath(parent);
		}
		fs.mkdirSync(dir);
	}
}

overrideLeoFunctions.createContext = createContext;
module.exports = overrideLeoFunctions;
export default overrideLeoFunctions;
