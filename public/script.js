'use strict';

/**
 * script.js — Invoice Processing Agent frontend
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles:
 *   - Drag-and-drop / file-input upload → POST /api/invoice/upload
 *   - Loading steps animation
 *   - Result card rendering (line items, totals, risk badge, flags, reasoning)
 *   - History table → GET /api/invoice/history (with pagination & filters)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════
const API_BASE = '/api/invoice';

// ═══════════════════════════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════════════════════════

// Upload
const uploadForm       = document.getElementById('upload-form');
const dropZone         = document.getElementById('drop-zone');
const fileInput        = document.getElementById('file-input');
const dropZoneContent  = document.getElementById('drop-zone-content');
const filePreview      = document.getElementById('file-preview');
const previewIcon      = document.getElementById('preview-icon');
const previewName      = document.getElementById('preview-name');
const previewSize      = document.getElementById('preview-size');
const removeFileBtn    = document.getElementById('remove-file');
const submitBtn        = document.getElementById('submit-btn');
const uploadError      = document.getElementById('upload-error');
const uploadErrorMsg   = document.getElementById('upload-error-msg');

// Sections
const loadingSection   = document.getElementById('loading-section');
const resultSection    = document.getElementById('result-section');
const uploadSection    = document.querySelector('section[aria-labelledby="upload-heading"]');

// Loading steps
const loadingSteps     = document.querySelectorAll('.loading-step');

// Result fields
const rVendor          = document.getElementById('r-vendor');
const rInvoiceNumber   = document.getElementById('r-invoice-number');
const rInvoiceDate     = document.getElementById('r-invoice-date');
const rDueDate         = document.getElementById('r-due-date');
const rCurrency        = document.getElementById('r-currency');
const rSubtotal        = document.getElementById('r-subtotal');
const rTax             = document.getElementById('r-tax');
const rTotal           = document.getElementById('r-total');
const rVendorAddressBlock = document.getElementById('result-address-block');
const rVendorAddress   = document.getElementById('r-vendor-address');
const lineItemsBody    = document.getElementById('line-items-body');

// Risk
const riskPanel        = document.getElementById('risk-panel');
const riskBadge        = document.getElementById('risk-badge');
const riskDot          = document.getElementById('risk-dot');
const riskLabel        = document.getElementById('risk-label');
const riskFlagsBox     = document.getElementById('risk-flags');
const riskFlagsList    = document.getElementById('risk-flags-list');
const riskReasoningBox = document.getElementById('risk-reasoning');
const riskReasoningTxt = document.getElementById('risk-reasoning-text');

// New invoice
const newInvoiceBtn    = document.getElementById('new-invoice-btn');

// History
const refreshBtn       = document.getElementById('refresh-btn');
const filterVendor     = document.getElementById('filter-vendor');
const filterRisk       = document.getElementById('filter-risk');
const filterStatus     = document.getElementById('filter-status');
const historyBody      = document.getElementById('history-body');
const historyLoading   = document.getElementById('history-loading');
const historyEmpty     = document.getElementById('history-empty');
const historyError     = document.getElementById('history-error');
const historyErrorMsg  = document.getElementById('history-error-msg');
const pagination       = document.getElementById('pagination');
const paginationInfo   = document.getElementById('pagination-info');
const prevPageBtn      = document.getElementById('prev-page-btn');
const nextPageBtn      = document.getElementById('next-page-btn');

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let selectedFile   = null;
let historyPage    = 1;
const HISTORY_LIMIT = 10;

// ═══════════════════════════════════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Format bytes → human-readable string */
const formatBytes = (bytes) => {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 ** 2)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
};

/** Format ISO date string → "Jan 15, 2024" */
const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Format a number as currency, falling back to plain number */
const formatMoney = (value, currency = 'USD') => {
  if (value === null || value === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
};

/** Emoji icon for file type */
const fileTypeIcon = (mimeType = '') => {
  if (mimeType.includes('pdf'))  return '📑';
  if (mimeType.includes('png'))  return '🖼️';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '🖼️';
  if (mimeType.includes('tiff')) return '🖼️';
  return '📄';
};

/** Toggle element visibility */
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// ═══════════════════════════════════════════════════════════════════════════
// ── Upload & Drop-zone
// ═══════════════════════════════════════════════════════════════════════════

const ACCEPTED_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff',
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Set selected file and update the preview UI */
const setFile = (file) => {
  if (!file) return;

  // Client-side validation
  if (!ACCEPTED_TYPES.has(file.type)) {
    showUploadError(`Unsupported file type: ${file.type || 'unknown'}. Please use PDF, PNG, JPEG, WEBP, or TIFF.`);
    return;
  }
  if (file.size > MAX_BYTES) {
    showUploadError(`File is too large (${formatBytes(file.size)}). Maximum allowed size is 10 MB.`);
    return;
  }

  hideUploadError();
  selectedFile = file;

  // Show preview
  previewIcon.textContent = fileTypeIcon(file.type);
  previewName.textContent = file.name;
  previewSize.textContent = formatBytes(file.size);
  hide(dropZoneContent);
  show(filePreview);
  submitBtn.disabled = false;
};

/** Clear selected file */
const clearFile = () => {
  selectedFile = null;
  fileInput.value = '';
  show(dropZoneContent);
  hide(filePreview);
  submitBtn.disabled = true;
  hideUploadError();
};

// File input change
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

// Remove file button
removeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearFile();
});

// Drag-and-drop
dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) setFile(file);
});

// Keyboard accessibility for drop zone
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

// ─── Upload error helpers ──────────────────────────────────────────────────
const showUploadError = (msg) => {
  uploadErrorMsg.textContent = msg;
  show(uploadError);
};
const hideUploadError = () => hide(uploadError);

// ═══════════════════════════════════════════════════════════════════════════
// ── Loading steps animation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Animate through loading steps with a delay between each.
 * steps: ['extract', 'anomaly', 'save']
 */
const animateLoadingSteps = () => {
  const delays = [0, 1800, 3500]; // ms between step activations
  loadingSteps.forEach((step, i) => {
    step.classList.remove('active', 'done');
    setTimeout(() => {
      // mark previous as done
      if (i > 0) loadingSteps[i - 1].classList.replace('active', 'done');
      step.classList.add('active');
    }, delays[i]);
  });
};

const finishLoadingSteps = () => {
  loadingSteps.forEach((s) => {
    s.classList.remove('active');
    s.classList.add('done');
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// ── Form submission → POST /api/invoice/upload
// ═══════════════════════════════════════════════════════════════════════════

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile) return;

  hideUploadError();

  // Show loading, hide upload section
  hide(uploadSection);
  hide(resultSection);
  show(loadingSection);
  animateLoadingSteps();

  // Build FormData
  const formData = new FormData();
  formData.append('invoice', selectedFile, selectedFile.name);

  try {
    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    const json = await res.json();

    finishLoadingSteps();

    // Short pause so the user sees all steps done
    await delay(400);
    hide(loadingSection);

    if (!res.ok || !json.success) {
      show(uploadSection);
      showUploadError(json.message || `Server error (${res.status}). Please try again.`);
      return;
    }

    // Render result
    renderResult(json.data, json.meta);
    show(resultSection);

    // Refresh history
    historyPage = 1;
    loadHistory();

  } catch (err) {
    hide(loadingSection);
    show(uploadSection);
    showUploadError(`Network error: ${err.message}. Is the server running?`);
  }
});

/** Simple async delay */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// ── Result card renderer
// ═══════════════════════════════════════════════════════════════════════════

const renderResult = (inv, meta = {}) => {
  const cur = inv.currency || 'USD';

  // Header fields
  rVendor.textContent        = inv.vendor_name    || '—';
  rInvoiceNumber.textContent = inv.invoice_number || '—';
  rInvoiceDate.textContent   = formatDate(inv.invoice_date);
  rDueDate.textContent       = formatDate(inv.due_date);
  rCurrency.textContent      = cur;

  // Vendor address
  if (inv.vendor_address) {
    rVendorAddress.textContent = inv.vendor_address;
    show(rVendorAddressBlock);
  } else {
    hide(rVendorAddressBlock);
  }

  // ── Line items ────────────────────────────────────────────────────────────
  if (inv.line_items && inv.line_items.length > 0) {
    lineItemsBody.innerHTML = inv.line_items.map((item) => `
      <tr>
        <td>${escapeHtml(item.description || '—')}</td>
        <td class="num">${item.quantity ?? '—'}</td>
        <td class="num">${formatMoney(item.unit_price, cur)}</td>
        <td class="num">${formatMoney(item.amount, cur)}</td>
      </tr>
    `).join('');
  } else {
    lineItemsBody.innerHTML = '<tr class="empty-row"><td colspan="4">No line items extracted.</td></tr>';
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  rSubtotal.textContent = formatMoney(inv.subtotal, cur);
  rTax.textContent      = formatMoney(inv.tax, cur);
  rTotal.textContent    = formatMoney(inv.total_amount, cur);

  // ── Risk badge ────────────────────────────────────────────────────────────
  const risk = (inv.risk_level || 'low').toLowerCase();
  const riskConfig = {
    low:    { label: '✓ Low Risk',    cls: 'risk-badge--low' },
    medium: { label: '⚠ Medium Risk', cls: 'risk-badge--medium' },
    high:   { label: '✕ High Risk',   cls: 'risk-badge--high' },
  };
  const cfg = riskConfig[risk] || riskConfig.low;

  riskBadge.className = `risk-badge ${cfg.cls}`;
  riskLabel.textContent = cfg.label;

  // Flags
  const flags = inv.flags || [];
  if (flags.length > 0) {
    riskFlagsList.innerHTML = flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    show(riskFlagsBox);
  } else {
    hide(riskFlagsBox);
  }

  // Reasoning
  if (inv.reasoning) {
    riskReasoningTxt.textContent = inv.reasoning;
    show(riskReasoningBox);
  } else {
    hide(riskReasoningBox);
  }

  // Scroll to result
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ─── "Process another" resets the form ───────────────────────────────────
newInvoiceBtn.addEventListener('click', () => {
  clearFile();
  hide(resultSection);
  show(uploadSection);
  uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── History table → GET /api/invoice/history
// ═══════════════════════════════════════════════════════════════════════════

const loadHistory = async () => {
  // Show loading state
  historyBody.innerHTML = '';
  show(historyLoading);
  hide(historyEmpty);
  hide(historyError);
  hide(pagination);

  // Build query string from filters + page
  const params = new URLSearchParams({ page: historyPage, limit: HISTORY_LIMIT });
  const vendor     = filterVendor.value.trim();
  const riskLevel  = filterRisk.value;
  const status     = filterStatus.value;
  if (vendor)    params.set('vendor',     vendor);
  if (riskLevel) params.set('risk_level', riskLevel);
  if (status)    params.set('status',     status);

  try {
    const res  = await fetch(`${API_BASE}/history?${params}`);
    const json = await res.json();

    hide(historyLoading);

    if (!res.ok || !json.success) {
      historyErrorMsg.textContent = json.message || `Error ${res.status}`;
      show(historyError);
      return;
    }

    const invoices = json.data || [];
    const pg       = json.pagination || {};

    if (invoices.length === 0) {
      show(historyEmpty);
      return;
    }

    // Render rows
    historyBody.innerHTML = invoices.map((inv) => `
      <tr data-id="${inv._id}">
        <td>${escapeHtml(inv.vendor_name || '—')}</td>
        <td class="mono">${escapeHtml(inv.invoice_number || '—')}</td>
        <td>${formatDate(inv.invoice_date)}</td>
        <td class="num">${formatMoney(inv.total_amount, inv.currency)}</td>
        <td>${riskBadgeHtml(inv.risk_level)}</td>
        <td>${statusBadgeHtml(inv.status)}</td>
        <td>${formatDate(inv.createdAt)}</td>
      </tr>
    `).join('');

    // Pagination controls
    if (pg.totalPages > 1) {
      paginationInfo.textContent = `Page ${pg.page} of ${pg.totalPages}  (${pg.total} invoices)`;
      prevPageBtn.disabled = !pg.hasPrevPage;
      nextPageBtn.disabled = !pg.hasNextPage;
      show(pagination);
    }

  } catch (err) {
    hide(historyLoading);
    historyErrorMsg.textContent = `Network error: ${err.message}`;
    show(historyError);
  }
};

// ─── Pagination ───────────────────────────────────────────────────────────
prevPageBtn.addEventListener('click', () => { historyPage--; loadHistory(); });
nextPageBtn.addEventListener('click', () => { historyPage++; loadHistory(); });

// ─── Filters (debounced) ──────────────────────────────────────────────────
let filterDebounce;
const onFilterChange = () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => { historyPage = 1; loadHistory(); }, 350);
};
filterVendor.addEventListener('input',  onFilterChange);
filterRisk.addEventListener('change',   onFilterChange);
filterStatus.addEventListener('change', onFilterChange);

// ─── Refresh button ───────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  const icon = refreshBtn.querySelector('.refresh-icon');
  icon.classList.add('spinning');
  icon.addEventListener('transitionend', () => icon.classList.remove('spinning'), { once: true });
  historyPage = 1;
  loadHistory();
});

// ─── Click row → fetch + show result ─────────────────────────────────────
historyBody.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;

  const id = row.dataset.id;
  try {
    const res  = await fetch(`${API_BASE}/${id}`);
    const json = await res.json();
    if (json.success) {
      hide(uploadSection);
      renderResult(json.data);
      show(resultSection);
      resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    console.error('Failed to load invoice:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Badge HTML helpers
// ═══════════════════════════════════════════════════════════════════════════

const riskBadgeHtml = (risk) => {
  const r = (risk || 'unknown').toLowerCase();
  const map = {
    low:    ['badge--low',    '↓ Low'],
    medium: ['badge--medium', '~ Med'],
    high:   ['badge--high',   '↑ High'],
  };
  const [cls, label] = map[r] || ['badge--neutral', r || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
};

const statusBadgeHtml = (status) => {
  const s = (status || '').toLowerCase();
  const dotCls = `status-dot--${s}`;
  const label  = s.charAt(0).toUpperCase() + s.slice(1);
  return `<span><span class="status-dot ${dotCls}"></span>${escapeHtml(label)}</span>`;
};

// ═══════════════════════════════════════════════════════════════════════════
// ── Security helper — prevent XSS from API data
// ═══════════════════════════════════════════════════════════════════════════
const escapeHtml = (str) => {
  if (str === null || str === undefined) return '—';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

// ═══════════════════════════════════════════════════════════════════════════
   // ── Floating Chat Widget Logic
   // ═══════════════════════════════════════════════════════════════════════════
   
   // DOM References
   const chatToggle    = document.getElementById('chat-toggle');
   const chatPanel     = document.getElementById('chat-panel');
   const chatClose     = document.getElementById('chat-close');
   const chatMessages  = document.getElementById('chat-messages');
   const chatForm      = document.getElementById('chat-form');
   const chatInput     = document.getElementById('chat-input');
   const chatSend      = document.getElementById('chat-send');
   const chatTyping    = document.getElementById('chat-typing');
   const toggleOpenIcon  = chatToggle.querySelector('.chat-toggle__icon--open');
   const toggleCloseIcon = chatToggle.querySelector('.chat-toggle__icon--close');
   
   // In-memory conversation history to track the chat context
   // Each item: { role: 'user' | 'model', content: string }
   let chatHistory = [];
   const MAX_HISTORY_TURNS = 6;
   
   /** Toggle chat panel visibility */
   const toggleChatPanel = () => {
     const isHidden = chatPanel.classList.toggle('hidden');
     chatToggle.setAttribute('aria-expanded', !isHidden);
     
     if (isHidden) {
       show(toggleOpenIcon);
       hide(toggleCloseIcon);
     } else {
       hide(toggleOpenIcon);
       show(toggleCloseIcon);
       chatInput.focus();
       scrollChatToBottom();
     }
   };
   
   chatToggle.addEventListener('click', toggleChatPanel);
   chatClose.addEventListener('click', toggleChatPanel);
   
   /** Enable/disable send button based on text entry */
   chatInput.addEventListener('input', () => {
     chatSend.disabled = !chatInput.value.trim();
   });
   
   /** Scroll message viewport to the bottom */
   const scrollChatToBottom = () => {
     chatMessages.scrollTop = chatMessages.scrollHeight;
   };
   
   /** Append message bubble to chat viewport */
   const appendMessageBubble = (role, text) => {
     const msgClass = role === 'user' ? 'chat-message--user' : 'chat-message--assistant';
     const bubble = document.createElement('div');
     bubble.className = `chat-message ${msgClass}`;
     bubble.innerHTML = `
       <div class="chat-message__bubble">
         ${escapeHtml(text).replace(/\n/g, '<br>')}
       </div>
     `;
     chatMessages.appendChild(bubble);
     scrollChatToBottom();
   };
   
   /** Handle chat form submission */
   chatForm.addEventListener('submit', async (e) => {
     e.preventDefault();
     const text = chatInput.value.trim();
     if (!text) return;
   
     // Add user message to UI
     appendMessageBubble('user', text);
     chatInput.value = '';
     chatSend.disabled = true;
   
     // Show thinking indicator
     show(chatTyping);
     scrollChatToBottom();
   
     try {
       // Send to backend /api/chat with previous message history
       const response = await fetch('/api/chat', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           message: text,
           conversationHistory: chatHistory,
         }),
       });
   
       const data = await response.json();
       hide(chatTyping);
   
       if (!response.ok || !data.success) {
         appendMessageBubble('assistant', "I'm sorry, I ran into an error while communicating with the assistant. Please try again.");
         return;
       }
   
       // Add reply to UI
       appendMessageBubble('assistant', data.reply);
   
       // Commit both user and model turns to memory
       chatHistory.push({ role: 'user', content: text });
       chatHistory.push({ role: 'model', content: data.reply });
   
       // Keep memory array capped to the last 6 turns to align with the token guard
       if (chatHistory.length > MAX_HISTORY_TURNS) {
         chatHistory = chatHistory.slice(-MAX_HISTORY_TURNS);
       }
   
     } catch (err) {
       hide(chatTyping);
       appendMessageBubble('assistant', "It looks like the connection failed. Please ensure the server is online and try again.");
       console.error('[Chat Widget Client Error]:', err.message);
     }
   });
   
   // ═══════════════════════════════════════════════════════════════════════════
   // ── Init
   // ═══════════════════════════════════════════════════════════════════════════
   loadHistory();
