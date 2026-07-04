// ─── JWT Authentication Page Guard ─────────────────────────────────────────
const token = localStorage.getItem('invoice_agent_token');
if (!token) {
  window.location.href = '/login.html';
}

// Global user profile initialization
const username = localStorage.getItem('invoice_agent_username') || 'User';
document.addEventListener('DOMContentLoaded', () => {
  const displayUsernameEl = document.getElementById('display-username');
  if (displayUsernameEl) {
    displayUsernameEl.textContent = username;
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('invoice_agent_token');
      localStorage.removeItem('invoice_agent_username');
      window.location.href = '/login.html';
    });
  }
});

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

// Stats bar
const statValTotal    = document.getElementById('stat-val-total');
const statValSpend    = document.getElementById('stat-val-spend');
const statValHighrisk = document.getElementById('stat-val-highrisk');
const statValVendors  = document.getElementById('stat-val-vendors');

// Smart Search
const smartSearchInput     = document.getElementById('smart-search-input');
const smartSearchBtn       = document.getElementById('smart-search-btn');
const smartSearchClearBtn  = document.getElementById('smart-search-clear-btn');
const smartSearchBadgeInfo = document.getElementById('smart-search-badge-info');

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let selectedFile      = null;

// Invoice cache — loaded once, filtered client-side
let allInvoices       = [];   // full unfiltered list from the API
let filteredInvoices  = [];   // after applying search + dropdown filters
let clientPage        = 1;    // current page of filteredInvoices
const CLIENT_PAGE_SIZE = 10;  // rows per page

// Smart search states
let isSmartSearchActive = false;
let smartSearchResults  = [];

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
      headers: {
        'Authorization': `Bearer ${token}`
      },
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

    // Refresh history and stats after upload
    fetchAndCacheHistory();
    fetchAllForStats();

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
// ── History table — fetch once, filter client-side
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch all invoices (up to 1000) from the API and cache in allInvoices.
 * Then trigger client-side filtering and rendering.
 */
const fetchAndCacheHistory = async () => {
  historyBody.innerHTML = '';
  show(historyLoading);
  hide(historyEmpty);
  hide(historyError);
  hide(pagination);

  try {
    const res  = await fetch(`${API_BASE}/history?page=1&limit=1000`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const json = await res.json();

    hide(historyLoading);

    if (!res.ok || !json.success) {
      historyErrorMsg.textContent = json.message || `Error ${res.status}`;
      show(historyError);
      return;
    }

    allInvoices = json.data || [];
    clientPage  = 1;
    applyFilters();

  } catch (err) {
    hide(historyLoading);
    historyErrorMsg.textContent = `Network error: ${err.message}`;
    show(historyError);
  }
};

/**
 * Apply vendor text search, risk level, and status filters.
 * Filters are applied to smartSearchResults if smart search is active,
 * otherwise to allInvoices.
 * Resets to page 1 and renders the result.
 */
const applyFilters = () => {
  const vendorQuery  = filterVendor.value.trim().toLowerCase();
  const riskFilter   = filterRisk.value.toLowerCase();    // '' | 'low' | 'medium' | 'high'
  const statusFilter = filterStatus.value.toLowerCase();  // '' | 'completed' | etc.

  const sourceList = isSmartSearchActive ? smartSearchResults : allInvoices;

  filteredInvoices = sourceList.filter((inv) => {
    const vendorMatch  = !vendorQuery  || (inv.vendor_name || '').toLowerCase().includes(vendorQuery);
    const riskMatch    = !riskFilter   || (inv.risk_level  || '').toLowerCase() === riskFilter;
    const statusMatch  = !statusFilter || (inv.status      || '').toLowerCase() === statusFilter;
    return vendorMatch && riskMatch && statusMatch;
  });

  clientPage = 1;
  renderHistoryPage();
};

/**
 * Render the current clientPage slice of filteredInvoices to the table.
 */
const renderHistoryPage = () => {
  hide(historyEmpty);
  hide(historyError);
  hide(pagination);
  historyBody.innerHTML = '';

  if (filteredInvoices.length === 0) {
    show(historyEmpty);
    return;
  }

  const totalPages = Math.ceil(filteredInvoices.length / CLIENT_PAGE_SIZE);
  const start = (clientPage - 1) * CLIENT_PAGE_SIZE;
  const page  = filteredInvoices.slice(start, start + CLIENT_PAGE_SIZE);

  historyBody.innerHTML = page.map((inv) => {
    const scoreSuffix = (inv._searchScore !== undefined && inv._searchScore !== null)
      ? ` <span class="search-score" title="Cosine Similarity Score: ${inv._searchScore}">(${Math.round(inv._searchScore * 100)}% match)</span>`
      : '';

    return `
      <tr data-id="${inv._id}" style="cursor:pointer">
        <td>${escapeHtml(inv.vendor_name || '—')}${scoreSuffix}</td>
        <td class="mono">${escapeHtml(inv.invoice_number || '—')}</td>
        <td>${formatDate(inv.invoice_date)}</td>
        <td class="num">${formatMoney(inv.total_amount, inv.currency)}</td>
        <td>${riskBadgeHtml(inv.risk_level)}</td>
        <td>${statusBadgeHtml(inv.status)}</td>
        <td>${formatDate(inv.createdAt)}</td>
      </tr>
    `;
  }).join('');

  if (totalPages > 1) {
    paginationInfo.textContent = `Page ${clientPage} of ${totalPages}  (${filteredInvoices.length} invoices)`;
    prevPageBtn.disabled = clientPage <= 1;
    nextPageBtn.disabled = clientPage >= totalPages;
    show(pagination);
  }
};

// ─── Pagination — client-side page navigation ─────────────────────────────
prevPageBtn.addEventListener('click', () => {
  if (clientPage > 1) { clientPage--; renderHistoryPage(); }
});
nextPageBtn.addEventListener('click', () => {
  const totalPages = Math.ceil(filteredInvoices.length / CLIENT_PAGE_SIZE);
  if (clientPage < totalPages) { clientPage++; renderHistoryPage(); }
});

// ─── Live filter handlers ─────────────────────────────────────────────────
// Text search: 200ms debounce for smooth live-as-you-type experience
let vendorDebounce;
filterVendor.addEventListener('input', () => {
  clearTimeout(vendorDebounce);
  vendorDebounce = setTimeout(applyFilters, 200);
});
// Dropdowns: instant
filterRisk.addEventListener('change',   applyFilters);
filterStatus.addEventListener('change', applyFilters);

// ─── Refresh button: re-fetch from API ────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  const icon = refreshBtn.querySelector('.refresh-icon');
  icon.classList.add('spinning');
  icon.addEventListener('transitionend', () => icon.classList.remove('spinning'), { once: true });
  allInvoices = []; // clear cache so stats also refresh
  clearSmartSearch();
  fetchAndCacheHistory();
  fetchAllForStats();
});

// ─── Smart Search Action Handlers ─────────────────────────────────────────

/**
 * Call the POST /api/invoice/search endpoint to find semantically similar invoices,
 * cache the results, and render the table.
 */
const performSmartSearch = async () => {
  const query = smartSearchInput.value.trim();
  if (!query) {
    clearSmartSearch();
    return;
  }

  historyBody.innerHTML = '';
  show(historyLoading);
  hide(historyEmpty);
  hide(historyError);
  hide(pagination);
  smartSearchBtn.disabled = true;

  try {
    const res = await fetch('/api/invoice/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();

    hide(historyLoading);
    smartSearchBtn.disabled = false;

    if (!res.ok || !json.success) {
      historyErrorMsg.textContent = json.message || `Error ${res.status}`;
      show(historyError);
      return;
    }

    smartSearchResults = json.results || [];
    isSmartSearchActive = true;
    show(smartSearchClearBtn);
    show(smartSearchBadgeInfo);
    applyFilters();

  } catch (err) {
    hide(historyLoading);
    smartSearchBtn.disabled = false;
    historyErrorMsg.textContent = `Search error: ${err.message}`;
    show(historyError);
  }
};

/**
 * Restore normal view and clear search input
 */
const clearSmartSearch = () => {
  smartSearchInput.value = '';
  isSmartSearchActive = false;
  smartSearchResults = [];
  hide(smartSearchClearBtn);
  hide(smartSearchBadgeInfo);
  applyFilters();
};

// ─── Smart Search Listeners ───────────────────────────────────────────────
smartSearchBtn.addEventListener('click', performSmartSearch);
smartSearchClearBtn.addEventListener('click', clearSmartSearch);
smartSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    performSmartSearch();
  }
});

// ─── Click row → load + show result card ─────────────────────────────────
historyBody.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  try {
    const res  = await fetch(`${API_BASE}/${id}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
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
    low:    ['badge--low',    '✓ Low'],
    medium: ['badge--medium', '⚠ Medium'],
    high:   ['badge--high',   '✕ High'],
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
// ── Stats Bar — compute & display aggregate metrics
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch ALL invoices (no filter, large limit) to compute accurate global stats.
 * Runs independently from the paginated history view.
 */
/**
 * Fetch ALL invoices to compute accurate global stats.
 * Reuses the allInvoices cache if already populated; otherwise fetches fresh.
 */
const fetchAllForStats = async () => {
  try {
    // If cache is already populated reuse it to avoid a duplicate network call
    if (allInvoices.length > 0) {
      updateStats(allInvoices);
      return;
    }
    const res  = await fetch(`${API_BASE}/history?page=1&limit=1000`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const json = await res.json();
    if (res.ok && json.success) {
      updateStats(json.data || []);
    }
  } catch (err) {
    console.warn('[Stats] Could not fetch stats:', err.message);
  }
};

/**
 * Compute and display the 4 stat card values from a full invoice array.
 * Also triggers the spend-by-category pie chart update.
 * @param {Object[]} invoices — Array of invoice objects from the API.
 */
const updateStats = (invoices) => {
  if (!invoices || invoices.length === 0) {
    statValTotal.textContent    = '0';
    statValSpend.textContent    = '$0.00';
    statValHighrisk.textContent = '0';
    statValVendors.textContent  = '0';
    renderCategoryChart([]);
    return;
  }

  // Total invoices count
  statValTotal.textContent = invoices.length;

  // Total spend — sum of all total_amount
  const totalSpend = invoices.reduce((sum, inv) => {
    const amt = parseFloat(inv.total_amount);
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);
  statValSpend.textContent = formatMoney(totalSpend, 'USD');

  // High risk count
  const highRiskCount = invoices.filter(
    (inv) => (inv.risk_level || '').toLowerCase() === 'high'
  ).length;
  statValHighrisk.textContent = highRiskCount;

  // Unique vendors — count distinct non-null vendor names
  const uniqueVendors = new Set(
    invoices
      .map((inv) => (inv.vendor_name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  statValVendors.textContent = uniqueVendors.size;

  // Render the spend-by-category chart from the same data
  renderCategoryChart(invoices);
};

// ═══════════════════════════════════════════════════════════════════════════
// ── Spend-by-Category Pie Chart
// ═══════════════════════════════════════════════════════════════════════════

/** Fixed ordered list matching the server-side CATEGORY_LIST */
const CATEGORY_LIST = [
  'Software & Subscriptions',
  'Office Supplies',
  'Travel',
  'Utilities',
  'Professional Services',
  'Equipment',
  'Other',
];

/**
 * Curated dark-mode palette — one colour per category.
 * Order matches CATEGORY_LIST exactly.
 */
const CATEGORY_COLORS = [
  '#818cf8', // Software & Subscriptions — indigo
  '#34d399', // Office Supplies          — emerald
  '#f59e0b', // Travel                   — amber
  '#38bdf8', // Utilities                — sky blue
  '#a78bfa', // Professional Services    — violet
  '#fb923c', // Equipment                — orange
  '#94a3b8', // Other                    — slate
];

/** Chart.js instance — kept so we can destroy before re-creating */
let categoryChartInstance = null;

const chartEmptyEl  = document.getElementById('chart-empty');
const chartLegendEl = document.getElementById('chart-legend');

/**
 * Build (or rebuild) the doughnut chart from an invoice array.
 * Safe to call with an empty array — shows the empty state instead.
 *
 * @param {Object[]} invoices
 */
const renderCategoryChart = (invoices) => {
  // ── Aggregate spend per category ─────────────────────────────────────────
  const spendMap = {};
  CATEGORY_LIST.forEach((cat) => { spendMap[cat] = 0; });

  (invoices || []).forEach((inv) => {
    const cat = inv.category || 'Other';
    const amt = parseFloat(inv.total_amount);
    if (CATEGORY_LIST.includes(cat) && !isNaN(amt)) {
      spendMap[cat] += amt;
    }
  });

  // Filter to categories that actually have spend > 0
  const activeCategories = CATEGORY_LIST.filter((cat) => spendMap[cat] > 0);
  const activeValues     = activeCategories.map((cat) => spendMap[cat]);
  const activeColors     = activeCategories.map((cat) => CATEGORY_COLORS[CATEGORY_LIST.indexOf(cat)]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (activeCategories.length === 0) {
    show(chartEmptyEl);
    chartLegendEl.innerHTML = '';
    if (categoryChartInstance) {
      categoryChartInstance.destroy();
      categoryChartInstance = null;
    }
    return;
  }
  hide(chartEmptyEl);

  // ── Destroy old chart before creating a new one ───────────────────────────
  if (categoryChartInstance) {
    categoryChartInstance.destroy();
    categoryChartInstance = null;
  }

  // ── Create Chart.js doughnut ──────────────────────────────────────────────
  const canvas = document.getElementById('category-pie-chart');
  const ctx    = canvas.getContext('2d');

  categoryChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels:   activeCategories,
      datasets: [{
        data:            activeValues,
        backgroundColor: activeColors.map((c) => c + 'cc'),  // 80% opacity fill
        borderColor:     activeColors,
        borderWidth:     2,
        hoverOffset:     8,
      }],
    },
    options: {
      responsive:          false,   // we control size via CSS
      cutout:              '62%',   // doughnut hole size
      plugins: {
        legend: { display: false }, // we render a custom HTML legend
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val   = ctx.parsed;
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
              return ` ${formatMoney(val, 'USD')}  (${pct}%)`;
            },
          },
          backgroundColor: 'rgba(18,20,31,0.95)',
          borderColor:     'rgba(255,255,255,0.08)',
          borderWidth:     1,
          titleColor:      '#e2e4f0',
          bodyColor:       '#8b8fa8',
          padding:         10,
          cornerRadius:    8,
        },
      },
      animation: { duration: 600, easing: 'easeInOutQuart' },
    },
  });

  // ── Build custom HTML legend ──────────────────────────────────────────────
  const totalSpend = activeValues.reduce((a, b) => a + b, 0);
  chartLegendEl.innerHTML = activeCategories.map((cat, i) => `
    <div class="chart-legend__item">
      <span class="chart-legend__swatch" style="background:${activeColors[i]}"></span>
      <span class="chart-legend__label" title="${escapeHtml(cat)}">${escapeHtml(cat)}</span>
      <span class="chart-legend__value">${formatMoney(activeValues[i], 'USD')}</span>
    </div>
  `).join('');
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
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
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
    // Fetch invoices once on load — stats will be derived from the same cache
    fetchAndCacheHistory();
    fetchAllForStats();
