'use strict';

// Per-category marker colour, emitted as the ResourceSet `styles.default`.
// Freeboard styles a feature from styles[properties.styleRef] and falls back to
// styles.default, so one default per category colours all of that set's markers.
const CATEGORY_COLORS = {
  distress: 'rgba(211,47,47,1)', // red
  urgency: 'rgba(245,124,0,1)', // orange
  safety: 'rgba(251,192,45,1)', // amber
  routine: 'rgba(117,117,117,1)', // grey
};

const HOUR_MS = 60 * 60 * 1000;

// Should this call appear at `now`? Un-cleared distress is always shown — a
// MAYDAY must not age off the chart. Everything else (and cleared distress)
// must fall within `windowHours` of receipt.
function withinWindow(event, now, windowHours) {
  if (event.category === 'distress' && !event.clearedAt) return true;
  const received = Date.parse(event.receivedAt);
  if (Number.isNaN(received)) return false;
  return now - received <= windowHours * HOUR_MS;
}

function toFeature(event, nameFor) {
  const vesselName = nameFor ? nameFor(event.mmsi) : undefined;
  const properties = {
    name: event.natureOfDistress
      ? `${event.category}: ${event.natureOfDistress}`
      : event.category,
    category: event.category,
    mmsi: event.mmsi,
    utcTime: event.utcTime,
    receivedAt: event.receivedAt,
  };
  if (event.natureOfDistress) properties.natureOfDistress = event.natureOfDistress;
  if (vesselName) properties.vesselName = vesselName;
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [event.position.longitude, event.position.latitude],
    },
    properties,
  };
}

// Turn stored DSC call events into freeboard ResourceSets keyed by category.
// Empty categories are omitted.
function buildMarkerResourceSets(events, { now, windowHours, nameFor } = {}) {
  const buckets = {};
  for (const event of events) {
    if (
      !event.position ||
      typeof event.position.latitude !== 'number' ||
      typeof event.position.longitude !== 'number'
    )
      continue;
    if (!withinWindow(event, now, windowHours)) continue;
    const category = event.category || 'routine';
    (buckets[category] = buckets[category] || []).push(toFeature(event, nameFor));
  }
  const out = {};
  for (const [category, features] of Object.entries(buckets)) {
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.routine;
    out[category] = {
      name: `DSC — ${category}`,
      description: `DSC ${category} calls heard on channel 70`,
      styles: { default: { width: 2, stroke: color, fill: color } },
      values: { type: 'FeatureCollection', features },
    };
  }
  return out;
}

module.exports = { buildMarkerResourceSets, CATEGORY_COLORS };
