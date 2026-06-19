require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../db/schema');

// Load wallet config
const walletConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'wallets.json'), 'utf8')
);

const CHECK_INTERVAL = parseInt(process.env.SENTINEL_INTERVAL) || 60;
let DB = null;

function getCachedRates() {
  return { BTC: 68000, POL: 0.52, SOL: 145 };
}

function logAudit(eventType, invoiceId, details) {
  DB.run('INSERT INTO audit_log (id, event_type, invoice_id, details) VALUES (?, ?, ?, ?)',
    [uuidv4(), eventType, invoiceId || null, JSON.stringify(details)]);
}

function confirmPayment(invoiceId, txid, currency) {
  const invoices = DB.all('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (invoices.length === 0) return;
  const invoice = invoices[0];
  if (invoice.status !== 'pending') return;

  const now = Math.floor(Date.now() / 1000);

  DB.run('UPDATE invoices SET status = "confirmed", confirmed_at = ?, confirmed_txid = ? WHERE id = ?',
    [now, txid, invoiceId]);
  DB.run('UPDATE transactions SET status = "confirmed", confirmed_at = ? WHERE txid = ? AND currency = ?',
    [now, txid, currency]);

  DB.run('UPDATE customers SET total_spent_usd = total_spent_usd + ?, total_orders = total_orders + 1, updated_at = strftime("%s","now") WHERE id = ?',
    [invoice.amount_usd, invoice.customer_id]);

  const fulfillmentId = uuidv4();
  DB.run('INSERT INTO service_fulfillments (id, invoice_id, customer_id, product_id, status) VALUES (?, ?, ?, ?, ?)',
    [fulfillmentId, invoiceId, invoice.customer_id, invoice.product_id, 'processing']);

  logAudit('payment_confirmed', invoiceId, {
    txid, currency, amount: invoice.amount, amount_usd: invoice.amount_usd,
    customer: invoice.customer_name, product: invoice.product_name
  });

  console.log(`\n✅ PAYMENT CONFIRMED: ${invoice.invoice_id}`);
  console.log(`   Customer: ${invoice.customer_name}`);
  console.log(`   Product: ${invoice.product_name}`);
  console.log(`   Amount: ${invoice.amount} ${currency} ($${invoice.amount_usd})`);
  console.log(`   TXID: ${txid}\n`);
}

// ─── BTC MONITOR ─────────────────────────────

async function checkBTCTransactions() {
  const config = walletConfig.wallets.BTC;
  const address = config.address;

  try {
    const axios = require('axios');
    const resp = await axios.get(`https://mempool.space/api/address/${address}/txs`, { timeout: 15000 });
    const txs = resp.data;
    if (!txs || txs.length === 0) return;

    const pendingInvoices = DB.all(
      "SELECT * FROM invoices WHERE currency = 'BTC' AND status = 'pending' AND expires_at > strftime('%s','now')"
    );
    if (pendingInvoices.length === 0) return;

    for (const tx of txs) {
      const vout = tx.vout || [];
      for (const output of vout) {
        if (output.scriptpubkey_address === address) {
          const amountBTC = output.value / 1e8;

          const existing = DB.all('SELECT id FROM transactions WHERE txid = ? AND currency = "BTC"', [tx.txid]);
          
          // Check if TX went to our address with matching amount
          for (const invoice of pendingInvoices) {
            const toleranceBTC = parseFloat((invoice.amount * 0.02).toFixed(8));
            if (Math.abs(amountBTC - invoice.amount) <= toleranceBTC) {
              
              if (existing.length === 0) {
                console.log(`[BTC] MATCH! TX ${tx.txid} → invoice ${invoice.invoice_id} (${amountBTC} BTC)`);

                DB.run(`INSERT INTO transactions (id, invoice_id, txid, currency, amount, confirmations, to_address, block_height, timestamp, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [uuidv4(), invoice.id, tx.txid, 'BTC', amountBTC, tx.status.confirmed ? 1 : 0,
                    address, tx.status.block_height || null, tx.status.block_time || Math.floor(Date.now() / 1000),
                    tx.status.confirmed ? 'confirmed' : 'pending']);

                logAudit('btc_tx_received', invoice.id, { txid: tx.txid, amount: amountBTC });
              }

              if (tx.status.confirmed && (existing.length === 0 || existing[0].confirmations < config.requiredConfirmations)) {
                // Check confirmation depth
                const txResp = await axios.get(`https://mempool.space/api/tx/${tx.txid}`, { timeout: 10000 });
                const tipResp = await axios.get('https://mempool.space/api/blocks/tip/height', { timeout: 10000 });
                const tipHeight = parseInt(tipResp.data);
                const blockHeight = txResp.data.status.block_height;
                if (blockHeight) {
                  const confirmations = tipHeight - blockHeight + 1;
                  DB.run('UPDATE transactions SET confirmations = ? WHERE txid = ? AND currency = "BTC"',
                    [confirmations, tx.txid]);
                  if (confirmations >= config.requiredConfirmations) {
                    confirmPayment(invoice.id, tx.txid, 'BTC');
                  }
                }
              }
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[BTC-MONITOR] Error:', err.message);
  }
}

// ─── POL MONITOR ─────────────────────────────

async function checkPOLTransactions() {
  const config = walletConfig.wallets.POL;
  const address = config.address.toLowerCase();

  try {
    const axios = require('axios');
    const apiKey = process.env.POLYGONSCAN_API_KEY || '';

    if (!apiKey) {
      // RPC-based balance + recent transaction scanning
      try {
        // Get current block number
        const blockResp = await axios.post(
          walletConfig.api.pol.rpc,
          { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
          { timeout: 10000 }
        );
        const currentBlock = parseInt(blockResp.data.result, 16);
        console.log(`[POL] Current block: ${currentBlock}`);

        // Get wallet balance
        const balanceResp = await axios.post(
          walletConfig.api.pol.rpc,
          { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [config.address, 'latest'] },
          { timeout: 10000 }
        );
        const balanceWei = BigInt(balanceResp.data.result || '0x0');
        const balancePOL = Number(balanceWei) / 1e18;
        if (balancePOL > 0.001) {
          console.log(`[POL] Wallet balance: ${balancePOL.toFixed(4)} POL`);
        }

        // Check recent blocks for incoming transactions (last 5 blocks to avoid rate limits)
        const pendingInvoices = DB.all(
          "SELECT * FROM invoices WHERE currency = 'POL' AND status = 'pending' AND expires_at > strftime('%s','now')"
        );
        if (pendingInvoices.length > 0) {
          for (let b = currentBlock; b >= Math.max(currentBlock - 5, 0) && b > 0; b--) {
            try {
              const blockData = await axios.post(
                walletConfig.api.pol.rpc,
                { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] },
                { timeout: 10000 }
              );
              const block = blockData.data.result;
              if (!block || !block.transactions) continue;

              // Process transactions from this block
              for (const txHash of block.transactions) {
                try {
                  const txResp = await axios.post(
                    walletConfig.api.pol.rpc,
                    { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [typeof txHash === 'string' ? txHash : txHash.hash] },
                    { timeout: 10000 }
                  );
                  const tx = txResp.data.result;
                  if (!tx || !tx.to) continue;

                  if (tx.to.toLowerCase() !== address) continue;
                  const amountPOL = parseInt(tx.value) / 1e18;
                  if (amountPOL <= 0) continue;

                  const existing = DB.all('SELECT id FROM transactions WHERE txid = ? AND currency = "POL"', [tx.hash]);
                  if (existing.length > 0) continue;

                  for (const invoice of pendingInvoices) {
                    const tolerancePOL = parseFloat((invoice.amount * 0.02).toFixed(6));
                    if (Math.abs(amountPOL - invoice.amount) <= tolerancePOL) {
                      const confs = currentBlock - b + 1;
                      console.log(`[POL] ✅ MATCH! TX ${tx.hash.substring(0, 20)}... → ${invoice.invoice_id} (${amountPOL} POL, ${confs} confs)`);

                      DB.run(`INSERT INTO transactions (id, invoice_id, txid, currency, amount, confirmations, from_address, to_address, block_height, timestamp, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [uuidv4(), invoice.id, tx.hash, 'POL', amountPOL, confs,
                          tx.from, config.address, b, block.timestamp || Math.floor(Date.now() / 1000),
                          confs >= config.requiredConfirmations ? 'confirmed' : 'pending']);
                      logAudit('pol_tx_received', invoice.id, { txid: tx.hash, amount: amountPOL });

                      if (confs >= config.requiredConfirmations) {
                        confirmPayment(invoice.id, tx.hash, 'POL');
                      }
                      break;
                    }
                  }
                } catch (txErr) {
                  // Skip individual tx failures
                }
              }
            } catch (blockErr) {
              // Skip blocks that fail to load
              continue;
            }
          }
        }
      } catch (rpcErr) {
        console.log(`[POL] RPC scan note: ${rpcErr.message.substring(0, 60)}`);
      }
      return;
    }

    const txResp = await axios.get(
      `https://api.polygonscan.com/api?module=account&action=txlist&address=${config.address}&sort=desc&apikey=${apiKey}`,
      { timeout: 15000 }
    );

    if (txResp.data.status !== '1' || !txResp.data.result) return;
    const txs = txResp.data.result;
    if (txs.length === 0) return;

    const pendingInvoices = DB.all(
      "SELECT * FROM invoices WHERE currency = 'POL' AND status = 'pending' AND expires_at > strftime('%s','now')"
    );
    if (pendingInvoices.length === 0) return;

    for (const tx of txs) {
      if (tx.to.toLowerCase() === address) {
        const amountPOL = parseInt(tx.value) / 1e18;
        const existing = DB.all('SELECT id FROM transactions WHERE txid = ? AND currency = "POL"', [tx.hash]);

        for (const invoice of pendingInvoices) {
          const tolerancePOL = parseFloat((invoice.amount * 0.02).toFixed(6));
          if (Math.abs(amountPOL - invoice.amount) <= tolerancePOL) {
            if (existing.length === 0) {
              console.log(`[POL] MATCH! TX ${tx.hash} → invoice ${invoice.invoice_id} (${amountPOL} POL)`);
              DB.run(`INSERT INTO transactions (id, invoice_id, txid, currency, amount, confirmations, from_address, to_address, block_height, timestamp, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), invoice.id, tx.hash, 'POL', amountPOL, parseInt(tx.confirmations) || 0,
                  tx.from, config.address, parseInt(tx.blockNumber) || null, parseInt(tx.timeStamp),
                  parseInt(tx.confirmations) >= config.requiredConfirmations ? 'confirmed' : 'pending']);
              logAudit('pol_tx_received', invoice.id, { txid: tx.hash, amount: amountPOL });
            }

            if (parseInt(tx.confirmations) >= config.requiredConfirmations) {
              confirmPayment(invoice.id, tx.hash, 'POL');
            }
            break;
          }
        }
      }
    }

    // Update confirmations
    const pendingTxns = DB.all("SELECT * FROM transactions WHERE currency = 'POL' AND status = 'pending'");
    for (const ptx of pendingTxns) {
      const txData = txs.find(t => t.hash === ptx.txid);
      if (txData) {
        const confs = parseInt(txData.confirmations) || 0;
        DB.run('UPDATE transactions SET confirmations = ? WHERE id = ?', [confs, ptx.id]);
        if (confs >= config.requiredConfirmations) {
          const inv = DB.all('SELECT * FROM invoices WHERE id = ?', [ptx.invoice_id]);
          if (inv.length > 0 && inv[0].status === 'pending') {
            confirmPayment(inv[0].id, ptx.txid, 'POL');
          }
        }
      }
    }
  } catch (err) {
    console.error('[POL-MONITOR] Error:', err.message);
  }
}

// ─── SOL MONITOR ─────────────────────────────

async function checkSOLTransactions() {
  const config = walletConfig.wallets.SOL;
  const address = config.address;

  try {
    const axios = require('axios');

    const sigResp = await axios.post(
      walletConfig.api.sol.rpc,
      { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 20 }] },
      { timeout: 15000 }
    );
    const signatures = sigResp.data.result || [];
    if (signatures.length === 0) return;

    const pendingInvoices = DB.all(
      "SELECT * FROM invoices WHERE currency = 'SOL' AND status = 'pending' AND expires_at > strftime('%s','now')"
    );
    if (pendingInvoices.length === 0) return;

    for (const sig of signatures) {
      const existing = DB.all('SELECT id FROM transactions WHERE txid = ? AND currency = "SOL"', [sig.signature]);
      if (existing.length > 0) continue;

      try {
        const txResp = await axios.post(
          walletConfig.api.sol.rpc,
          {
            jsonrpc: '2.0', id: 1, method: 'getTransaction',
            params: [sig.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]
          },
          { timeout: 15000 }
        );
        const txData = txResp.data.result;
        if (!txData || !txData.meta) continue;

        const accountKeys = txData.transaction.message.accountKeys || [];
        const ourIndex = accountKeys.indexOf(address);
        if (ourIndex === -1) continue;

        const postBalance = txData.meta.postBalances[ourIndex] || 0;
        const preBalance = txData.meta.preBalances[ourIndex] || 0;
        const amountSOL = (postBalance - preBalance) / 1e9;
        if (amountSOL <= 0) continue;

        for (const invoice of pendingInvoices) {
          const toleranceSOL = parseFloat((invoice.amount * 0.02).toFixed(4));
          if (Math.abs(amountSOL - invoice.amount) <= toleranceSOL) {
            console.log(`[SOL] MATCH! TX ${sig.signature} → invoice ${invoice.invoice_id} (${amountSOL} SOL)`);

            const confirmations = txData.confirmations || 1;
            const isConfirmed = confirmations >= config.requiredConfirmations;

            DB.run(`INSERT INTO transactions (id, invoice_id, txid, currency, amount, confirmations, to_address, block_height, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [uuidv4(), invoice.id, sig.signature, 'SOL', amountSOL, confirmations,
                address, txData.slot || null, txData.blockTime || Math.floor(Date.now() / 1000),
                isConfirmed ? 'confirmed' : 'pending']);

            logAudit('sol_tx_received', invoice.id, { txid: sig.signature, amount: amountSOL });

            if (isConfirmed) {
              confirmPayment(invoice.id, sig.signature, 'SOL');
            }
            break;
          }
        }
      } catch (e) {
        // Skip failed tx lookups
      }
    }
  } catch (err) {
    console.error('[SOL-MONITOR] Error:', err.message);
  }
}

// ─── MAIN SENTINEL LOOP ──────────────────────

async function sentinelLoop() {
  console.log(`[SENTINEL] Blockchain monitor started (check interval: ${CHECK_INTERVAL}s)`);

  const runCycle = async () => {
    try {
      console.log(`[SENTINEL] Running payment check cycle...`);

      await Promise.allSettled([
        checkBTCTransactions(),
        checkPOLTransactions(),
        checkSOLTransactions(),
      ]);

      // Expire old unpaid invoices
      const expiredResult = DB.run(
        "UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < strftime('%s','now')"
      );
      console.log(`[SENTINEL] Check cycle complete.`);
    } catch (err) {
      console.error('[SENTINEL] Cycle error:', err.message);
    }
  };

  await runCycle();
  setInterval(runCycle, CHECK_INTERVAL * 1000);
}

// ─── START ───────────────────────────────────

if (require.main === module) {
  getDatabase().then(dbi => {
    DB = dbi;
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║   ResumeTitan AI — Payment Sentinel      ║`);
    console.log(`║============================================║`);
    console.log(`║  BTC: ${walletConfig.wallets.BTC.address.substring(0, 16)}...  ║`);
    console.log(`║  POL: ${walletConfig.wallets.POL.address.substring(0, 16)}...  ║`);
    console.log(`║  SOL: ${walletConfig.wallets.SOL.address.substring(0, 16)}...  ║`);
    console.log(`╚════════════════════════════════════════════╝\n`);

    sentinelLoop().catch(err => {
      console.error('[SENTINEL] Fatal error:', err);
      process.exit(1);
    });
  }).catch(err => {
    console.error('[SENTINEL] DB init failed:', err);
    process.exit(1);
  });
}

module.exports = { sentinelLoop, confirmPayment };