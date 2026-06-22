'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const makePlugin = require('../index');

const DISTRESS = '$CDDSC,12,3380400790,12,05,00,1423108312,2019,,,S,E*69';
const DSE = '$CDDSE,1,1,A,3380400790,00,45894494*1B';

function sentenceInput(sentence) {
  return {
    id: sentence.substring(3, 6),
    sentence,
    parts: sentence.split('*')[0].split(',').slice(1),
    // Recent timestamp: the re-raise-after-restart logic only considers
    // events fresher than its window.
    tags: { source: 'test.0', timestamp: new Date().toISOString() },
  };
}

function mockApp() {
  const app = new EventEmitter();
  app.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-plugin-'));
  app.getDataDirPath = () => app.dataDir;
  app.getSelfPath = (p) => (p === 'mmsi' ? '368000001' : undefined);
  app.deltas = [];
  app.handleMessage = (id, delta) => app.deltas.push({ id, delta });
  app.parsers = {};
  app.emitPropertyValue = (name, value) => {
    if (name === 'nmea0183sentenceParser') app.parsers[value.sentence] = value.parser;
  };
  app.resourceProviders = {};
  app.registerResourceProvider = (provider) => {
    app.resourceProviders[provider.type] = provider;
  };
  app.error = () => {};
  app.debug = () => {};
  app.setPluginStatus = () => {};
  app.putHandlers = {};
  app.registerPutHandler = (context, path, cb) => {
    app.putHandlers[`${context}:${path}`] = cb;
  };
  return app;
}

// Tiny logbook stand-in: resolves `received` with the captured request.
function logbookServer() {
  let resolve;
  const received = new Promise((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      resolve({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200).end();
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, received, port: server.address().port }))
  );
}

function start(app, options = {}) {
  const plugin = makePlugin(app);
  plugin.start({ logbookToken: '', ...options });
  return plugin;
}

test('start registers DSC + DSE parsers and the dsc-calls resource provider', () => {
  const app = mockApp();
  const plugin = start(app);
  assert.ok(app.parsers.DSC);
  assert.ok(app.parsers.DSE);
  assert.ok(app.resourceProviders['dsc-calls']);
  plugin.stop();
});

test('a distress alert is stored, alarmed under self, and visible as a resource', async () => {
  const app = mockApp();
  const plugin = start(app);

  const delta = app.parsers.DSC(sentenceInput(DISTRESS));

  // A vessel in distress is a Search-and-Rescue target: chartplotters render
  // the `sar.` context as a distress marker, not an ordinary AIS vessel.
  assert.equal(delta.context, 'sar.urn:mrn:imo:mmsi:338040079');
  const remotePaths = delta.updates[0].values.map((v) => v.path);
  assert.ok(remotePaths.includes('navigation.position'));

  // Self-context notification so the vessel's own alarm chain fires.
  assert.equal(app.deltas.length, 1);
  const notif = app.deltas[0].delta.updates[0].values[0];
  assert.equal(notif.path, 'notifications.dsc.distress');
  assert.equal(notif.value.state, 'emergency');
  assert.match(notif.value.message, /sinking/);
  // Spoken line: never an MMSI (TTS reads it as a huge number).
  assert.doesNotMatch(notif.value.message, /338040079/);

  // Stored and served.
  const resources = await app.resourceProviders['dsc-calls'].methods.listResources();
  const events = Object.values(resources);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'distress');
  assert.equal(events[0].source, 'nmea0183');
  assert.equal(events[0].raw, DISTRESS);
  plugin.stop();
});

test('a non-distress caller keeps the ordinary vessels context', () => {
  const app = mockApp();
  const plugin = start(app);

  // Routine individual call carrying a ship-position telecommand (tc 21):
  // it has a position to plot, but it is not distress, so it stays a normal
  // AIS vessel rather than a SaR target.
  const ROUTINE = '$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B';
  const delta = app.parsers.DSC(sentenceInput(ROUTINE));

  assert.equal(delta.context, 'vessels.urn:mrn:imo:mmsi:338158137');
  assert.ok(delta.updates[0].values.map((v) => v.path).includes('navigation.position'));
  plugin.stop();
});

test('a following DSE refines the stored position', async () => {
  const app = mockApp();
  const plugin = start(app);

  app.parsers.DSC(sentenceInput(DISTRESS));
  const delta = app.parsers.DSE(sentenceInput(DSE));

  // DSE refines the position of the matched distress call, so it follows the
  // same SaR context the distress alert was emitted under.
  assert.equal(delta.context, 'sar.urn:mrn:imo:mmsi:338040079');
  const refined = delta.updates[0].values[0].value;
  assert.ok(Math.abs(refined.latitude - (42 + 31.4589 / 60)) < 1e-9);

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events[0].positionResolution, 'enhanced');
  assert.ok(Math.abs(events[0].position.latitude - (42 + 31.4589 / 60)) < 1e-9);
  plugin.stop();
});

test('repeated distress re-transmissions are deduped, not re-alarmed', async () => {
  const app = mockApp();
  const plugin = start(app);

  app.parsers.DSC(sentenceInput(DISTRESS));
  app.parsers.DSC(sentenceInput(DISTRESS));

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(events[0].repeats, 1);
  assert.equal(app.deltas.length, 1); // only the first alarm
  plugin.stop();
});

test('PGN 129808 urgency call is stored and raises an alarm-state notification', async () => {
  const app = mockApp();
  const plugin = start(app);

  app.emit('N2KAnalyzerOut', {
    pgn: 129808,
    fields: {
      dscFormat: 'All ships',
      dscCategory: 'Urgency',
      dscMessageAddress: 366999707,
      latitudeOfVesselReported: 48.76,
      longitudeOfVesselReported: -123.23,
    },
  });
  app.emit('N2KAnalyzerOut', { pgn: 129038, fields: {} }); // unrelated PGN ignored

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'n2k');
  const notif = app.deltas[0].delta.updates[0].values[0];
  assert.equal(notif.path, 'notifications.dsc.urgency');
  assert.equal(notif.value.state, 'alarm');
  plugin.stop();
});

test('routine calls are stored but never notify', async () => {
  const app = mockApp();
  const plugin = start(app);

  app.parsers.DSC(sentenceInput('$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B'));

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(app.deltas.length, 0);
  plugin.stop();
});

test('distress writes a ship\'s-log entry via the logbook API', async () => {
  const { server, received, port } = await logbookServer();
  const app = mockApp();
  const plugin = start(app, {
    logbookUrl: `http://127.0.0.1:${port}/plugins/signalk-logbook/logs`,
    logbookToken: 'test-token',
  });

  app.parsers.DSC(sentenceInput(DISTRESS));

  const req = await received;
  assert.equal(req.headers.authorization, 'Bearer test-token');
  assert.match(req.headers.cookie, /JAUTHENTICATION=test-token/);
  assert.match(req.body.text, /\[DSC\] DISTRESS/);
  assert.match(req.body.text, /338040079/);
  server.close();
  plugin.stop();
});

test('no logbook write without a token, and none for routine calls', async () => {
  const { server, received, port } = await logbookServer();
  const app = mockApp();

  // No token → distress still stored, no HTTP call.
  const plugin = start(app, { logbookUrl: `http://127.0.0.1:${port}/x`, logbookToken: '' });
  app.parsers.DSC(sentenceInput(DISTRESS));
  plugin.stop();

  // Token set but routine call → no HTTP call either.
  const app2 = mockApp();
  const plugin2 = start(app2, { logbookUrl: `http://127.0.0.1:${port}/x`, logbookToken: 't' });
  app2.parsers.DSC(sentenceInput('$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B'));
  plugin2.stop();

  const winner = await Promise.race([
    received.then(() => 'request'),
    new Promise((r) => setTimeout(() => r('silence'), 150)),
  ]);
  assert.equal(winner, 'silence');
  server.close();
});

test('stop() detaches: parsers return null and N2K events are ignored', async () => {
  const app = mockApp();
  const plugin = start(app);
  plugin.stop();

  assert.equal(app.parsers.DSC(sentenceInput(DISTRESS)), null);
  app.emit('N2KAnalyzerOut', { pgn: 129808, fields: { dscCategory: 'Distress', dscMessageAddress: 1 } });
  assert.equal(app.deltas.length, 0);
});

test('events reload from disk after a plugin restart', async () => {
  const app = mockApp();
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  plugin.stop();

  const plugin2 = makePlugin(app);
  plugin2.start({});
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  plugin2.stop();
});

test('a fresh distress alarm is re-raised after a restart', async () => {
  const app = mockApp();
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  plugin.stop();
  assert.equal(app.deltas.length, 1);

  const plugin2 = makePlugin(app);
  plugin2.start({ reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(app.deltas.length, 2); // re-raised on start
  const notif = app.deltas[1].delta.updates[0].values[0];
  assert.equal(notif.path, 'notifications.dsc.distress');
  assert.equal(notif.value.state, 'emergency');
  plugin2.stop();
});

test('a stale alert is not re-raised after a restart', async () => {
  const app = mockApp();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(app.dataDir, 'dsc-calls.jsonl'),
    JSON.stringify({
      id: `${old}-338040079`,
      receivedAt: old,
      category: 'distress',
      mmsi: '338040079',
      natureOfDistress: 'sinking',
    }) + '\n'
  );
  const plugin = start(app, { reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(app.deltas.length, 0);
  plugin.stop();
});

test('voice message includes range and direction when own position is known', () => {
  const app = mockApp();
  app.getSelfPath = (p) => {
    if (p === 'mmsi') return '368000001';
    if (p === 'navigation.position') return { value: { latitude: 42.4, longitude: -83.1 } };
    return undefined;
  };
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  const msg = app.deltas[0].delta.updates[0].values[0].value.message;
  assert.match(msg, /nautical miles (north|south|east|west)/);
  assert.doesNotMatch(msg, /°/); // compact voice line, no raw coordinates
  plugin.stop();
});

test('malformed DSC sentences never throw out of the parser', () => {
  const app = mockApp();
  const plugin = start(app);
  assert.equal(app.parsers.DSC({ sentence: '$CDDSC', parts: [], tags: {} }), null);
  assert.equal(app.parsers.DSE({ sentence: '$CDDSE', parts: ['1'], tags: {} }), null);
  plugin.stop();
});

function selfStateApp(state) {
  const app = mockApp();
  app.getSelfPath = (p) => (p === 'mmsi' ? '368000001' : state[p]);
  return app;
}

test('stored events carry an ownShip snapshot of current vessel state', async () => {
  const app = selfStateApp({
    'navigation.position': { value: { latitude: 48.76, longitude: -123.05 } },
    'navigation.speedOverGround': 3.1,
    'environment.water.swell.state': 3,
  });
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.deepEqual(events[0].ownShip.position, { latitude: 48.76, longitude: -123.05 });
  assert.equal(events[0].ownShip.sog, 3.1);
  assert.equal(events[0].ownShip.seaState, 3);
  assert.equal(events[0].ownShip.visibility, undefined); // nothing fabricated
  plugin.stop();
});

test('no vessel state → no ownShip block at all', async () => {
  const app = mockApp();
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal('ownShip' in events[0], false);
  plugin.stop();
});

test('dedupe repeats do not refresh the snapshot', async () => {
  const state = { 'navigation.speedOverGround': 3.1 };
  const app = selfStateApp(state);
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  state['navigation.speedOverGround'] = 9.9;
  app.parsers.DSC(sentenceInput(DISTRESS)); // re-transmission, deduped
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(events[0].ownShip.sog, 3.1);
  plugin.stop();
});

test('snapshotPaths config adds fields to the snapshot', async () => {
  const app = selfStateApp({ 'environment.depth.belowTransducer': 12.2 });
  const plugin = start(app, {
    snapshotPaths: [{ field: 'depth', path: 'environment.depth.belowTransducer' }],
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events[0].ownShip.depth, 12.2);
  plugin.stop();
});

test('logbook entry carries vhf 70 and observations from the snapshot', async () => {
  const { server, received, port } = await logbookServer();
  const app = selfStateApp({
    'environment.water.swell.state': 3,
    'environment.outside.visibility': 1500, // meters → fog scale 4
  });
  const plugin = start(app, {
    logbookUrl: `http://127.0.0.1:${port}/plugins/signalk-logbook/logs`,
    logbookToken: 'test-token',
  });
  app.parsers.DSC(sentenceInput(DISTRESS));

  const req = await received;
  assert.equal(req.body.category, 'radio');
  assert.equal(req.body.vhf, '70');
  assert.deepEqual(req.body.observations, { seaState: 3, visibility: 4 });
  server.close();
  plugin.stop();
});

test('a cleared alert is not re-raised after a restart', async () => {
  const app = mockApp();
  const fresh = new Date().toISOString();
  fs.writeFileSync(
    path.join(app.dataDir, 'dsc-calls.jsonl'),
    JSON.stringify({
      id: `${fresh}-338040079`,
      receivedAt: fresh,
      category: 'distress',
      mmsi: '338040079',
      natureOfDistress: 'sinking',
      clearedAt: fresh, // operator cleared it
    }) + '\n'
  );
  const plugin = makePlugin(app);
  plugin.start({ reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(app.deltas.length, 0); // fresh, but cleared → no re-raise
  plugin.stop();
});

test('no observations key on the logbook entry when nothing is observed', async () => {
  const { server, received, port } = await logbookServer();
  const app = mockApp();
  const plugin = start(app, {
    logbookUrl: `http://127.0.0.1:${port}/plugins/signalk-logbook/logs`,
    logbookToken: 'test-token',
  });
  app.parsers.DSC(sentenceInput(DISTRESS));

  const req = await received;
  assert.equal(req.body.vhf, '70');
  assert.equal('observations' in req.body, false);
  server.close();
  plugin.stop();
});

test('start registers PUT clear handlers for the three notifying categories', () => {
  const app = mockApp();
  const plugin = start(app);
  for (const cat of ['distress', 'urgency', 'safety']) {
    assert.ok(
      app.putHandlers[`vessels.self:notifications.dsc.${cat}`],
      `missing PUT handler for ${cat}`
    );
  }
  plugin.stop();
});

test('a PUT clears the live alarm and stamps clearedAt on stored events', async () => {
  const app = mockApp();
  const plugin = start(app);

  // Raise a distress alarm.
  app.parsers.DSC(sentenceInput(DISTRESS));
  assert.equal(app.deltas.length, 1);

  // Operator clears it.
  const handler = app.putHandlers['vessels.self:notifications.dsc.distress'];
  const result = handler('vessels.self', 'notifications.dsc.distress', null, () => {});
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.statusCode, 200);

  // Live alarm cleared from the plugin's own source (null value).
  const clearDelta = app.deltas[app.deltas.length - 1].delta.updates[0].values[0];
  assert.equal(clearDelta.path, 'notifications.dsc.distress');
  assert.equal(clearDelta.value, null);

  // Stored event stamped so a restart won't resurrect it.
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.ok(events[0].clearedAt);
});

test('after a clear: a re-transmit stays silent but a new vessel re-alarms', async () => {
  const app = mockApp();
  const plugin = start(app);

  app.parsers.DSC(sentenceInput(DISTRESS)); // raises
  assert.equal(app.deltas.length, 1);

  // Operator clears it (emits the null-clear delta + stamps clearedAt).
  app.putHandlers['vessels.self:notifications.dsc.distress'](
    'vessels.self', 'notifications.dsc.distress', null, () => {}
  );
  const afterClear = app.deltas.length; // includes the clear delta

  // Same call re-transmits within the dedupe window → stays silent.
  app.parsers.DSC(sentenceInput(DISTRESS));
  assert.equal(app.deltas.length, afterClear);

  // A different vessel's distress must still alarm.
  app.parsers.DSC(sentenceInput('$CDDSC,12,3165557770,12,05,00,1423108312,2019,,,S,E*00'));
  const last = app.deltas[app.deltas.length - 1].delta.updates[0].values[0];
  assert.ok(app.deltas.length > afterClear, 'new vessel distress should re-alarm');
  assert.equal(last.path, 'notifications.dsc.distress');
  assert.equal(last.value.state, 'emergency');

  plugin.stop();
});
