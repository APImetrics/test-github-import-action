"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { parseBoolean, summarizeDocument } = require("../src/utils");

describe("parseBoolean", () => {
  test("empty string returns default true", () => {
    assert.equal(parseBoolean("", true), true);
  });

  test("empty string returns default false", () => {
    assert.equal(parseBoolean("", false), false);
  });

  const truthyValues = ["true", "1", "yes", "on", "TRUE", "YES", "ON"];
  for (const val of truthyValues) {
    test(`\"${val}\" is truthy`, () => {
      assert.equal(parseBoolean(val, false), true);
    });
  }

  const falsyValues = ["false", "0", "no", "off", "FALSE", "OFF"];
  for (const val of falsyValues) {
    test(`\"${val}\" is falsy`, () => {
      assert.equal(parseBoolean(val, true), false);
    });
  }

  test("unrecognized value is falsy", () => {
    assert.equal(parseBoolean("maybe", false), false);
  });
});

describe("summarizeDocument", () => {
  test("lists top-level keys", () => {
    assert.equal(summarizeDocument({ a: 1, b: 2, c: 3 }), "keys=a,b,c");
  });

  test("empty object produces keys= with empty suffix", () => {
    assert.equal(summarizeDocument({}), "keys=");
  });

  test("returns <non-object> for null", () => {
    assert.equal(summarizeDocument(null), "<non-object>");
  });

  test("returns <non-object> for strings", () => {
    assert.equal(summarizeDocument("oops"), "<non-object>");
  });

  test("returns <non-object> for numbers", () => {
    assert.equal(summarizeDocument(42), "<non-object>");
  });

  test("truncates to 12 keys maximum", () => {
    const obj = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    assert.equal(summarizeDocument(obj).split(",").length, 12);
  });
});