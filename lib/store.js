'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * Append-only JSONL store for received DSC calls. DSC traffic is rare (a busy
 * day in range of a coast station might see dozens of calls), so synchronous
 * I/O and full-file compaction are entirely adequate — and the simplest thing
 * that survives a power cut mid-write (a torn last line is skipped on load).
 */
class EventStore {
  constructor({ filePath, maxEvents = 1000 }) {
    this.filePath = filePath;
    this.maxEvents = maxEvents;
    this.events = [];
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no log yet
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.events.push(JSON.parse(line));
      } catch {
        // torn/corrupt line — skip it, keep the rest
      }
    }
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
      this._compact();
    }
  }

  _compact() {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, this.filePath);
  }

  add(event) {
    if (!event.id) {
      event.id = `${event.receivedAt || new Date().toISOString()}-${event.mmsi || 'unknown'}`;
    }
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
      this._compact();
    } else {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n');
    }
    return event;
  }

  update(id, patch) {
    const event = this.get(id);
    if (!event) return undefined;
    Object.assign(event, patch);
    this._compact();
    return event;
  }

  list() {
    return this.events;
  }

  get(id) {
    return this.events.find((e) => e.id === id);
  }

  /** Newest event matching `predicate` received within `windowMs` of `nowMs`. */
  findRecent(predicate, nowMs, windowMs) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const age = nowMs - Date.parse(e.receivedAt);
      if (age > windowMs) return undefined;
      if (age >= 0 && predicate(e)) return e;
    }
    return undefined;
  }
}

module.exports = { EventStore };
