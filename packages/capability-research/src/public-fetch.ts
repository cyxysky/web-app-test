import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** Preserve hostname/TLS verification while connecting only to an address the policy checked. */
export function fetchPinnedPublicUrl(url: URL, address: { address: string; family: number }, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, lookup, family: address.family,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.2', 'accept-encoding': 'identity', 'user-agent': 'WebPilotResearch/0.1' },
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
        else if (value !== undefined) headers.set(key, value);
      }
      const encoding = headers.get('content-encoding');
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined;
      if (decoder) { headers.delete('content-encoding'); headers.delete('content-length'); response.on('error', (error) => decoder.destroy(error)); }
      const stream = decoder ? response.pipe(decoder) : response;
      if (decoder) decoder.once('close', () => response.destroy());
      const status = response.statusCode || 502;
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers }));
    });
    request.once('error', reject);
    request.end();
  });
}
