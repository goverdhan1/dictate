(function () {
  const DEFAULTS = {
    inputSelectors: ['textarea[data-id]', 'div[contenteditable="true"]', '#prompt-textarea'],
    sendButtonSelectors: ['button[type="submit"]','button[aria-label="Send"]','button[aria-label="Send prompt"]','#composer-submit-button','button[aria-label="Submit dictation"]'],
    audioButtonSelectors: ['button[aria-label*="Play"]','button[aria-label*="Audio"]','button[aria-label*="Dictate"]','button[aria-label="Dictate button"]','button[aria-label="Stop dictation"]','button[title*="Play"]'],
    debounceMs: 300
  };

  function findFirst(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  let lastValue = '';
  let lastAction = 0;
  let continuousMode = false;
  let dictateObserver = null;
  let attachInterval = null;

  async function isEnabled() {
    try {
      const data = await chrome.storage.local.get({ enabled: true });
      return data.enabled !== false;
    } catch (e) {
      console.warn('Extension context invalidated, assuming disabled:', e);
      return false;
    }
  }

  function clickElement(el) {
    if (!el) return false;
    try { el.focus?.(); el.click(); return true; } catch (e) { console.warn(e); return false; }
  }

  function trySend() { return clickElement(findFirst(DEFAULTS.sendButtonSelectors)); }
  function tryAudio() { return clickElement(findFirst(DEFAULTS.audioButtonSelectors)); }

  function getDictateState() {
    const btn = findFirst(DEFAULTS.audioButtonSelectors);
    if (!btn) {
      console.log('getDictateState: No dictate button found');
      return 'inactive';
    }
    const label = btn.getAttribute('aria-label') || '';
    console.log('getDictateState: Button found, aria-label:', label, 'outerHTML:', btn.outerHTML.substring(0, 200));
    const state = label.includes('Stop dictation') ? 'active' : 'inactive';
    console.log('getDictateState: Determined state:', state);
    return state;
  }

  function setupDictateObserver() {
    // Disconnect any existing observer
    if (dictateObserver) {
      dictateObserver.disconnect();
      dictateObserver = null;
    }
    const dictateBtn = findFirst(DEFAULTS.audioButtonSelectors);
    if (dictateBtn) {
      dictateObserver = new MutationObserver((mutations) => {
        // Reduced logging: only log if aria-label changed
        let labelChanged = false;
        mutations.forEach(mutation => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'aria-label') {
            labelChanged = true;
          }
        });
        if (labelChanged) {
          if (continuousMode) {
            const state = getDictateState();
            if (state === 'inactive') {
              console.log('Dictation stopped, restarting...');
              // ChatGPT manual cancel was clicked, clear input and restart dictate
              const inputEl = findFirst(DEFAULTS.inputSelectors);
              if (inputEl) {
                if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
                  inputEl.value = '';
                } else {
                  inputEl.innerText = '';
                  inputEl.textContent = '';
                }
                lastValue = '';
              }
              // Restart dictation with a small delay to ensure button is ready
              setTimeout(() => {
                const audioResult = tryAudio(); // Restart dictation
                console.log('Dictation restarted, tryAudio result:', audioResult);
              }, 100);
            }
          }
        }
      });
      dictateObserver.observe(dictateBtn, { attributes: true, attributeFilter: ['aria-label'], attributeOldValue: true });
      console.log('Dictate button observer set up for continuous mode');
    }
  }



  function getInputText(el) { if (!el) return ''; if(el.tagName==='TEXTAREA'||el.tagName==='INPUT') return el.value||''; return el.innerText||el.textContent||''; }

  let checkTimeout;

  function observeInput(inputEl) {
    if (!inputEl) return;
    if (inputEl.tagName==='TEXTAREA'||inputEl.tagName==='INPUT') {
      inputEl.addEventListener('input', async () => {
        if(!(await isEnabled())) return;
        clearTimeout(checkTimeout);
        checkTimeout = setTimeout(() => maybeSendOnDictation(inputEl.value.trim()), 100);
      });
    } else {
      const mo = new MutationObserver(async (mutations) => {
        if(!(await isEnabled())) return;
        clearTimeout(checkTimeout);
        checkTimeout = setTimeout(() => maybeSendOnDictation(getInputText(inputEl).trim()), 100);
      });
      mo.observe(inputEl,{childList:true,subtree:true,characterData:true});
    }
  }

  function maybeSendOnDictation(value) {
    const now=Date.now();
    if(now-lastAction<DEFAULTS.debounceMs) return;
    if(!value){
      console.log('Input cleared, lastValue:', lastValue, 'continuousMode:', continuousMode, 'dictateState:', getDictateState());
      if(lastValue !== '' && continuousMode){
        console.log('Input cleared after sending, restarting dictation');
        setTimeout(() => {
          const result = tryAudio();
          console.log('Restart dictation result:', result);
        }, 500);
      }
      lastValue=''; return;
    }
    const grew=value.length>lastValue.length+1;
    const endedWithPunctuation=/[.?!]$/.test(value);
    console.log('Dictation check:', { value, lastValue, grew, endedWithPunctuation, continuousMode });
    if(grew&&(endedWithPunctuation||value.length-lastValue.length>5)){
      console.log('Sending message...');
      if(trySend()){
        lastAction=now;
        lastValue=''; // Reset lastValue to prevent multiple sends
        if(continuousMode){
          setTimeout(()=>{console.log('Re-enabling audio...'); tryAudio();},500);
        }
      }
    } else {
      lastValue=value; // Only update lastValue if not sending
    }
  }

  function attachObservers() {
    const inputEl = findFirst(DEFAULTS.inputSelectors);
    if (inputEl) {
      console.log('Attaching observer to input element:', inputEl);
      observeInput(inputEl);
      if (attachInterval) {
        clearInterval(attachInterval);
        attachInterval = null;
      }
    } else {
      if (!attachInterval) {
        attachInterval = setInterval(() => {
          const el = findFirst(DEFAULTS.inputSelectors);
          if (el) {
            console.log('Input element found on retry:', el);
            observeInput(el);
            clearInterval(attachInterval);
            attachInterval = null;
          }
        }, 200); // Reduced interval for quicker detection
      }
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startContinuous') {
      continuousMode = true;
      setupDictateObserver(); // Ensure observer is set up
      console.log('Continuous dictate mode started');
      sendResponse({ success: true });
    } else if (message.action === 'stopContinuous') {
      continuousMode = false;
      if (dictateObserver) {
        dictateObserver.disconnect();
        dictateObserver = null;
      }
      console.log('Continuous dictate mode stopped');
      sendResponse({ success: true });
    }
  });



  // Inject control buttons into the page
  function injectButtons() {
    if (document.getElementById('auto-dictate-controls')) return; // Already injected

    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'auto-dictate-controls';
    controlsDiv.style.cssText = `
      position: fixed;
      top: 50px;
      right: 10px;
      z-index: 10000;
      font-family: Arial, sans-serif;
      font-size: 16px;
    `;

    const startBtn = document.createElement('button');
    startBtn.id = 'auto-dictate-start';
    startBtn.textContent = 'Start Dictate';
    startBtn.style.cssText = 'padding: 8px; background-color: blue; color: white; border: none; border-radius: 4px; cursor: pointer;';
    startBtn.addEventListener('click', () => {
      const state = getDictateState();
      if (state === 'inactive') {
        continuousMode = true;
        tryAudio(); // Start dictation
        console.log('Dictate mode started');
      } else {
        console.log('Dictation already active');
      }
    });

    const stopBtn = document.createElement('button');
    stopBtn.id = 'auto-dictate-stop';
    stopBtn.textContent = 'Stop Dictate';
    stopBtn.style.cssText = 'padding: 8px; background-color: red; color: white; border: none; border-radius: 4px; cursor: pointer;';
    stopBtn.addEventListener('click', () => {
      // Send current input if any, then stop
      const inputEl = findFirst(DEFAULTS.inputSelectors);
      const currentValue = getInputText(inputEl).trim();
      console.log('Stop clicked, current input value:', currentValue, 'inputEl:', inputEl);
      if (currentValue && currentValue.length > 0) {
        console.log('Sending final message before stopping...');
        const sendResult = trySend();
        console.log('Send result:', sendResult);
        if (sendResult) {
          // Wait for send to process, then stop
          setTimeout(() => {
            continuousMode = false;
            if (dictateObserver) {
              dictateObserver.disconnect();
              dictateObserver = null;
            }
            const state = getDictateState();
            if (state === 'active') {
              tryAudio(); // Stop dictation
            }
            console.log('Dictate mode stopped after sending');
          }, 3000); // Increased timeout to ensure send completes
        } else {
          console.log('Send failed, stopping immediately');
          continuousMode = false;
          if (dictateObserver) {
            dictateObserver.disconnect();
            dictateObserver = null;
          }
          const state = getDictateState();
          if (state === 'active') {
            tryAudio(); // Stop dictation
          }
          console.log('Dictate mode stopped (send failed)');
        }
      } else {
        console.log('No input to send, stopping immediately');
        continuousMode = false;
        if (dictateObserver) {
          dictateObserver.disconnect();
          dictateObserver = null;
        }
        const state = getDictateState();
        if (state === 'active') {
          tryAudio(); // Stop dictation
        }
        console.log('Dictate mode stopped');
      }
    });

    controlsDiv.appendChild(startBtn);
    controlsDiv.appendChild(stopBtn);
    document.body.appendChild(controlsDiv);
  }

  const appObserver = new MutationObserver(() => { attachObservers(); setupDictateObserver(); });
  appObserver.observe(document.body,{childList:true,subtree:true});
  attachObservers();
  console.log('ChatGPT Auto-Dictate content script running');
  setTimeout(() => {
    attachObservers();
    injectButtons();
  }, 1000); // Reduced initial delay
})();
