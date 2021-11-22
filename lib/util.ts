"use strict";

var moment = require("moment");
const fs = require("fs");
const path = require("path");

var DATE_FORMAT = "YYYY-MM-DD";
export function dateSafe(date) {
	return date ? moment(date).format(DATE_FORMAT) : undefined;
}

export function timestampSafe(date) {
	return date ? moment(date).format() : undefined;
}

export function ifDefined(value, func) {
	if (value !== undefined) {
		return func(value);
	}
	return undefined;
}

export function boolSafe(value, yes, no, none) {
	if (value !== undefined) {
		return value ? yes : no;
	}
	return none;
}

export function switchSafe(value, values) {
	return values[value] || values.default || values.undefined;
}
export function findParentFiles(dir, filename) {
	var paths = [];
	do {
		paths.push(dir);

		var lastDir = dir;
		dir = path.resolve(dir, "../");
	} while (dir != lastDir);

	var matches = [];
	paths.forEach(function(dir) {
		var file = path.resolve(dir, filename);
		if (fs.existsSync(file)) {

			matches.push(file);
		}
	});
	return matches;
}
export function toUpperCase(value) {
	return value.toUpperCase();
}
/**
 * Extract a portion of a string
 * @param regex
 */
export function extractStringPart(value, regex) {
	if (value) {
		let returnValue = value.match(regex);

		if (returnValue) {
			return returnValue[1] || returnValue[0];
		}
	}

	return '';
}

/**
 * Decorator to make a class callable.
 * Used to prevent breaking backwards-compatibility in existing JS.
 */
export function callable<T extends { new (...args: any[]): {} }>(constructor: T): any {
	function Callable(this: T, ...args: any[]): any {
		return new constructor(...args);
	}
	Callable.prototype = constructor.prototype;

	return Callable;
}
