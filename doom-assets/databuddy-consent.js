const CLIENT_ID = '0f7c1b34-a28d-495f-9bd3-d6770e518c56';
const SCRIPT_ID = 'databuddy-analytics';
const SCRIPT_URL = 'https://cdn.databuddy.cc/databuddy.js';

function clearDatabuddyOptOut(target) {
  try {
    target.localStorage?.removeItem('databuddy_opt_out');
    target.localStorage?.removeItem('databuddy_disabled');
  } catch {}
  target.databuddyOptedOut = false;
  target.databuddyDisabled = false;
}

function setDatabuddyOptOut(target) {
  if (target.databuddyOptOut) {
    target.databuddyOptOut();
    return;
  }

  try {
    target.localStorage?.setItem('databuddy_opt_out', 'true');
    target.localStorage?.setItem('databuddy_disabled', 'true');
  } catch {}
  try {
    for (const key of ['did', 'did_profile', 'did_params']) {
      target.localStorage?.removeItem(key);
    }
  } catch {}
  try {
    for (const key of [
      'did_session',
      'did_session_timestamp',
      'did_session_start',
      'did_profile_sent',
    ]) {
      target.sessionStorage?.removeItem(key);
    }
  } catch {}
  target.databuddyOptedOut = true;
  target.databuddyDisabled = true;
}

function loadDatabuddy(target) {
  const existingScript = target.document.getElementById(SCRIPT_ID);
  if (existingScript) return existingScript;

  const script = target.document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = SCRIPT_URL;
  script.dataset.clientId = CLIENT_ID;
  script.crossOrigin = 'anonymous';
  script.async = true;
  script.onload = () => {
    if (target.databuddyConfig.disabled) setDatabuddyOptOut(target);
  };
  script.onerror = () => script.remove();
  target.document.head.appendChild(script);
  return script;
}

export function setDatabuddyMeasurementConsent(enabled, target = globalThis) {
  const wasEnabled = target.databuddyConfig?.disabled === false;
  const disabled = !enabled;
  target.databuddyConfig = {
    ...target.databuddyConfig,
    clientId: CLIENT_ID,
    disabled,
  };

  if (enabled) {
    if (!wasEnabled) {
      clearDatabuddyOptOut(target);
      target.databuddyOptIn?.();
    }
    if (target.databuddy?.options) {
      target.databuddy.options.disabled = false;
    }
    loadDatabuddy(target);
  } else {
    setDatabuddyOptOut(target);
    if (target.databuddy?.options) {
      target.databuddy.options.disabled = true;
    }
  }
}
