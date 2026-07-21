import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setDatabuddyMeasurementConsent } from './databuddy-consent.js';

const CLIENT_ID = '0f7c1b34-a28d-495f-9bd3-d6770e518c56';

function createTarget() {
  const scripts = [];
  const document = {
    createElement(tagName) {
      assert.equal(tagName, 'script');
      const script = { dataset: {} };
      script.remove = () => {
        const index = scripts.indexOf(script);
        if (index !== -1) scripts.splice(index, 1);
      };
      return script;
    },
    getElementById(id) {
      return scripts.find(script => script.id === id) ?? null;
    },
    head: {
      appendChild(script) {
        scripts.push(script);
      },
    },
  };

  return { target: { document }, scripts };
}

describe('Databuddy consent', () => {
  it('does not load Databuddy without measurement consent', () => {
    const { target, scripts } = createTarget();

    setDatabuddyMeasurementConsent(false, target);

    assert.deepEqual(target.databuddyConfig, {
      clientId: CLIENT_ID,
      disabled: true,
    });
    assert.equal(scripts.length, 0);
  });

  it('loads Databuddy after measurement consent is granted', () => {
    const { target, scripts } = createTarget();

    setDatabuddyMeasurementConsent(true, target);

    assert.equal(target.databuddyConfig.disabled, false);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, 'https://cdn.databuddy.cc/databuddy.js');
    assert.equal(scripts[0].dataset.clientId, CLIENT_ID);
    assert.equal(scripts[0].crossOrigin, 'anonymous');
    assert.equal(scripts[0].async, true);
  });

  it('disables the loaded tracker when consent is revoked', () => {
    const { target } = createTarget();

    setDatabuddyMeasurementConsent(true, target);
    target.databuddy = { options: { disabled: false } };
    setDatabuddyMeasurementConsent(false, target);

    assert.equal(target.databuddyConfig.disabled, true);
    assert.equal(target.databuddy.options.disabled, true);
  });

  it('resumes the loaded tracker without adding handlers', () => {
    const { target, scripts } = createTarget();
    let cleared = 0;
    let optedOut = 0;
    let optedIn = 0;
    let screenViews = 0;
    let flushes = 0;

    setDatabuddyMeasurementConsent(true, target);
    target.databuddy = {
      lastPath: '',
      options: { clientId: CLIENT_ID, disabled: false },
      clear() {
        cleared += 1;
        this.lastPath = '';
      },
      screenView() {
        if (this.lastPath === 'current') return;
        this.lastPath = 'current';
        if (!this.options.disabled) screenViews += 1;
      },
      flush() { flushes += 1; },
    };
    target.databuddyOptOut = () => { optedOut += 1; };
    target.databuddyOptIn = () => { optedIn += 1; };

    setDatabuddyMeasurementConsent(false, target);
    target.databuddy.screenView();
    setDatabuddyMeasurementConsent(true, target);

    assert.equal(optedOut, 1);
    assert.equal(optedIn, 0);
    assert.equal(cleared, 1);
    assert.equal(screenViews, 1);
    assert.equal(flushes, 1);
    assert.equal(target.databuddy.options.disabled, false);
    assert.equal(scripts.length, 1);
  });

  it('opts out if consent is revoked while the script loads', () => {
    const { target, scripts } = createTarget();
    let optedOut = 0;

    setDatabuddyMeasurementConsent(true, target);
    setDatabuddyMeasurementConsent(false, target);
    target.databuddyOptOut = () => { optedOut += 1; };
    scripts[0].onload();

    assert.equal(optedOut, 1);
  });

  it('reinitializes a disabled stub after consent returns', () => {
    const { target, scripts } = createTarget();

    setDatabuddyMeasurementConsent(true, target);
    setDatabuddyMeasurementConsent(false, target);
    target.databuddy = { options: { clientId: '', disabled: true } };
    target.databuddyOptOut = () => {};
    target.databuddyOptIn = () => {
      if (target.databuddy.options.disabled) {
        target.databuddy = { options: { disabled: false }, reinitialized: true };
      }
    };
    scripts[0].onload();

    setDatabuddyMeasurementConsent(true, target);

    assert.equal(target.databuddy.reinitialized, true);
  });

  it('clears stored IDs when measurement is rejected after a reload', () => {
    const { target, scripts } = createTarget();
    const local = new Map([['did', 'anon-id']]);
    const session = new Map([['did_session', 'session-id']]);
    target.localStorage = {
      removeItem(key) { local.delete(key); },
      setItem(key, value) { local.set(key, value); },
    };
    target.sessionStorage = {
      removeItem(key) { session.delete(key); },
    };

    setDatabuddyMeasurementConsent(false, target);

    assert.equal(local.get('databuddy_opt_out'), 'true');
    assert.equal(local.get('databuddy_disabled'), 'true');
    assert.equal(local.has('did'), false);
    assert.equal(session.has('did_session'), false);
    assert.equal(target.databuddyOptedOut, true);
    assert.equal(target.databuddyDisabled, true);
    assert.equal(scripts.length, 0);
  });

  it('continues clearing IDs when opt-out storage fails', () => {
    const { target } = createTarget();
    const local = new Map([['did', 'anon-id']]);
    const session = new Map([['did_session', 'session-id']]);
    target.localStorage = {
      setItem() { throw new Error('storage denied'); },
      removeItem(key) { local.delete(key); },
    };
    target.sessionStorage = {
      removeItem(key) { session.delete(key); },
    };

    setDatabuddyMeasurementConsent(false, target);

    assert.equal(local.has('did'), false);
    assert.equal(session.has('did_session'), false);
  });

  it('clears a persisted opt-out before loading after a reload', () => {
    const { target, scripts } = createTarget();
    const storage = new Map([
      ['databuddy_opt_out', 'true'],
      ['databuddy_disabled', 'true'],
    ]);
    target.localStorage = {
      removeItem(key) { storage.delete(key); },
    };

    setDatabuddyMeasurementConsent(true, target);

    assert.equal(storage.size, 0);
    assert.equal(target.databuddyOptedOut, false);
    assert.equal(target.databuddyDisabled, false);
    assert.equal(scripts.length, 1);
  });

  it('retries after a script load error', () => {
    const { target, scripts } = createTarget();

    setDatabuddyMeasurementConsent(true, target);
    scripts[0].onerror();
    setDatabuddyMeasurementConsent(true, target);

    assert.equal(scripts.length, 1);
  });
});
