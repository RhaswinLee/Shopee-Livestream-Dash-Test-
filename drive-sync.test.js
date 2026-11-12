'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DriveSync = require('./drive-sync');
const driveDownload = require('./api/drive-download');

const KEY = 'AIzaSyTESTKEY_not_a_real_key_0001';
const FILE = {
  id: '1O3UHCv9S9UUwYMR79pnrKbNC5MBHITEST',
  name: 'Shopee September.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  modifiedTime: '2026-09-30T00:00:00.000Z',
  md5Checksum: 'abc123',
  size: '1200'
};

function headers(map) {
  const lower = {};
  Object.keys(map || {}).forEach(function (key) {
    lower[String(key).toLowerCase()] = map[key];
  });
  return { get: function (name) { return lower[String(name).toLowerCase()] || null; } };
}

function response(status, body, headerMap, blobBody) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? '' : body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: headers(headerMap),
    text: function () { return Promise.resolve(text); },
    json: function () { return Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body); },
    blob: function () { return Promise.resolve(blobBody || new Blob([text])); }
  };
}

function proxyOk(body) {
  return response(200, body, { 'X-Drive-Proxy': '1', 'Content-Type': 'application/octet-stream' }, new Blob([body]));
}

test.beforeEach(function () {
  DriveSync.resetQueue();
});

test('list URL asks for revision fields and does not bake in a fixed key', function () {
  const url = DriveSync.listUrl('folder1234567890', KEY);
  assert.match(url, /modifiedTime/);
  assert.match(url, /md5Checksum/);
  assert.match(url, /supportsAllDrives=true/);
  assert.match(url, new RegExp('key=' + encodeURIComponent(KEY)));
  assert.equal(url.includes('AIzaSyCdMY'), false);
});

test('proxy download URL keeps the API key out of the query string', function () {
  const url = DriveSync.proxyDownloadUrl(FILE, false);
  assert.equal(url, '/api/drive-download?id=' + encodeURIComponent(FILE.id) + '&kind=media');
  assert.equal(url.includes(KEY), false);
  assert.equal(url.includes('key='), false);
  const sheet = DriveSync.proxyDownloadUrl({ id: FILE.id, mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Sheet' }, true);
  assert.match(sheet, /kind=export/);
  assert.match(sheet, /abuse=1/);
});

test('direct download URL uses alt=media for xlsx and export for a native sheet', function () {
  const media = DriveSync.directDownloadUrl(FILE, KEY, false);
  assert.match(media, /\/files\/[^?]+\?alt=media/);
  assert.match(media, /supportsAllDrives=true/);
  assert.doesNotMatch(media, /acknowledgeAbuse/);
  const abuse = DriveSync.directDownloadUrl(FILE, KEY, true);
  assert.match(abuse, /acknowledgeAbuse=true/);
  const sheet = DriveSync.directDownloadUrl({
    id: FILE.id,
    name: 'September',
    mimeType: 'application/vnd.google-apps.spreadsheet'
  }, KEY, false);
  assert.match(sheet, /\/export\?/);
  assert.match(sheet, /mimeType=text%2Fcsv/);
});

test('unchanged revision is skipped; a new md5 or a forced resync is not', function () {
  const cache = {};
  cache[FILE.id] = { revision: DriveSync.revisionKey(FILE), platform: 'shopee_my' };
  const same = DriveSync.selectDownloadTargets([FILE], cache, false);
  assert.equal(same.download.length, 0);
  assert.equal(same.skipped.length, 1);
  const edited = Object.assign({}, FILE, { md5Checksum: 'def456' });
  const changed = DriveSync.selectDownloadTargets([edited], cache, false);
  assert.equal(changed.download.length, 1);
  const forced = DriveSync.selectDownloadTargets([FILE], cache, true);
  assert.equal(forced.download.length, 1);
  assert.equal(forced.skipped.length, 0);
  assert.equal(DriveSync.isUnchanged(cache[FILE.id], { id: FILE.id, name: FILE.name }), false);
});

test('only csv, xls, xlsx, and native sheets are synced', function () {
  const files = DriveSync.filterSyncable([
    FILE,
    { id: 'csvfile12345', name: 'TikTok August.csv', mimeType: 'text/csv' },
    { id: 'xlsfile12345', name: 'old.xls' },
    { id: 'sheetfile123', name: 'Live', mimeType: 'application/vnd.google-apps.spreadsheet' },
    { id: 'pdffile12345', name: 'notes.pdf' },
    { id: 'folder123456', name: 'subdir', mimeType: 'application/vnd.google-apps.folder' }
  ]);
  assert.deepEqual(files.map(function (file) { return file.id; }), ['1O3UHCv9S9UUwYMR79pnrKbNC5MBHITEST', 'csvfile12345', 'xlsfile12345', 'sheetfile123']);
});

test('HTTP errors surface status and Google message; Failed to fetch is actionable', function () {
  const rate = DriveSync.explainHttpError(403, JSON.stringify({
    error: { message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] }
  }), 'Shopee September.xlsx');
  assert.match(rate, /HTTP 403/);
  assert.match(rate, /Shopee September\.xlsx/);
  assert.match(rate, /rate limit/i);
  assert.match(rate, /Quota exceeded/);
  const blocked = DriveSync.explainHttpError(403, '<html>Our systems have detected unusual traffic</html>');
  assert.match(blocked, /block page/i);
  const permissions = DriveSync.explainHttpError(403, JSON.stringify({
    error: { message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'insufficientFilePermissions' }] }
  }));
  assert.match(permissions, /Anyone with the link can view/);
  const network = DriveSync.explainFetchFailure(Object.assign(new TypeError('Failed to fetch'), {}));
  assert.match(network, /Access-Control-Allow-Origin/);
  assert.match(network, /Sync Now/);
  assert.equal(DriveSync.explainFetchFailure(new Error('HTTP 404 for "x"')), 'HTTP 404 for "x"');
});

test('downloads run one at a time', async function () {
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const fetchImpl = function () {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return gate.then(function () {
      inFlight -= 1;
      return proxyOk('a,b\n1,2\n');
    });
  };
  const opts = { useProxy: true, fetchImpl: fetchImpl, queued: true, pauseMs: 0, sleepImpl: function () { return Promise.resolve(); } };
  const first = DriveSync.downloadDriveFile(FILE, KEY, opts);
  const second = DriveSync.downloadDriveFile(Object.assign({}, FILE, { id: 'secondfile1234567890', name: 'Shopee October.xlsx' }), KEY, opts);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(maxInFlight, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.length, 2);
  assert.equal(maxInFlight, 1);
});

test('retries a rate limit, then surfaces success, without a retry storm on 404', async function () {
  const calls = [];
  const fetchImpl = function (url) {
    calls.push(String(url));
    if (calls.length === 1) {
      return Promise.resolve(response(429, { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, { 'X-Drive-Proxy': '1' }));
    }
    return Promise.resolve(proxyOk('ok'));
  };
  const got = await DriveSync.downloadDriveFile(FILE, KEY, {
    useProxy: true,
    fetchImpl: fetchImpl,
    queued: false,
    sleepImpl: function () { return Promise.resolve(); }
  });
  assert.equal(got.via, 'proxy');
  assert.equal(calls.length, 2);

  const missing = [];
  await assert.rejects(function () {
    return DriveSync.downloadDriveFile(FILE, KEY, {
      useProxy: true,
      queued: false,
      sleepImpl: function () { return Promise.resolve(); },
      fetchImpl: function (url) {
        missing.push(url);
        return Promise.resolve(response(404, { error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, { 'X-Drive-Proxy': '1' }));
      }
    });
  }, function (err) {
    assert.match(err.message, /HTTP 404/);
    assert.match(err.message, /not found/i);
    return true;
  });
  assert.equal(missing.length, 1);
});

test('abusive-file 403 retries once with acknowledgeAbuse', async function () {
  const calls = [];
  const got = await DriveSync.downloadDriveFile(FILE, KEY, {
    useProxy: true,
    queued: false,
    fetchImpl: function (url) {
      calls.push(String(url));
      if (calls.length === 1) {
        return Promise.resolve(response(403, {
          error: { message: 'This file has been identified as malware or spam and cannot be downloaded.', errors: [{ reason: 'cannotDownloadAbusiveFile' }] }
        }, { 'X-Drive-Proxy': '1' }));
      }
      return Promise.resolve(proxyOk('recovered'));
    }
  });
  assert.equal(got.via, 'proxy');
  assert.match(calls[1], /abuse=1/);
  assert.doesNotMatch(calls[0], /abuse=1/);
});

test('missing proxy falls back to a direct Drive URL and a CORS failure stays readable', async function () {
  const calls = [];
  await assert.rejects(function () {
    return DriveSync.downloadDriveFile(FILE, KEY, {
      useProxy: true,
      queued: false,
      maxNetworkAttempts: 1,
      fetchImpl: function (url) {
        calls.push(String(url));
        if (String(url).indexOf('/api/drive-download') === 0) {
          return Promise.resolve(response(404, '<html>not found</html>', { 'content-type': 'text/html' }));
        }
        return Promise.reject(new TypeError('Failed to fetch'));
      }
    });
  }, function (err) {
    assert.match(err.message, /Access-Control-Allow-Origin/);
    assert.match(err.message, /Anyone with the link/);
    return true;
  });
  assert.match(calls[0], /^\/api\/drive-download/);
  assert.match(calls[1], /www\.googleapis\.com\/drive\/v3\/files\//);
  assert.match(calls[1], /alt=media/);
  assert.equal(calls[1].includes('X-Drive-Api-Key') , false);
});

test('folder sync downloads once, skips unchanged files, and does not cache a failed parse', async function () {
  const downloads = [];
  const parsed = [];
  function fetchImpl(url) {
    const href = String(url);
    if (href.indexOf('/drive/v3/files?') !== -1) {
      return Promise.resolve(response(200, {
        files: [
          FILE,
          Object.assign({}, FILE, { id: 'tiktokfile12345678901', name: 'TikTok September.xlsx', md5Checksum: 'zzz' }),
          { id: 'ignorepdf123456789', name: 'readme.pdf' }
        ]
      }));
    }
    downloads.push(href);
    return Promise.resolve(proxyOk('bytes-' + href));
  }
  const cache = {};
  const logs = [];
  const opts = {
    folder: { folderId: 'folder1234567890', platform: 'shopee_my', name: 'Shopee MY' },
    apiKey: KEY,
    cache: cache,
    fetchImpl: fetchImpl,
    pauseMs: 0,
    useProxy: true,
    parseFile: function (fileObj, platform) {
      parsed.push({ name: fileObj.name, platform: platform });
      if (fileObj.name.indexOf('TikTok') !== -1) return Promise.reject(new Error('Could not read Excel file'));
      return Promise.resolve(4);
    },
    log: function (_level, msg) { logs.push(msg); }
  };
  const first = await DriveSync.syncFolderFiles(opts);
  assert.equal(first.downloaded, 1);
  assert.equal(first.added, 4);
  assert.equal(first.checked, 2);
  assert.match(first.error, /Could not read Excel file/);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].platform, 'shopee_my');
  assert.ok(cache[FILE.id]);
  assert.equal(cache['tiktokfile12345678901'], undefined);
  assert.equal(downloads.length, 2);

  downloads.length = 0;
  parsed.length = 0;
  const second = await DriveSync.syncFolderFiles(opts);
  assert.equal(second.downloaded, 0);
  assert.equal(second.skipped, 1);
  assert.equal(downloads.length, 1);
  assert.match(second.error, /Could not read Excel file/);
  assert.match(logs[logs.length - 1], /1 unchanged, not re-downloaded/);

  const third = await DriveSync.syncFolderFiles(Object.assign({}, opts, { force: true }));
  assert.equal(third.downloaded, 1);
  assert.ok(downloads.length >= 2);
});

test('folder listing error is the Google status, not Failed to fetch', async function () {
  const logs = [];
  const result = await DriveSync.syncFolderFiles({
    folder: { folderId: 'folder1234567890', platform: 'tiktok_my', name: 'TikTok MY' },
    apiKey: KEY,
    fetchImpl: function () {
      return Promise.resolve(response(403, {
        error: { message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'insufficientFilePermissions' }] }
      }));
    },
    log: function (level, msg) { logs.push(level + ':' + msg); }
  });
  assert.match(result.error, /HTTP 403/);
  assert.match(result.error, /Anyone with the link can view/);
  assert.match(logs[1], /Folder check failed/);
});

test('no API key skips the folder without calling fetch', async function () {
  let called = false;
  const result = await DriveSync.syncFolderFiles({
    folder: { folderId: 'folder1234567890', platform: 'shopee_my' },
    apiKey: '',
    fetchImpl: function () { called = true; return Promise.resolve(response(200, { files: [] })); },
    log: function () {}
  });
  assert.equal(called, false);
  assert.match(result.error, /API key/);
});

test('native sheet is handed to the parser as CSV and uses the folder platform', async function () {
  let seen = null;
  const result = await DriveSync.syncFolderFiles({
    folder: { folderId: 'folder1234567890', platform: 'tiktok_sg', name: 'TikTok SG' },
    apiKey: KEY,
    pauseMs: 0,
    fetchImpl: function (url) {
      if (String(url).indexOf('/drive/v3/files?') !== -1) {
        return Promise.resolve(response(200, {
          files: [{ id: 'nativesheet12345678', name: 'September', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-01T00:00:00.000Z' }]
        }));
      }
      assert.match(String(url), /kind=export/);
      return Promise.resolve(proxyOk('a,b\n1,2\n'));
    },
    parseFile: function (fileObj, platform) {
      seen = { name: fileObj.name, platform: platform };
      return Promise.resolve(2);
    },
    log: function () {}
  });
  assert.equal(result.added, 2);
  assert.equal(seen.name, 'September.csv');
  assert.equal(seen.platform, 'tiktok_sg');
});

test('proxy follows a usercontent redirect and refuses any other host', async function () {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
  const calls = [];
  const responseOk = await driveDownload.handleDriveDownload({
    method: 'GET',
    url: 'https://shopee-livestream-dash-test.vercel.app/api/drive-download?id=' + FILE.id + '&kind=media',
    headers: headers({ origin: 'https://shopee-livestream-dash-test.vercel.app', 'x-drive-api-key': KEY })
  }, {
    fetch: async function (url, init) {
      calls.push({ url: String(url), init: init });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://drive.usercontent.google.com/download/drive/v3/files/' + FILE.id + '?alt=media&ack=1' }
        });
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    }
  });
  assert.equal(responseOk.status, 200);
  assert.equal(responseOk.headers.get('x-drive-proxy'), '1');
  assert.equal(responseOk.headers.get('cache-control'), 'no-store');
  const body = Buffer.from(await responseOk.arrayBuffer());
  assert.deepEqual(body, bytes);
  assert.match(calls[0].url, /alt=media/);
  assert.match(calls[0].url, new RegExp('key=' + KEY));
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Referer, 'https://shopee-livestream-dash-test.vercel.app/');
  assert.match(calls[1].url, /^https:\/\/drive\.usercontent\.google\.com\//);
  assert.equal(calls[1].url.includes(KEY), false);

  const blocked = await driveDownload.handleDriveDownload({
    method: 'GET',
    url: 'https://shopee-livestream-dash-test.vercel.app/api/drive-download?id=' + FILE.id + '&kind=media',
    headers: headers({ origin: 'https://shopee-livestream-dash-test.vercel.app', 'x-drive-api-key': KEY })
  }, {
    fetch: async function () {
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect?key=' + KEY } });
    }
  });
  assert.equal(blocked.status, 502);
  const blockedText = await blocked.text();
  assert.match(blockedText, /unexpected host/);
  assert.equal(blockedText.includes(KEY), false);
  assert.match(blockedText, /REDACTED|unexpected host/);
});

test('proxy passes through a Google 403 body and rejects a foreign origin', async function () {
  const denied = await driveDownload.handleDriveDownload({
    method: 'GET',
    url: 'https://dash.example/api/drive-download?id=' + FILE.id + '&kind=media&abuse=1',
    headers: headers({ origin: 'https://dash.example', 'x-drive-api-key': KEY })
  }, {
    fetch: async function (url, init) {
      assert.match(String(url), /alt=media/);
      assert.match(String(url), /acknowledgeAbuse=true/);
      assert.equal(init.headers.Referer, 'https://dash.example/');
      return new Response(JSON.stringify({
        error: { message: 'Quota exceeded for quota metric', errors: [{ reason: 'rateLimitExceeded' }] }
      }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('x-drive-proxy'), '1');
  assert.match(await denied.text(), /Quota exceeded/);

  const foreign = await driveDownload.handleDriveDownload({
    method: 'GET',
    url: 'https://dash.example/api/drive-download?id=' + FILE.id,
    headers: headers({ origin: 'https://evil.example', 'x-drive-api-key': KEY })
  }, { fetch: async function () { throw new Error('should not fetch'); } });
  assert.equal(foreign.status, 403);

  const badId = await driveDownload.handleDriveDownload({
    method: 'GET',
    url: 'https://dash.example/api/drive-download?id=../etc/passwd',
    headers: headers({ 'x-drive-api-key': KEY })
  }, { fetch: async function () { throw new Error('should not fetch'); } });
  assert.equal(badId.status, 400);
});

test('host allowlist is Google download hosts only', function () {
  assert.equal(driveDownload.isAllowedDownloadHost('www.googleapis.com'), true);
  assert.equal(driveDownload.isAllowedDownloadHost('drive.usercontent.google.com'), true);
  assert.equal(driveDownload.isAllowedDownloadHost('xyz-apidata.googleusercontent.com'), true);
  assert.equal(driveDownload.isAllowedDownloadHost('drive.google.com'), false);
  assert.equal(driveDownload.isAllowedDownloadHost('evil.example'), false);
  assert.equal(driveDownload.isAllowedDownloadHost('googleapis.com.evil.example'), false);
});

test('dashboard still wires filename detection, clear & resync, and the proxy script', function () {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /src="drive-sync\.js"/);
  assert.match(html, /DriveSync\.syncFolderFiles/);
  assert.match(html, /force:\s*true/);
  assert.match(html, /function detectPlatformFromName/);
  assert.match(html, /tiktok/);
  assert.match(html, /shopee/);
  assert.match(html, /date range/);
  assert.match(html, /clearAndResyncFromDrive/);
  assert.doesNotMatch(html, /function fetchDriveFile\(/);
  assert.doesNotMatch(html, new RegExp(KEY));
});
