"use strict";

function parseBoolean(value, defaultValue) {
  if (value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function summarizeDocument(document) {
  if (!document || typeof document !== "object") return "<non-object>";
  const topKeys = Object.keys(document).slice(0, 12);
  return `keys=${topKeys.join(",")}`;
}

module.exports = { parseBoolean, summarizeDocument };