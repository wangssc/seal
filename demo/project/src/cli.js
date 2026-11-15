const { quote } = require('./quote');
const { fmt } = require('./format');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

try {
  const amount = Number(arg('amount', 10000));
  const rate = Number(arg('rate', 0.06));
  const discount = Number(arg('discount', 0));
  const r = quote(amount, rate, discount);
  console.log('未税 ' + fmt(r.net) + '  税额 ' + fmt(r.tax) + '  合计 ' + fmt(r.total));
} catch (e) {
  console.error('参数错误：' + e.message);
  process.exit(2);
}
