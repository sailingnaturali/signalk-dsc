'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const makePlugin = require('../index');

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

function start(app, options = {}) {
  const plugin = makePlugin(app);
  plugin.start({ logbookToken: '', ...options });
  return plugin;
}

module.exports = { mockApp, start };
