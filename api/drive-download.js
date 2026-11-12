/* Same-origin relay for Drive file bytes.
 *
 * Browser fetches of drive/v3/files/{id}?alt=media fail on some networks
 * because the media response (or its redirect to drive.usercontent.google.com)
 * has no Access-Control-Allow-Origin. This function runs the download where
 * CORS does not apply and returns the bytes, or the real HTTP status, to the
 * page. The caller's API key is forwarded only to Google and never logged.
 */

var MAX_BYTES = 4 * 1024 * 1024;
var MAX_REDIRECTS = 5;

function isAllowedDownloadHost(hostname) {
  var host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (host === 'www.googleapis.com' || host === 'googleapis.com' || host === 'content.googleapis.com') return true;
  if (host === 'drive.usercontent.google.com') return true;
  return /(^|\.)googleapis\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/key=[^&\s'"]+/gi, 'key=REDACTED')
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, 'AIzaREDACTED');
}

function headerMap(headers) {
  return {
    get: function (name) {
      if (!headers || !name) return null;
      if (typeof headers.get === 'function') {
        var fromGet = headers.get(name);
        return fromGet == null ? null : String(fromGet);
      }
      var value = headers[String(name).toLowerCase()];
      if (Array.isArray(value)) value = value[0];
      return value == null ? null : String(value);
    }
  };
}

function proxyResponse(status, body, contentType) {
  return new Response(body, {
    status: status,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Drive-Proxy': '1',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function jsonError(status, message) {
  return proxyResponse(status, JSON.stringify({
    error: { code: status, message: redactSecrets(message) }
  }), 'application/json');
}

function isSameSite(requestUrl, headers) {
  var origin = headers.get('origin');
  if (!origin) return true;
  var originHost;
  try { originHost = new URL(origin).host; } catch (e) { return false; }
  var requestHost = '';
  try { requestHost = new URL(requestUrl).host; } catch (e) { return false; }
  if (originHost === requestHost) return true;
  var forwarded = headers.get('x-forwarded-host');
  if (forwarded && originHost === String(forwarded).split(',')[0].trim()) return true;
  return false;
}

function callerReferer(requestUrl, headers) {
  var origin = headers.get('origin');
  if (origin && /^https?:\/\//i.test(origin)) {
    return origin.charAt(origin.length - 1) === '/' ? origin : origin + '/';
  }
  var referer = headers.get('referer');
  if (referer && /^https?:\/\//i.test(referer)) return referer;
  try {
    var parsed = new URL(requestUrl);
    return parsed.protocol + '//' + parsed.host + '/';
  } catch (e) {
    return '';
  }
}

function googleDownloadUrl(id, kind, apiKey, abuse) {
  if (kind === 'export') {
    return 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
      + '/export?mimeType=' + encodeURIComponent('text/csv')
      + '&supportsAllDrives=true&key=' + encodeURIComponent(apiKey);
  }
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
    + '?alt=media&supportsAllDrives=true&key=' + encodeURIComponent(apiKey);
  if (abuse) url += '&acknowledgeAbuse=true';
  return url;
}

async function readLimited(upstream, limit) {
  if (!upstream.body || typeof upstream.body.getReader !== 'function') {
    var buffered = Buffer.from(await upstream.arrayBuffer());
    return buffered.length > limit ? { tooBig: true } : { buf: buffered };
  }
  var reader = upstream.body.getReader();
  var chunks = [];
  var total = 0;
  while (true) {
    var step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch (e) {}
      return { tooBig: true };
    }
    chunks.push(Buffer.from(step.value));
  }
  return { buf: Buffer.concat(chunks) };
}

async function fetchGoogle(url, referer, fetchImpl) {
  var current = url;
  var hops = 0;
  while (hops <= MAX_REDIRECTS) {
    var parsed;
    try { parsed = new URL(current); } catch (e) {
      return { error: jsonError(502, 'Drive returned a redirect this proxy will not follow.') };
    }
    if (!isAllowedDownloadHost(parsed.hostname)) {
      return { error: jsonError(502, 'Drive redirected to an unexpected host (' + parsed.hostname + ').') };
    }
    var upstream;
    try {
      upstream = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: '*/*',
          Referer: referer
        }
      });
    } catch (err) {
      return { error: jsonError(502, 'Could not reach Google Drive (' + redactSecrets(err && err.message) + ').') };
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      var location = upstream.headers.get('location');
      if (!location) return { error: jsonError(502, 'Drive redirected without a destination.') };
      current = new URL(location, current).toString();
      hops += 1;
      continue;
    }
    return { upstream: upstream };
  }
  return { error: jsonError(502, 'Too many redirects from Google Drive.') };
}

async function handleDriveDownload(request, deps) {
  deps = deps || {};
  var fetchImpl = deps.fetch || fetch;
  var headers = headerMap(request.headers || {});
  var method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return jsonError(405, 'Use GET.');

  var requestUrl;
  try { requestUrl = new URL(request.url); } catch (e) {
    return jsonError(400, 'Bad request URL.');
  }
  if (!isSameSite(requestUrl.toString(), headers)) {
    return jsonError(403, 'Drive download proxy refused a cross-origin request.');
  }

  var id = requestUrl.searchParams.get('id') || '';
  var kind = requestUrl.searchParams.get('kind') || 'media';
  var abuse = requestUrl.searchParams.get('abuse') === '1';
  var apiKey = headers.get('x-drive-api-key') || '';
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(id)) return jsonError(400, 'Missing or invalid Drive file id.');
  if (kind !== 'media' && kind !== 'export') return jsonError(400, 'Invalid download kind.');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) return jsonError(400, 'Missing or invalid Google API key.');

  var target = googleDownloadUrl(id, kind, apiKey, abuse);
  var result = await fetchGoogle(target, callerReferer(requestUrl.toString(), headers), fetchImpl);
  if (result.error) return result.error;
  var upstream = result.upstream;

  if (!upstream.ok) {
    var errText = await upstream.text();
    if (errText.length > 4000) errText = errText.slice(0, 4000);
    return proxyResponse(upstream.status, redactSecrets(errText), upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
  }

  var declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    try { upstream.body && upstream.body.cancel && await upstream.body.cancel(); } catch (e) {}
    return jsonError(413, 'File is too large to relay through the dashboard (over 4 MB). Download it from Drive and use Upload CSV.');
  }
  var read = await readLimited(upstream, MAX_BYTES);
  if (read.tooBig) {
    return jsonError(413, 'File is too large to relay through the dashboard (over 4 MB). Download it from Drive and use Upload CSV.');
  }
  if (method === 'HEAD') return proxyResponse(200, '', upstream.headers.get('content-type') || 'application/octet-stream');
  return proxyResponse(200, read.buf, upstream.headers.get('content-type') || 'application/octet-stream');
}

async function handler(req, res) {
  var host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  if (Array.isArray(host)) host = host[0];
  host = String(host).split(',')[0].trim();
  var proto = req.headers['x-forwarded-proto'] || 'https';
  if (Array.isArray(proto)) proto = proto[0];
  var response = await handleDriveDownload({
    method: req.method,
    url: String(proto).split(',')[0].trim() + '://' + host + req.url,
    headers: req.headers
  });
  res.statusCode = response.status;
  response.headers.forEach(function (value, key) {
    res.setHeader(key, value);
  });
  var body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

handler.handleDriveDownload = handleDriveDownload;
handler.isAllowedDownloadHost = isAllowedDownloadHost;
handler.redactSecrets = redactSecrets;
handler.MAX_BYTES = MAX_BYTES;
module.exports = handler;
