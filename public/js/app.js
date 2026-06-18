// ══════════════════════════════════════════════
// ResumeTitan AI — Customer Payment Portal
// ══════════════════════════════════════════════

let selectedProduct = null;
let selectedCurrency = 'BTC';
let currentInvoice = null;
let statusCheckInterval = null;

// ─── Load Products ────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadProducts();
});

async function loadProducts() {
  try {
    const resp = await fetch('/api/products');
    const data = await resp.json();
    
    if (!data.success || !data.products) {
      document.getElementById('products-list').innerHTML = '<div class="loading">Failed to load products. Please try again.</div>';
      return;
    }
    
    const productsHTML = data.products.map((product, index) => {
      const isBundle = product.id.startsWith('bundle');
      const isFeatured = product.id === 'bundle-premium';
      const cryptoPrice = product.crypto_prices.BTC.toFixed(8);
      
      return `
        <div class="product-card ${isFeatured ? 'featured' : ''}" onclick="selectProduct('${product.id}')">
          <h3>${product.name}</h3>
          <p>${product.description}</p>
          <div class="product-price">
            <span class="usd">$${product.usd_price}</span>
            <span class="label">USD</span>
          </div>
          <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">
            ≈ ${cryptoPrice} BTC
          </div>
        </div>
      `;
    }).join('');
    
    document.getElementById('products-list').innerHTML = productsHTML;
  } catch (err) {
    console.error('Failed to load products:', err);
    document.getElementById('products-list').innerHTML = '<div class="loading">⚠️ Service unavailable. Please try again later.</div>';
  }
}

// ─── Product Selection ────────────────────────

function selectProduct(productId) {
  selectedProduct = productId;
  
  // Show selected product info
  fetch('/api/products')
    .then(r => r.json())
    .then(data => {
      const product = data.products.find(p => p.id === productId);
      if (!product) return;
      
      document.getElementById('selected-product-info').innerHTML = `
        <h3>${product.name}</h3>
        <p class="price">$${product.usd_price} USD</p>
        <p style="color: var(--text-muted); font-size: 13px;">${product.description}</p>
      `;
      
      showStep('step-info');
    });
}

function backToProducts() {
  showStep('step-products');
}

// ─── Step Navigation ──────────────────────────

function showStep(stepId) {
  document.querySelectorAll('.step').forEach(s => s.style.display = 'none');
  document.getElementById(stepId).style.display = 'block';
}

// ─── Customer Form ────────────────────────────

document.getElementById('customer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const name = document.getElementById('customer-name').value.trim();
  const email = document.getElementById('customer-email').value.trim();
  const notes = document.getElementById('customer-notes').value.trim();
  
  if (!name || !email) {
    alert('Please fill in your name and email address.');
    return;
  }
  
  // Generate invoice
  await createInvoice(name, email, notes);
});

// ─── Create Invoice ───────────────────────────

async function createInvoice(name, email, notes) {
  document.getElementById('payment-address-section').innerHTML = '<div class="loading">Generating your payment request...</div>';
  
  try {
    const resp = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: name,
        customer_email: email,
        product_id: selectedProduct,
        currency: selectedCurrency,
        notes: notes
      })
    });
    
    const data = await resp.json();
    
    if (!data.success) {
      document.getElementById('payment-address-section').innerHTML = `
        <div class="loading" style="color: var(--danger);">
          ⚠️ ${data.error || 'Failed to create invoice. Please try again.'}
        </div>
      `;
      return;
    }
    
    currentInvoice = data.invoice;
    showPaymentAddress(currentInvoice);
    showStep('step-payment');
    
    // Start checking for payment
    startPaymentCheck(currentInvoice.invoice_id);
    
  } catch (err) {
    console.error('Invoice creation failed:', err);
    document.getElementById('payment-address-section').innerHTML = `
      <div class="loading" style="color: var(--danger);">
        ⚠️ Network error. Please try again.
      </div>
    `;
  }
}

// ─── Currency Selection ───────────────────────

function selectCurrency(currency) {
  selectedCurrency = currency;
  
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.currency === currency);
  });
}

// ─── Show Payment Address ─────────────────────

function showPaymentAddress(invoice) {
  const section = document.getElementById('payment-address-section');
  
  const currencySymbols = { BTC: '₿', POL: '⬡', SOL: '◎' };
  const currencyNames = { BTC: 'Bitcoin', POL: 'Polygon (MATIC)', SOL: 'Solana' };
  const explorerLinks = {
    BTC: `https://mempool.space/address/${invoice.wallet_address}`,
    POL: `https://polygonscan.com/address/${invoice.wallet_address}`,
    SOL: `https://solscan.io/address/${invoice.wallet_address}`,
  };
  
  section.innerHTML = `
    <h3>Send Payment</h3>
    <div class="amount-display">${invoice.amount} ${invoice.currency}</div>
    <div class="amount-usd-display">≈ $${invoice.amount_usd} USD</div>
    
    <div class="qr-placeholder">${currencySymbols[invoice.currency]}</div>
    
    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">
      Send exactly <strong>${invoice.amount} ${invoice.currency}</strong> to:
    </p>
    <div class="address-display" onclick="copyAddress(this)">${invoice.wallet_address}</div>
    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">
      Click address to copy · 
      <a href="${explorerLinks[invoice.currency]}" target="_blank" style="color: var(--primary);">View on Explorer →</a>
    </p>
    
    <div style="background: rgba(253, 203, 110, 0.1); border: 1px solid rgba(253, 203, 110, 0.3); border-radius: 8px; padding: 12px; font-size: 13px; color: var(--warning);">
      ⚠️ Send the exact amount shown above. Mismatched amounts will not be credited automatically.
    </div>
  `;
  
  // Show payment status section
  document.getElementById('payment-status').style.display = 'block';
  document.getElementById('status-message').textContent = `Waiting for ${currencyNames[invoice.currency]} payment...`;
  document.getElementById('progress-fill').style.width = '10%';
  document.getElementById('status-details').innerHTML = `
    <div style="font-size: 13px; color: var(--text-muted); margin-top: 12px;">
      Invoice: <strong>${invoice.invoice_id}</strong><br>
      Expires: ${new Date(invoice.expires_at * 1000).toLocaleString()}
    </div>
  `;
}

function copyAddress(el) {
  navigator.clipboard.writeText(el.textContent.trim()).then(() => {
    el.style.borderColor = 'var(--success)';
    el.style.color = 'var(--success)';
    setTimeout(() => {
      el.style.borderColor = '';
      el.style.color = '';
    }, 2000);
  }).catch(() => {
    // Fallback
    const range = document.createRange();
    range.selectNode(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
}

// ─── Payment Status Checking ──────────────────

function startPaymentCheck(invoiceId) {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
  
  let checkCount = 0;
  
  statusCheckInterval = setInterval(async () => {
    checkCount++;
    
    try {
      const resp = await fetch(`/api/invoices/${invoiceId}`);
      const data = await resp.json();
      
      if (!data.success || !data.invoice) return;
      
      const status = data.invoice.status;
      
      if (status === 'confirmed') {
        // Payment confirmed!
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
        
        document.getElementById('status-icon').textContent = '✅';
        document.getElementById('status-message').textContent = 'Payment Confirmed!';
        document.getElementById('progress-fill').style.width = '100%';
        document.getElementById('progress-fill').style.animation = 'none';
        
        showConfirmation(data.invoice, data.transaction);
        return;
      }
      
      if (status === 'expired') {
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
        
        document.getElementById('status-message').textContent = '⏰ Invoice Expired';
        document.getElementById('status-details').innerHTML = `
          <div style="color: var(--danger);">This invoice has expired. Please create a new payment request.</div>
        `;
        return;
      }
      
      // Update progress based on elapsed time
      const elapsed = (Date.now() / 1000) - data.invoice.created_at;
      const total = data.invoice.expires_at - data.invoice.created_at;
      const progress = Math.min((elapsed / total) * 100, 95);
      document.getElementById('progress-fill').style.width = `${progress}%`;
      
      if (checkCount % 5 === 0) {
        document.getElementById('status-message').textContent = 
          'Still waiting... The blockchain can take a few minutes to confirm.';
      }
      
    } catch (err) {
      console.error('Status check failed:', err);
    }
  }, 5000);
}

// ─── Confirmation ─────────────────────────────

function showConfirmation(invoice, transaction) {
  showStep('step-confirmed');
  
  document.getElementById('receipt-details').innerHTML = `
    <dl>
      <dt>Invoice</dt>
      <dd>${invoice.invoice_id}</dd>
      
      <dt>Amount Paid</dt>
      <dd>${invoice.amount} ${invoice.currency} ($${invoice.amount_usd} USD)</dd>
      
      <dt>Transaction ID</dt>
      <dd style="font-size: 11px;">${invoice.confirmed_txid || 'N/A'}</dd>
      
      <dt>Confirmed At</dt>
      <dd>${invoice.confirmed_at ? new Date(invoice.confirmed_at * 1000).toLocaleString() : 'Just now'}</dd>
      
      <dt>Delivery</dt>
      <dd>Your documents will be sent to your email within 24 hours</dd>
    </dl>
  `;
}