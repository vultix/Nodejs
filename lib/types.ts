import stream from 'stream';

export interface LeoStreamOptions extends stream.TransformOptions {
	ignoreCommands?: any
	cmd?: any;
	cmdFlush?: any;
	hasCommands?: any;
}

export interface ReadableStream<T> extends stream.Readable {
	read(size?: number): T;
}

export interface WritableStream<T> extends stream.Writable {
	_write(chunk: T, encoding: BufferEncoding, callback?: ErrorCallback): void;
}

export type DuplexStream<T, U> = TransformStream<T, U>;
export interface TransformStream<T, U> extends stream.Duplex {
	_write(chunk: T, encoding: BufferEncoding, callback?: ErrorCallback): void;
	read(size?: number): U;
}


export type DataCallback<T = any, E = Error> = (err?: E | null, data?: T) => void;
export type ErrorCallback =  (error: Error | null | undefined) => void;
export type TransformFunction = (this: stream.Transform, chunk: any, encoding: BufferEncoding, callback: DataCallback) => void;
export type LeoTransformFunction<T, U, E = Error> = (this: TransformStream<T, U>, obj: T, callback: DataCallback<U, E>) => void;
export type FlushCallback = (this: stream.Transform, flushCallback: DataCallback) => any;

export interface LeoEvent<T> {
	id?: string;
	timestamp?: number;
	event?: string;
	eid?: string;
	units?: number;
	event_source_timestamp: number;
	correlation_id: LeoCorrelationId;
	payload?: T;
}

export interface LeoCorrelationId {
	source: string;
	start: string | number;
	units?: number;
}

export interface Buffered<T> {
	records: T[],
	size: number,
	isLast: boolean
}

export interface BufferCounter {
	size: number,
	records: number
}

// TODO: TS - Verify this Buffered<T> transform type is correct
export interface BufferedStream<T> extends TransformStream<T, Buffered<T>> {
	reset(): void;
	flush(done: DataCallback<null>): void;
	updateLimits(limits: any): void;
	options?: any;
}

export interface LeoStats {
	source_timestamp?: number | null;
	started_timestamp?: number | null;
	ended_timestamp?: number | null;
	eid?: string | null;
	units?: number | null;
	start_eid?: string | null;
}

export interface StatsStream extends TransformStream<any, any> {
	checkpoint?: LeoStatsCheckpoint;
	get(): LeoStats;
}
export interface LeoStatsCheckpoint {
	(params: any, done: any): any;
	stream: TransformStream<any, any>;
}
