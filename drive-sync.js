/* Drive folder sync helpers.
 *
 * File listing (drive/v3/files?q=...) is a JSON call and Google attaches
 * Access-Control-Allow-Origin, so the browser can read errors. File bytes
 * (alt=media / export) come from the media frontend, which sometimes answers
 * without that header — a rate-limit or abuse page, or a redirect to
 * drive.usercontent.google.com. fetch() then rejects with "Failed to fetch"
 * and the status is invisible. Downloads therefore go through the same-origin
 * /api/drive-download proxy first (it can follow the redirect and read the
 * real status). Unchanged files are skipped using modifiedTime/md5/size.
 */
(function (root) {
  'use strict';

  var CACHE_KEY = 'drive_file_cache';
  var NATIVE_SHEET = 'application/vnd.google-apps.spreadsheet';
  var lane = Promise.resolve();

  function isNativeSheet(file) {
    return !!(file && file.mimeType === NATIVE_SHEET);
  }

  function listUrl(folderId, apiKey) {
    return 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false")
      + '&fields=' + encodeURIComponent('files(id,name,mimeType,modifiedTime,md5Checksum,size)')
      + '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=' + encodeURIComponent(apiKey);
  }

  function directDownloadUrl(file, apiKey, abuse) {
    var url;
    if (isNativeSheet(file)) {
      url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id)
        + '/export?mimeType=' + encodeURIComponent('text/csv')
        + '&supportsAllDrives=true&key=' + encodeURIComponent(apiKey);
    } else {
      url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id)
        + '?alt=media&supportsAllDrives=true&key=' + encodeURIComponent(apiKey);
    }
    if (abuse) url += '&acknowledgeAbuse=true';
    return url;
  }

  function proxyDownloadUrl(file, abuse) {
    var kind = isNativeSheet(file) ? 'export' : 'media';
    var url = '/api/drive-download?id=' + encodeURIComponent(file.id) + '&kind=' + kind;
    if (abuse) url += '&abuse=1';
    return url;
  }

  function revisionKey(file) {
    return [
      file.modifiedTime || '',
      file.md5Checksum || '',
      file.size == null ? '' : String(file.size),
      file.name || '',
      file.mimeType || ''
    ].join('|');
  }

  function isUnchanged(entry, file) {
    if (!entry || !file) return false;
    // Without a revision stamp, skipping would hide later edits forever.
    if (!file.modifiedTime && !file.md5Checksum) return false;
    return entry.revision === revisionKey(file);
  }

  function selectDownloadTargets(files, cache, force) {
    var download = [];
    var skipped = [];
    (files || []).forEach(function (file) {
      if (!force && isUnchanged(cache && cache[file.id], file)) skipped.push(file);
      else download.push(file);
    });
    return { download: download, skipped: skipped };
  }

  function filterSyncable(files) {
    var out = [];
    (files || []).forEach(function (file) {
      if (!file || !file.id) return;
      if (isNativeSheet(file)) { out.push(file); return; }
      var ext = String(file.name || '').split('.').pop().toLowerCase();
      if (ext === 'csv' || ext === 'xls' || ext === 'xlsx') out.push(file);
    });
    return out;
  }

  function explainFetchFailure(err) {
    var msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
    var network = msg === 'Failed to fetch'
      || (err && err.name === 'TypeError' && /failed to fetch|networkerror|load failed/i.test(msg))
      || /networkerror when attempting to fetch resource/i.test(msg);
    if (!network) return msg;
    return 'Google request blocked in this browser (Failed to fetch: no Access-Control-Allow-Origin). '
      + 'Drive does this on file downloads when it rate-limits the network, returns an abuse page, or redirects to drive.usercontent.google.com. '
      + 'Wait a few minutes, then Sync Now — unchanged files are skipped, so the next sync is lighter. '
      + 'Also confirm the folder is shared as "Anyone with the link can view" and the API key allows this site.';
  }

  function explainHttpError(status, bodyText, fileName) {
    var text = String(bodyText || '');
    var apiMsg = '';
    var reason = '';
    try {
      var parsed = JSON.parse(text);
      apiMsg = parsed && parsed.error && parsed.error.message ? String(parsed.error.message) : '';
      var errors = parsed && parsed.error && parsed.error.errors;
      reason = errors && errors[0] && errors[0].reason ? String(errors[0].reason) : '';
    } catch (e) {}
    var prefix = 'HTTP ' + status + (fileName ? ' for "' + fileName + '"' : '');
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429 || /rate limit|quota exceeded/i.test(apiMsg)) {
      return prefix + ': Google Drive rate limit. Wait a few minutes, then Sync Now.' + (apiMsg ? ' (' + apiMsg + ')' : '');
    }
    if (reason === 'cannotDownloadAbusiveFile' || /abusive|malware/i.test(apiMsg)) {
      return prefix + ': Google blocked this file as a potentially unsafe download. If it is your own spreadsheet, open it in Drive to confirm it is not flagged, or upload it with Upload CSV.'
        + (apiMsg ? ' (' + apiMsg + ')' : '');
    }
    if (status === 403 && /sufficient permissions|only accessible|file not shared/i.test(apiMsg)) {
      return prefix + ': ' + apiMsg + ' Share the folder as "Anyone with the link can view".';
    }
    if (status === 403 && /API key|API_KEY/i.test(apiMsg)) {
      return prefix + ': ' + apiMsg + ' Check the key, and that this site is an allowed referrer if the key is restricted.';
    }
    if (status === 404) {
      return prefix + ': file not found. It may have been deleted, or the folder is not shared as "Anyone with the link can view".'
        + (apiMsg ? ' (' + apiMsg + ')' : '');
    }
    if (status === 413) {
      return prefix + ': ' + (apiMsg || 'file is too large to download through the dashboard. Use Upload CSV for this file.');
    }
    if (/<\s*html/i.test(text) || /unusual traffic|automated queries/i.test(text)) {
      return prefix + ': Google returned a block page instead of the file (this network is being rate-limited or flagged for unusual traffic). Wait 10–15 minutes, then Sync Now.';
    }
    if (apiMsg) return prefix + ': ' + apiMsg;
    var snippet = text.replace(/\s+/g, ' ').trim();
    if (snippet.length > 180) snippet = snippet.slice(0, 180) + '…';
    return prefix + (snippet ? ': ' + snippet : '');
  }

  function shouldRetryStatus(status, bodyText) {
    if (status === 502 && /unexpected host/i.test(bodyText || '')) return false;
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  function sleep(ms, sleepImpl) {
    if (sleepImpl) return Promise.resolve(sleepImpl(ms));
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function performDownload(file, apiKey, opts) {
    var fetchImpl = opts.fetchImpl || fetch;
    var maxStatusAttempts = opts.maxStatusAttempts || 3;
    var maxNetworkAttempts = opts.maxNetworkAttempts || 2;
    var sleepImpl = opts.sleepImpl || null;
    var useProxy = opts.useProxy !== false;

    function backoff(attempt) {
      return (opts.retryBaseMs != null ? opts.retryBaseMs : 700) * Math.pow(2, attempt);
    }

    function failHttp(res, text) {
      var error = new Error(explainHttpError(res.status, text, file.name));
      error.status = res.status;
      throw error;
    }

    function doRequest(proxy, abuse, attempt) {
      var url = proxy ? proxyDownloadUrl(file, abuse) : directDownloadUrl(file, apiKey, abuse);
      var init = { method: 'GET', credentials: 'omit' };
      if (proxy) init.headers = { 'X-Drive-Api-Key': apiKey };
      return Promise.resolve().then(function () {
        return fetchImpl(url, init);
      }).then(function (res) {
        if (!res) throw new TypeError('Failed to fetch');
        var fromProxy = !!(proxy && res.headers && typeof res.headers.get === 'function' && res.headers.get('x-drive-proxy') === '1');
        if (proxy && !fromProxy) return doRequest(false, abuse, 0);
        if (res.ok) {
          return res.blob().then(function (blob) {
            return { blob: blob, via: proxy ? 'proxy' : 'direct' };
          });
        }
        return res.text().then(function (text) {
          if (!abuse && res.status === 403 && /cannotDownloadAbusiveFile/i.test(text || '')) {
            return doRequest(proxy, true, attempt);
          }
          if (shouldRetryStatus(res.status, text) && attempt + 1 < maxStatusAttempts) {
            return sleep(backoff(attempt), sleepImpl).then(function () {
              return doRequest(proxy, abuse, attempt + 1);
            });
          }
          failHttp(res, text);
        });
      }).catch(function (err) {
        if (err && err.status) throw err;
        if (proxy) return doRequest(false, abuse, 0);
        if (attempt + 1 < maxNetworkAttempts) {
          return sleep(backoff(attempt), sleepImpl).then(function () {
            return doRequest(false, abuse, attempt + 1);
          });
        }
        throw new Error(explainFetchFailure(err));
      });
    }

    return doRequest(!!useProxy, false, 0);
  }

  function enqueue(task) {
    var run = lane.then(task, task);
    lane = run.then(function () { return null; }, function () { return null; });
    return run;
  }

  function resetQueue() {
    lane = Promise.resolve();
  }

  function downloadDriveFile(file, apiKey, opts) {
    opts = opts || {};
    if (!apiKey) return Promise.reject(new Error('Add your Google API key above before syncing a Drive Folder.'));
    if (!file || !file.id) return Promise.reject(new Error('Missing Drive file id.'));
    function run() {
      return performDownload(file, apiKey, opts).then(function (result) {
        if (!opts.pauseMs) return result;
        return sleep(opts.pauseMs, opts.sleepImpl).then(function () { return result; });
      });
    }
    if (opts.queued === false) return run();
    return enqueue(run);
  }

  function runPool(items, limit, worker) {
    var results = new Array(items.length);
    var nextIndex = 0;
    var active = 0;
    var finished = 0;
    var width = limit > 0 ? limit : 1;
    if (!items.length) return Promise.resolve(results);
    return new Promise(function (resolve) {
      function kick() {
        if (finished === items.length) { resolve(results); return; }
        while (active < width && nextIndex < items.length) start(nextIndex++);
      }
      function start(idx) {
        active++;
        Promise.resolve().then(function () {
          return worker(items[idx], idx);
        }).then(function (value) {
          results[idx] = value;
        }, function () {
          results[idx] = undefined;
        }).then(function () {
          active--;
          finished++;
          kick();
        });
      }
      kick();
    });
  }

  function syncFolderFiles(opts) {
    opts = opts || {};
    var folder = opts.folder || {};
    var cache = opts.cache || {};
    function log(level, msg) {
      if (opts.log) opts.log(level, msg);
    }
    if (!opts.apiKey) {
      log('error', 'No API key set — skipped.');
      return Promise.resolve({
        added: 0,
        error: 'Add your Google API key above before syncing a Drive Folder.',
        downloaded: 0,
        skipped: 0,
        checked: 0
      });
    }
    log('info', 'Checking folder for files…');
    var fetchImpl = opts.fetchImpl || fetch;
    return Promise.resolve().then(function () {
      return fetchImpl(listUrl(folder.folderId, opts.apiKey), { method: 'GET', credentials: 'omit' });
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          var error = new Error(explainHttpError(res.status, text));
          error.status = res.status;
          throw error;
        });
      }
      return res.json();
    }).then(function (json) {
      var files = filterSyncable((json && json.files) || []);
      if (!files.length) {
        log('info', 'No CSV/XLS/XLSX files found in folder.');
        return { added: 0, error: null, downloaded: 0, skipped: 0, checked: 0 };
      }
      var plan = selectDownloadTargets(files, cache, !!opts.force);
      var added = 0;
      var downloaded = 0;
      var firstErr = null;
      var limit = opts.concurrency > 0 ? opts.concurrency : 1;
      return runPool(plan.download, limit, function (file) {
        return downloadDriveFile(file, opts.apiKey, opts).then(function (got) {
          var fname = isNativeSheet(file) ? String(file.name || 'sheet') + '.csv' : file.name;
          var fileObj = new File([got.blob], fname, { type: (got.blob && got.blob.type) || '' });
          return Promise.resolve(opts.parseFile(fileObj, folder.platform)).then(function (n) {
            added += n || 0;
            downloaded += 1;
            cache[file.id] = {
              platform: folder.platform || '',
              revision: revisionKey(file),
              name: file.name || '',
              modifiedTime: file.modifiedTime || '',
              md5: file.md5Checksum || '',
              size: file.size == null ? '' : String(file.size)
            };
            if (opts.persistCache) opts.persistCache(cache);
          });
        }).catch(function (err) {
          if (!firstErr) firstErr = (err && err.message) || String(err);
          if (opts.onFileError) {
            try { opts.onFileError(file, err); } catch (e) {}
          }
        });
      }).then(function () {
        var msg = 'Synced ' + files.length + ' file(s) → ' + added + ' new session(s)';
        if (plan.skipped.length) msg += ' (' + plan.skipped.length + ' unchanged, not re-downloaded)';
        if (firstErr) msg += ' (with errors: ' + firstErr + ')';
        log(firstErr ? 'error' : 'ok', msg);
        return {
          added: added,
          error: firstErr,
          downloaded: downloaded,
          skipped: plan.skipped.length,
          checked: files.length
        };
      });
    }).catch(function (err) {
      var msg = err && err.status ? err.message : explainFetchFailure(err);
      log('error', 'Folder check failed: ' + msg);
      return { added: 0, error: msg, downloaded: 0, skipped: 0, checked: 0 };
    });
  }

  function loadCache() {
    try {
      if (typeof localStorage === 'undefined') return {};
      var parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache || {}));
    } catch (e) {}
  }

  function forgetCache(platform) {
    if (typeof localStorage === 'undefined') return;
    if (!platform) {
      try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
      return;
    }
    var cache = loadCache();
    Object.keys(cache).forEach(function (id) {
      if (cache[id] && cache[id].platform === platform) delete cache[id];
    });
    saveCache(cache);
  }

  var api = {
    CACHE_KEY: CACHE_KEY,
    isNativeSheet: isNativeSheet,
    listUrl: listUrl,
    directDownloadUrl: directDownloadUrl,
    proxyDownloadUrl: proxyDownloadUrl,
    revisionKey: revisionKey,
    isUnchanged: isUnchanged,
    selectDownloadTargets: selectDownloadTargets,
    filterSyncable: filterSyncable,
    explainFetchFailure: explainFetchFailure,
    explainHttpError: explainHttpError,
    downloadDriveFile: downloadDriveFile,
    syncFolderFiles: syncFolderFiles,
    runPool: runPool,
    loadCache: loadCache,
    saveCache: saveCache,
    forgetCache: forgetCache,
    resetQueue: resetQueue
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DriveSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
