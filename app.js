require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('./db/schema');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let DB;

// Initialize database
getDatabase().then(dbi => {
  DB = dbi;
  console.log('[APP] Database ready');
}).catch(err => {
  console.error('[APP] Failed to initialize database:', err.message);
  process.exit(1);
});

// ─── HELPER FUNCTIONS ────────────────────────

function getCryptoRates() {
  return { BTC: 68000, POL: 0.52, SOL: 145 };
}

function roundCrypto(amount, currency) {
  switch (currency) {
    case 'BTC': return parseFloat(amount.toFixed(8));
    case 'POL': return parseFloat(amount.toFixed(6));
    case 'SOL': return parseFloat(amount.toFixed(4));
    default: return parseFloat(amount.toFixed(6));
  }
}

function getQRData(currency, address, amount) {
  switch (currency) {
    case 'BTC': return `bitcoin:${address}?amount=${amount}`;
    case 'POL': return `ethereum:${address}?value=${amount}`;
    case 'SOL': return `solana:${address}`;
    default: return address;
  }
}

// ─── MIDDLEWARE: ensure DB is ready ────────────

app.use('/api', (req, res, next) => {
  if (!DB) {
    return res.status(503).json({ success: false, error: 'Database not ready. Try again in a moment.' });
  }
  next();
});

// ─── CUSTOMER PORTAL API ─────────────────────

// Get available products
app.get('/api/products', (req, res) => {
  try {
    const products = DB.all('SELECT * FROM products WHERE active = 1');
    const rates = getCryptoRates();

    const enriched = products.map(p => ({
      ...p,
      crypto_prices: {
        BTC: parseFloat((p.usd_price / rates.BTC).toFixed(8)),
        POL: parseFloat((p.usd_price / rates.POL).toFixed(6)),
        SOL: parseFloat((p.usd_price / rates.SOL).toFixed(4)),
      }
    }));

    res.json({ success: true, products: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create payment request / invoice
app.post('/api/invoices', (req, res) => {
  try {
    const { customer_name, customer_email, product_id, currency, notes } = req.body;

    if (!customer_name || !customer_email || !product_id || !currency) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customer_name, customer_email, product_id, currency'
      });
    }

    if (!['BTC', 'POL', 'SOL'].includes(currency)) {
      return res.status(400).json({ success: false, error: 'Invalid currency. Must be BTC, POL, or SOL' });
    }

    // Load wallet config
    const walletConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'wallets.json'), 'utf8'));
    const config = walletConfig.wallets[currency];

    if (!config) {
      return res.status(500).json({ success: false, error: `No wallet configured for ${currency}` });
    }

    // Get product
    const products = DB.all('SELECT * FROM products WHERE id = ? AND active = 1', [product_id]);
    if (products.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    const product = products[0];

    // Calculate crypto amount
    const rates = getCryptoRates();
    const amount = product.usd_price / rates[currency];
    const roundedAmount = roundCrypto(amount, currency);

    // Generate invoice
    const invoiceId = 'RT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const expiresAt = Math.floor(Date.now() / 1000) + (walletConfig.invoiceExpiryMinutes || 60) * 60;
    const invoiceIdDb = uuidv4();

    // Get or create customer
    const existingCustomers = DB.all('SELECT * FROM customers WHERE email = ?', [customer_email]);
    let customer;
    if (existingCustomers.length === 0) {
      const customerId = uuidv4();
      DB.run('INSERT INTO customers (id, name, email, notes) VALUES (?, ?, ?, ?)',
        [customerId, customer_name, customer_email, notes || '']);
      customer = { id: customerId, name: customer_name, email: customer_email };
    } else {
      customer = existingCustomers[0];
      DB.run('UPDATE customers SET name = ?, updated_at = strftime("%s","now") WHERE id = ?',
        [customer_name, customer.id]);
    }

    DB.run(`INSERT INTO invoices (id, invoice_id, customer_id, customer_name, customer_email, product_id, product_name, description, currency, amount, amount_usd, wallet_address, wallet_label, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceIdDb, invoiceId, customer.id, customer_name, customer_email,
        product.id, product.name, product.description, currency, roundedAmount, product.usd_price,
        config.address, config.label, expiresAt]);

    // Audit log
    DB.run('INSERT INTO audit_log (id, event_type, invoice_id, details) VALUES (?, ?, ?, ?)',
      [uuidv4(), 'invoice_created', invoiceIdDb,
        JSON.stringify({ customer: customer_name, product: product.name, currency, amount: roundedAmount })]);

    res.json({
      success: true,
      invoice: {
        invoice_id: invoiceId,
        customer_name,
        customer_email,
        product: product.name,
        currency,
        amount: roundedAmount,
        amount_usd: product.usd_price,
        wallet_address: config.address,
        wallet_label: config.label,
        expires_at: expiresAt,
        status: 'pending',
        qr_data: getQRData(currency, config.address, roundedAmount)
      }
    });

  } catch (err) {
    console.error('[INVOICE] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check invoice status
app.get('/api/invoices/:invoiceId', (req, res) => {
  try {
    const invoices = DB.all('SELECT * FROM invoices WHERE invoice_id = ?', [req.params.invoiceId]);
    if (invoices.length === 0) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }
    const invoice = invoices[0];

    // Check expiry
    if (invoice.status === 'pending' && Math.floor(Date.now() / 1000) > invoice.expires_at) {
      DB.run('UPDATE invoices SET status = "expired" WHERE id = ?', [invoice.id]);
      invoice.status = 'expired';
    }

    let transaction = null;
    if (invoice.confirmed_txid) {
      const txns = DB.all('SELECT * FROM transactions WHERE txid = ?', [invoice.confirmed_txid]);
      if (txns.length > 0) transaction = txns[0];
    }

    res.json({
      success: true,
      invoice: {
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        currency: invoice.currency,
        amount: invoice.amount,
        amount_usd: invoice.amount_usd,
        wallet_address: invoice.wallet_address,
        created_at: invoice.created_at,
        expires_at: invoice.expires_at,
        confirmed_at: invoice.confirmed_at,
        confirmed_txid: invoice.confirmed_txid,
      },
      transaction
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN DASHBOARD API ─────────────────────

app.get('/api/admin/stats', (req, res) => {
  try {
    const revenue = DB.all(`
      SELECT currency, COALESCE(SUM(amount_usd), 0) as total_usd, COUNT(*) as count
      FROM invoices WHERE status = 'confirmed'
      GROUP BY currency
    `);

    const revenueByCurrency = {};
    let totalRevenueUsd = 0;
    revenue.forEach(r => {
      revenueByCurrency[r.currency] = { total_usd: r.total_usd, count: r.count };
      totalRevenueUsd += r.total_usd;
    });

    const invCounts = DB.all(`SELECT status, COUNT(*) as count FROM invoices GROUP BY status`);
    let totalInvoices = 0, pendingInvoices = 0, confirmedInvoices = 0;
    invCounts.forEach(r => {
      totalInvoices += r.count;
      if (r.status === 'pending') pendingInvoices = r.count;
      if (r.status === 'confirmed') confirmedInvoices = r.count;
    });

    const customerCount = DB.all('SELECT COUNT(*) as count FROM customers');
    const totalCustomers = customerCount.length > 0 ? customerCount[0].count : 0;

    const recentTransactions = DB.all(`
      SELECT i.invoice_id, i.customer_name, i.currency, i.amount, i.amount_usd, i.confirmed_at, i.confirmed_txid
      FROM invoices i WHERE i.status = 'confirmed'
      ORDER BY i.confirmed_at DESC LIMIT 20
    `);

    res.json({
      success: true,
      stats: {
        total_revenue_usd: totalRevenueUsd,
        revenue_by_currency: revenueByCurrency,
        total_invoices: totalInvoices,
        pending_invoices: pendingInvoices,
        confirmed_invoices: confirmedInvoices,
        total_customers: totalCustomers,
        recent_transactions: recentTransactions
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/invoices', (req, res) => {
  try {
    const status = req.query.status;
    let sql = `
      SELECT i.*, t.txid, t.confirmations, t.block_height
      FROM invoices i
      LEFT JOIN transactions t ON i.confirmed_txid = t.txid
    `;
    const params = [];
    if (status && ['pending', 'confirmed', 'expired', 'cancelled'].includes(status)) {
      sql += ` WHERE i.status = ?`;
      params.push(status);
    }
    sql += ' ORDER BY i.created_at DESC LIMIT 100';

    const invoices = DB.all(sql, params);
    res.json({ success: true, invoices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/transactions', (req, res) => {
  try {
    const transactions = DB.all(`
      SELECT t.*, i.invoice_id, i.customer_name, i.product_name
      FROM transactions t
      JOIN invoices i ON t.invoice_id = i.id
      ORDER BY t.timestamp DESC LIMIT 100
    `);
    res.json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/export', (req, res) => {
  try {
    const confirmed = DB.all(`
      SELECT invoice_id, customer_name, customer_email, product_name, currency, amount, amount_usd,
             confirmed_at, confirmed_txid
      FROM invoices WHERE status = 'confirmed'
      ORDER BY confirmed_at DESC
    `);

    let csv = 'Invoice ID,Customer,Email,Product,Currency,Amount,Amount USD,Confirmed At,TXID\n';
    confirmed.forEach(r => {
      const date = r.confirmed_at ? new Date(r.confirmed_at * 1000).toISOString() : '';
      csv += `"${r.invoice_id}","${r.customer_name}","${r.customer_email}","${r.product_name}","${r.currency}",${r.amount},${r.amount_usd},"${date}","${r.confirmed_txid || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=resumetitan-payments.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/audit', (req, res) => {
  try {
    const logs = DB.all(`
      SELECT a.*, i.invoice_id as ref_invoice
      FROM audit_log a
      LEFT JOIN invoices i ON a.invoice_id = i.id
      ORDER BY a.created_at DESC LIMIT 100
    `);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SERVER START ────────────────────────────

// Wait for DB then start
getDatabase().then(dbi => {
  DB = dbi;

  app.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════════╗`);
    console.log(`║     ResumeTitan AI — Crypto Payment      ║`);
    console.log(`║============================================║`);
    console.log(`║  Server:     http://localhost:${PORT}         ║`);
    console.log(`║  Portal:     http://localhost:${PORT}/        ║`);
    console.log(`║  Dashboard:  http://localhost:${PORT}/dashboard.html ║`);
    console.log(`║  Sentinal:   node services/sentinel.js    ║`);
    console.log(`╚═══════════════════════════════════════════╝\n`);
  });
}).catch(err => {
  console.error('[APP] Failed to start:', err.message);
  process.exit(1);
});