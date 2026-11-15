const round2 = (n) => Math.round(n * 100) / 100;
function quote(amount, rate, discount) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须是正数');
  const net = round2(amount * (1 - discount));
  const tax = round2(net * rate);
  return { net, tax, total: round2(net + tax) };
}
module.exports = { quote, round2 };
