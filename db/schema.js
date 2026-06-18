const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'payments.db');

let db = null;

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, buffer);
}

function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (stmt) {
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    }
    return [];
  } catch (err) {
    console.error(`[DB] Query error: ${sql.substring(0, 60)}...`, err.message);
    return [];
  }
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    saveDb();
  } catch (err) {
    console.error(`[DB] Run error: ${sql.substring(0, 60)}...`, err.message);
    throw err;
  }
}

function get(sql, params = []) {
  const results = query(sql, params);
  return results.length > 0 ? results[0] : undefined;
}

function all(sql, params = []) {
  return query(sql, params);
}

async function initDatabase() {
  const SQL = await initSqlJs();

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      usd_price REAL NOT NULL,
      delivery_type TEXT DEFAULT 'document',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      notes TEXT,
      total_spent_usd REAL DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_id TEXT UNIQUE NOT NULL,
      customer_id TEXT REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      product_id TEXT REFERENCES products(id),
      product_name TEXT NOT NULL,
      description TEXT,
      currency TEXT NOT NULL CHECK(currency IN ('BTC', 'POL', 'SOL')),
      amount REAL NOT NULL,
      amount_usd REAL NOT NULL,
      wallet_address TEXT NOT NULL,
      wallet_label TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'expired', 'cancelled')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      confirmed_txid TEXT,
      receipt_generated INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      invoice_id TEXT REFERENCES invoices(id),
      txid TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      confirmations INTEGER DEFAULT 0,
      from_address TEXT,
      to_address TEXT NOT NULL,
      block_height INTEGER,
      block_hash TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      first_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      confirmed_at INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'failed')),
      UNIQUE(txid, currency)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      invoice_id TEXT REFERENCES invoices(id),
      details TEXT NOT NULL,
      ip_address TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS service_fulfillments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      product_id TEXT REFERENCES products(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      service_data TEXT,
      delivered_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  // Indexes
  try { db.run('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_invoices_currency ON invoices(currency)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions(invoice_id)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_fulfillments_status ON service_fulfillments(status)'); } catch(e) {}

  // Seed products
  const productCount = db.exec('SELECT COUNT(*) as count FROM products');
  const count = productCount.length > 0 && productCount[0].values.length > 0 ? productCount[0].values[0][0] : 0;

  if (count === 0) {
    const seedProducts = [
      ['resume', 'Professional Resume', 'ATS-optimized resume tailored to your target role', 79, 'document'],
      ['cover-letter', 'Tailored Cover Letter', 'Compelling cover letter customized for your target company', 39, 'document'],
      ['linkedin', 'LinkedIn Profile Optimization', 'Complete LinkedIn profile rewrite for recruiter visibility', 49, 'document'],
      ['interview-prep', 'Interview Preparation Guide', 'Customized interview guide with STAR stories and strategy', 59, 'document'],
      ['career-advisory', 'Career Advisory Report', 'Comprehensive career roadmap with skill gap analysis', 49, 'document'],
      ['bundle-basic', 'Basic Bundle', 'Resume + Cover Letter + LinkedIn Optimization', 149, 'bundle'],
      ['bundle-premium', 'Premium Bundle', 'All 5 services: Resume + Cover Letter + LinkedIn + Interview Prep + Career Advisory', 219, 'bundle'],
    ];

    for (const p of seedProducts) {
      db.run('INSERT INTO products (id, name, description, usd_price, delivery_type) VALUES (?, ?, ?, ?, ?)', p);
    }
  }

  saveDb();
  console.log(`[DB] Database initialized at ${DB_PATH}`);
  return { db, query, run, get, all, save: saveDb };
}

let dbInstance = null;

async function getDatabase() {
  if (!dbInstance) {
    dbInstance = await initDatabase();
  }
  return dbInstance;
}

module.exports = { getDatabase, initDatabase };

// Run directly
if (require.main === module) {
  initDatabase().then(() => {
    console.log('Database initialized successfully.');
    process.exit(0);
  }).catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
}