const test = require('node:test');
const assert = require('node:assert');
const { quote } = require('../src/quote');
test('常规报价：含税合计', () => assert.deepStrictEqual(quote(12800, 0.06, 0.05), { net: 12160, tax: 729.6, total: 12889.6 }));
test('零折扣不改变金额', () => assert.strictEqual(quote(1000, 0.06, 0).net, 1000));
test('非法金额要抛错', () => assert.throws(() => quote(-1, 0.06, 0), /正数/));
