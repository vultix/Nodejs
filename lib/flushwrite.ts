import {WritableStream} from './types';

import stream from 'stream';

var SIGNAL_FLUSH = Buffer.from([0])

export class FlushWriteStream<T> extends stream.Writable implements WritableStream<T> {
	private _worker: any;
	private _flush: any;

	constructor(opts, write, flush?: any) {
		super()

		if (typeof opts === 'function') {
			flush = write
			write = opts
			opts = {}
		}

		stream.Writable.call(this, opts)

		this.destroyed = false
		this._worker = write || null
		this._flush = flush || null
	}


	static obj<T>(opts, worker, flush): FlushWriteStream<T> {
		if (typeof opts === 'function') return FlushWriteStream.obj(null, opts, worker)
		if (!opts) opts = {}
		opts.objectMode = true
		return new FlushWriteStream(opts, worker, flush)
	}

	_write(data: T, enc: any, cb?: any): void {
		if (SIGNAL_FLUSH === (data as any)) this._flush(cb)
		else this._worker(data, enc, cb)
	}

	end(data, enc?: any, cb?: any) {
		if (!this._flush) return super.end(data, enc, cb)
		if (typeof data === 'function') return this.end(null, null, data)
		if (typeof enc === 'function') return this.end(data, null, enc)
		if (data) this.write(data)
		if (!this.writableEnded) this.write(SIGNAL_FLUSH)
		return super.end(cb);
	}

	destroy(err) {
		if (this.destroyed) return
		this.destroyed = true
		var self = this
		process.nextTick(function() {
			if (err)
				self.emit('error', err);
			self.emit('close');
		});
	}

}
