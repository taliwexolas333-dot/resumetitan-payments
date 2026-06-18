// ══════════════════════════════════════════════
// ResumeTitan AI — Admin Dashboard
// ══════════════════════════════════════════════

let refreshInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  loadAllData();
  // Auto-refresh every 30 seconds
  refreshInterval = setInterval(loadAllData, 30000);
});

async function loadAllData() {
  await Promise.all([
    loadStats(),
    loadInvoices(),
    loadTransactions(),
    loadAuditLog()
  ]);
}

function refreshAll() {
  loadAllData();
}

// ─── Stats ────────────────────────────────────

async function loadStats() {
  try {
    const resp = await fetch('/api/admin/stats');
    const data = await resp.json();
    
    if (!data.success) return;
    
    const s = data.stats;
    
    document.getElementById('stat-revenue').textContent = `$${s.total_revenue_usd.toFixed(2)}`;
    document.getElementById('stat-confirmed').textContent = s.confirmed_invoices;
    document.getElementById('stat-pending').textContent = s.pending_invoices;
    document.getElementById('stat-customers').textContent = s.total_customers;
    
    // Crypto-specific
    const btcStats = s.revenue_by_currency?.BTC;
    const polStats = s.revenue_by_currency?.POL;
    const solStats = s.revenue_by_currency?.SOL;
    
    document.getElementById('stat-btc').textContent = btcStats ? btcStats.count : '0';
    document.getElementById('stat-pol').textContent = polStats ? polStats.count : '0';
    document.getElementById('stat-sol').textContent = solStats ? solStats.count : '0';
    
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ─── Invoices ─────────────────────────────────

async function loadInvoices() {
  try {
    const statusFilter = document.getElementById('status-filter').value;
    const url = statusFilter ? `/api/admin/invoices?status=${statusFilter}` : '/api/admin/invoices';
    
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (!data.success) return;
    
    const tbody = document.getElementById('invoices-body');
    
    if (data.invoices.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center">No invoices found</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.invoices.map(inv => {
      const date = new Date(inv.created_at * 1000).toLocaleString();
      const statusClass = inv.status;
      
      return `
        <tr>
          <td><code style="font-size: 11px;">${inv.invoice_id}</code></td>
          <td>${escapeHtml(inv.customer_name)}</td>
          <td>${escapeHtml(inv.product_name)}</td>
          <td>${inv.currency}</td>
          <td>${inv.amount}</td>
          <td>$${inv.amount_usd?.toFixed(2)}</td>
          <td><span class="status-badge ${statusClass}">${inv.status}</span></td>
          <td style="font-size: 12px; color: var(--text-muted);">${date}</td>
          <td class="txid-cell">${inv.txid || '-'}</td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error('Failed to load invoices:', err);
  }
}

// ─── Transactions ─────────────────────────────

async function loadTransactions() {
  try {
    const resp = await fetch('/api/admin/transactions');
    const data = await resp.json();
    
    if (!data.success) return;
    
    const tbody = document.getElementById('transactions-body');
    
    if (data.transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">No transactions recorded yet</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.transactions.map(tx => {
      const date = new Date(tx.timestamp * 1000).toLocaleString();
      const statusClass = tx.status;
      const explorerLink = getExplorerLink(tx.currency, tx.txid);
      
      return `
        <tr>
          <td class="txid-cell">
            <a href="${explorerLink}" target="_blank" style="color: var(--primary);">${tx.txid.substring(0, 20)}...</a>
          </td>
          <td>${tx.currency}</td>
          <td>${tx.amount}</td>
          <td>${tx.confirmations || 0}</td>
          <td><span class="status-badge ${statusClass}">${tx.status}</span></td>
          <td><code style="font-size: 11px;">${tx.invoice_id || '-'}</code></td>
          <td>${escapeHtml(tx.customer_name || '-')}</td>
          <td style="font-size: 12px; color: var(--text-muted);">${date}</td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error('Failed to load transactions:', err);
  }
}

// ─── Audit Log ────────────────────────────────

async function loadAuditLog() {
  try {
    const resp = await fetch('/api/admin/audit');
    const data = await resp.json();
    
    if (!data.success) return;
    
    const tbody = document.getElementById('audit-body');
    
    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">No audit events yet</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.logs.map(log => {
      const date = new Date(log.created_at * 1000).toLocaleString();
      let details = log.details;
      try {
        const parsed = JSON.parse(log.details);
        details = Object.entries(parsed).map(([k, v]) => {
          if (typeof v === 'object') v = JSON.stringify(v);
          return `<span style="color: var(--text-muted);">${k}:</span> ${escapeHtml(String(v))}`;
        }).join(', ');
      } catch (e) {}
      
      return `
        <tr>
          <td style="font-size: 12px; color: var(--text-muted);">${date}</td>
          <td><code style="font-size: 12px;">${escapeHtml(log.event_type)}</code></td>
          <td><code style="font-size: 11px;">${log.ref_invoice || '-'}</code></td>
          <td style="font-size: 13px;">${details}</td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error('Failed to load audit log:', err);
  }
}

// ─── Tab Switching ────────────────────────────

function switchTab(tabName) {
  // Update tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[onclick="switchTab('${tabName}')"]`).classList.add('active');
  
  // Update content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ─── Helpers ──────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getExplorerLink(currency, txid) {
  switch (currency) {
    case 'BTC': return `https://mempool.space/tx/${txid}`;
    case 'POL': return `https://polygonscan.com/tx/${txid}`;
    case 'SOL': return `https://solscan.io/tx/${txid}`;
    default: return '#';
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});