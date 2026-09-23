const express = require('express'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const NAME = process.env.COIN_NAME || 'Credit', SYMBOL = process.env.COIN_SYMBOL || 'CRD';
const PRICE_USD = 4;        // 1 credit = $4 (fixed peg)
const DIFFICULTY = 3;       // leading zeros required in block hash
const REWARD = 1;           // credits per mined block
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const blockHash = b => sha(b.index + b.prev + b.time + JSON.stringify(b.txs) + b.nonce);
let db = { chain: [], pending: [], wallets: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch {} };

if (!db.chain.length) {
  const g = { index: 0, prev: '0', time: Date.now(), txs: [], nonce: 0 };
  g.hash = blockHash(g); db.chain.push(g); save();
}

const tx = (from, to, amt) => ({ id: sha(from + to + amt + Date.now() + Math.random()).slice(0, 16), from, to, amt, time: Date.now() });

function balance(addr) {
  let b = 0;
  for (const blk of db.chain) for (const t of blk.txs) { if (t.to === addr) b += t.amt; if (t.from === addr) b -= t.amt; }
  return +b.toFixed(6);
}
const spendable = addr => +(balance(addr) - db.pending.filter(t => t.from === addr).reduce((s, t) => s + t.amt, 0)).toFixed(6);

function addBlock(txs) {
  const prev = db.chain[db.chain.length - 1];
  const b = { index: prev.index + 1, prev: prev.hash, time: Date.now(), txs, nonce: 0 };
  const target = '0'.repeat(DIFFICULTY);
  while (!(b.hash = blockHash(b)).startsWith(target)) b.nonce++;
  db.chain.push(b); save(); return b;
}

const supply = () => +db.chain.reduce((s, b) => s + b.txs.filter(t => t.from === 'MINT').reduce((x, t) => x + t.amt, 0), 0).toFixed(6);
const validAddr = a => typeof a === 'string' && db.wallets[a];
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 1e9 ? +n.toFixed(6) : null; };

app.get('/api/info', (req, res) => {
  const s = supply();
  res.json({ name: NAME, symbol: SYMBOL, priceUsd: PRICE_USD, supply: s, marketCapUsd: +(s * PRICE_USD).toFixed(2),
    height: db.chain.length, pending: db.pending.length, wallets: Object.keys(db.wallets).length, reward: REWARD });
});

app.post('/api/wallet', (req, res) => {
  const address = SYMBOL + crypto.randomBytes(10).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  db.wallets[address] = sha(secret); save();
  res.json({ address, secret }); // secret is shown once; only its hash is stored
});

app.get('/api/balance/:addr', (req, res) => {
  const a = req.params.addr;
  if (!validAddr(a)) return res.status(404).json({ error: 'Wallet not found' });
  const bal = balance(a);
  res.json({ address: a, balance: bal, usd: +(bal * PRICE_USD).toFixed(2) });
});

app.post('/api/send', (req, res) => {
  const { from, secret, to } = req.body || {}, amt = num(req.body && req.body.amount);
  if (!validAddr(from) || db.wallets[from] !== sha(String(secret))) return res.status(401).json({ error: 'Wrong address or secret key' });
  if (!validAddr(to)) return res.status(400).json({ error: 'Recipient wallet not found' });
  if (from === to) return res.status(400).json({ error: 'Choose a different recipient' });
  if (!amt) return res.status(400).json({ error: 'Enter an amount above 0' });
  if (amt > spendable(from)) return res.status(400).json({ error: 'Not enough credits' });
  db.pending.push(tx(from, to, amt)); save();
  res.json({ ok: true, message: 'Sent. It confirms when the next block is mined.' });
});

// Simulated purchase: pay USD, receive USD/4 credits (mints straight into a block).
app.post('/api/buy', (req, res) => {
  const { address } = req.body || {}, usd = num(req.body && req.body.usd);
  if (!validAddr(address)) return res.status(404).json({ error: 'Wallet not found' });
  if (!usd) return res.status(400).json({ error: 'Enter a dollar amount above 0' });
  const credits = +(usd / PRICE_USD).toFixed(6);
  const b = addBlock([...db.pending.splice(0), tx('MINT', address, credits)]);
  res.json({ ok: true, credits, block: b.index });
});

app.post('/api/mine', (req, res) => {
  const { address } = req.body || {};
  if (!validAddr(address)) return res.status(404).json({ error: 'Wallet not found' });
  const b = addBlock([...db.pending.splice(0), tx('MINT', address, REWARD)]);
  res.json({ ok: true, block: b.index, reward: REWARD });
});

app.get('/api/chain', (req, res) => res.json(db.chain.slice(-15).reverse()));

app.get('/api/valid', (req, res) => {
  const t = '0'.repeat(DIFFICULTY);
  const ok = db.chain.every((b, i) => b.hash === blockHash(b) && (i === 0 || (b.prev === db.chain[i - 1].hash && b.hash.startsWith(t))));
  res.json({ valid: ok });
});

app.listen(process.env.PORT || 3000, () => console.log('Running on', process.env.PORT || 3000));
