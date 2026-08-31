/**
 * Injected into Teams / ChatGPT page context.
 * Provides chrome.storage and chrome.runtime shims backed by window.__dictateApi.
 */
(function installDictateChromeShim() {
  if (window.__dictateChromeShimInstalled) return;
  window.__dictateChromeShimInstalled = true;

  const pendingCallbacks = new Map();
  let requestId = 0;
  const messageListeners = [];

  function invokeIpc(msg) {
    if (!window.__dictateApi?.invoke) {
      return Promise.reject(new Error('Dictate API unavailable'));
    }
    return window.__dictateApi.invoke('runtime-message', msg);
  }

  window.chrome = window.chrome || {};
  const PAGE_LOCAL_ACTIONS = new Set([
    'ping',
    'receiveFromTeams',
    'startContinuous',
    'stopContinuous',
    'submit'
  ]);

  window.chrome.runtime = {
    id: 'dictate-desktop',
    sendMessage: function sendMessage(message, callback) {
      const deliver = (result) => {
        if (typeof callback === 'function') callback(result);
      };

      // Route page actions to injected content-script listeners first.
      if (message?.action && PAGE_LOCAL_ACTIONS.has(message.action) && messageListeners.length > 0) {
        let asyncReply = false;
        for (const fn of messageListeners) {
          try {
            if (fn(message, {}, deliver) === true) asyncReply = true;
          } catch (e) {
            console.warn('[Dictate] onMessage listener error:', e);
          }
        }
        if (asyncReply) return true;
        return true;
      }

      invokeIpc(message)
        .then(deliver)
        .catch((err) => deliver({ success: false, error: String(err) }));
      return true;
    },
    onMessage: {
      addListener(fn) {
        if (typeof fn === 'function') messageListeners.push(fn);
      },
      removeListener(fn) {
        const idx = messageListeners.indexOf(fn);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }
    }
  };

  window.chrome.storage = {
    local: {
      get(keys, callback) {
        const payload = typeof keys === 'string' ? { [keys]: null } : (keys || {});
        invokeIpc({ action: 'storage-get', keys: payload })
          .then((data) => {
            if (typeof callback === 'function') callback(data || {});
          })
          .catch(() => {
            if (typeof callback === 'function') callback({});
          });
      },
      set(obj, callback) {
        invokeIpc({ action: 'storage-set', data: obj })
          .then(() => {
            if (typeof callback === 'function') callback();
          })
          .catch(() => {
            if (typeof callback === 'function') callback();
          });
      }
    }
  };

  if (window.__dictateApi?.onPush) {
    window.__dictateApi.onPush((message) => {
      for (const fn of messageListeners) {
        try {
          fn(message, {}, () => {});
        } catch (e) {
          console.warn('[Dictate] onMessage listener error:', e);
        }
      }
    });
  }
})();
