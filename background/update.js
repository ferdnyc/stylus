/*
global getStyles saveStyle styleSectionsEqual
global calcStyleDigest cachedStyles getStyleWithNoCode
global usercss semverCompare
global API_METHODS
*/
'use strict';

(() => {

  const STATES = {
    UPDATED: 'updated',
    SKIPPED: 'skipped',

    // details for SKIPPED status
    EDITED:        'locally edited',
    MAYBE_EDITED:  'may be locally edited',
    SAME_MD5:      'up-to-date: MD5 is unchanged',
    SAME_CODE:     'up-to-date: code sections are unchanged',
    SAME_VERSION:  'up-to-date: version is unchanged',
    ERROR_MD5:     'error: MD5 is invalid',
    ERROR_JSON:    'error: JSON is invalid',
    ERROR_VERSION: 'error: version is older than installed style',
  };

  let lastUpdateTime = parseInt(localStorage.lastUpdateTime) || Date.now();
  let checkingAll = false;
  let logQueue = [];
  let logLastWriteTime = 0;

  const retrying = new Set();

  API_METHODS.updateCheckAll = checkAllStyles;
  API_METHODS.updateCheck = checkStyle;
  API_METHODS.getUpdaterStates = () => STATES;

  prefs.subscribe(['updateInterval'], schedule);
  schedule();

  return {checkAllStyles, checkStyle, STATES};

  function checkAllStyles({
    save = true,
    ignoreDigest,
    observe,
  } = {}) {
    resetInterval();
    checkingAll = true;
    retrying.clear();
    const port = observe && chrome.runtime.connect({name: 'updater'});
    return getStyles({}).then(styles => {
      styles = styles.filter(style => style.updateUrl);
      if (port) port.postMessage({count: styles.length});
      log('');
      log(`${save ? 'Scheduled' : 'Manual'} update check for ${styles.length} styles`);
      return Promise.all(
        styles.map(style =>
          checkStyle({style, port, save, ignoreDigest})));
    }).then(() => {
      if (port) port.postMessage({done: true});
      if (port) port.disconnect();
      log('');
      checkingAll = false;
      retrying.clear();
    });
  }

  function checkStyle({
    id,
    style = cachedStyles.byId.get(id),
    port,
    save = true,
    ignoreDigest,
  }) {
    /*
    Original style digests are calculated in these cases:
    * style is installed or updated from server
    * style is checked for an update and its code is equal to the server code

    Update check proceeds in these cases:
    * style has the original digest and it's equal to the current digest
    * [ignoreDigest: true] style doesn't yet have the original digest but we ignore it
    * [ignoreDigest: none/false] style doesn't yet have the original digest
      so we compare the code to the server code and if it's the same we save the digest,
      otherwise we skip the style and report MAYBE_EDITED status

    'ignoreDigest' option is set on the second manual individual update check on the manage page.
    */
    return Promise.resolve(style)
      .then([calcStyleDigest][!ignoreDigest ? 0 : 'skip'])
      .then([checkIfEdited][!ignoreDigest ? 0 : 'skip'])
      .then([maybeUpdateUSO, maybeUpdateUsercss][style.usercssData ? 1 : 0])
      .then(maybeSave)
      .then(reportSuccess)
      .catch(reportFailure);

    function reportSuccess(saved) {
      log(STATES.UPDATED + ` #${style.id} ${style.name}`);
      const info = {updated: true, style: saved};
      if (port) port.postMessage(info);
      return info;
    }

    function reportFailure(error) {
      // retry once if the error is 503 Service Unavailable
      if (error === 503 && !retrying.get(id)) {
        retrying.add(id);
        return new Promise(resolve => {
          setTimeout(() => {
            resolve(checkStyle(id, style, port, save, ignoreDigest));
          }, 1000);
        });
      }
      error = error === 0 ? 'server unreachable' : error;
      log(STATES.SKIPPED + ` (${error}) #${style.id} ${style.name}`);
      const info = {error, STATES, style: getStyleWithNoCode(style)};
      if (port) port.postMessage(info);
      return info;
    }

    function checkIfEdited(digest) {
      if (style.originalDigest && style.originalDigest !== digest) {
        return Promise.reject(STATES.EDITED);
      }
    }

    function maybeUpdateUSO() {
      return download(style.md5Url).then(md5 => {
        if (!md5 || md5.length !== 32) {
          return Promise.reject(STATES.ERROR_MD5);
        }
        if (md5 === style.originalMd5 && style.originalDigest && !ignoreDigest) {
          return Promise.reject(STATES.SAME_MD5);
        }
        // USO can't handle POST requests for style json
        return download(style.updateUrl, {body: null})
          .then(text => tryJSONparse(text));
      });
    }

    function maybeUpdateUsercss() {
      // TODO: when sourceCode is > 100kB use http range request(s) for version check
      return download(style.updateUrl).then(text => {
        const json = usercss.buildMeta(text);
        const {usercssData: {version}} = style;
        const {usercssData: {version: newVersion}} = json;
        switch (Math.sign(semverCompare(version, newVersion))) {
          case 0:
            // re-install is invalid in a soft upgrade
            if (!ignoreDigest) {
              return Promise.reject(STATES.SAME_VERSION);
            } else if (text === style.sourceCode) {
              return Promise.reject(STATES.SAME_CODE);
            }
            break;
          case 1:
            // downgrade is always invalid
            return Promise.reject(STATES.ERROR_VERSION);
        }
        return usercss.buildCode(json);
      });
    }

    function maybeSave(json = {}) {
      // usercss is already validated while building
      if (!json.usercssData && !styleJSONseemsValid(json)) {
        return Promise.reject(STATES.ERROR_JSON);
      }

      json.id = style.id;
      json.updateDate = Date.now();
      json.reason = 'update';

      // keep current state
      delete json.enabled;

      // keep local name customizations
      if (style.originalName !== style.name && style.name !== json.name) {
        delete json.name;
      } else {
        json.originalName = json.name;
      }

      if (styleSectionsEqual(json, style)) {
        // update digest even if save === false as there might be just a space added etc.
        saveStyle(Object.assign(json, {reason: 'update-digest'}));
        return Promise.reject(STATES.SAME_CODE);
      }

      if (!style.originalDigest && !ignoreDigest) {
        return Promise.reject(STATES.MAYBE_EDITED);
      }

      return save ?
        API_METHODS[json.usercssData ? 'saveUsercss' : 'saveStyle'](json) :
        json;
    }

    function styleJSONseemsValid(json) {
      return json
        && json.sections
        && json.sections.length
        && typeof json.sections.every === 'function'
        && typeof json.sections[0].code === 'string';
    }
  }

  function schedule() {
    const interval = prefs.get('updateInterval') * 60 * 60 * 1000;
    if (interval) {
      const elapsed = Math.max(0, Date.now() - lastUpdateTime);
      debounce(checkAllStyles, Math.max(10e3, interval - elapsed));
    } else {
      debounce.unregister(checkAllStyles);
    }
  }

  function resetInterval() {
    localStorage.lastUpdateTime = lastUpdateTime = Date.now();
    schedule();
  }

  function log(text) {
    logQueue.push({text, time: new Date().toLocaleString()});
    debounce(flushQueue, text && checkingAll ? 1000 : 0);
  }

  function flushQueue(stored) {
    if (!stored) {
      chrome.storage.local.get('updateLog', flushQueue);
      return;
    }
    const lines = stored.lines || [];
    const time = Date.now() - logLastWriteTime > 11e3 ?
      logQueue[0].time + ' ' :
      '';
    if (!logQueue[0].text) {
      logQueue.shift();
      if (lines[lines.length - 1]) lines.push('');
    }
    lines.splice(0, lines.length - 1000);
    lines.push(time + (logQueue[0] && logQueue[0].text || ''));
    lines.push(...logQueue.slice(1).map(item => item.text));

    chrome.storage.local.set({updateLog: lines});
    logLastWriteTime = Date.now();
    logQueue = [];
  }
})();
