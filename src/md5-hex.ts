/**
 * MD5 over bytes → lowercase hex, matching Node
 * `createHash('md5').update(data).digest('hex')`.
 * Uses js-md5 (browser-safe, no Node built-ins).
 */
import { md5 } from 'js-md5';

export function md5Hex(data: Uint8Array): string {
	// js-md5 expects a contiguous byte view; copy if this is a subarray of a larger buffer.
	const bytes =
		data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
			? data
			: data.slice();
	return md5(bytes);
}
