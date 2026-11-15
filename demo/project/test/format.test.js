const test = require('node:test');
const assert = require('node:assert');
const { fmt } = require('../src/format');
test('两位小数与千分位', () => assert.strictEqual(fmt(12889.6), '12,889.60'));
