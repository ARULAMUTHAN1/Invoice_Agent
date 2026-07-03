'use strict';

/**
 * routes/invoice.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints
 *   POST   /api/invoice/upload      Upload → extract → anomaly-check → save → return
 *   GET    /api/invoice/history     All invoices sorted by createdAt desc
 *   GET    /api/invoice/:id         Single invoice by MongoDB _id
 *   DELETE /api/invoice/:id         Delete record + file from disk
 *   POST   /api/invoice/:id/ask     Ask Gemini a question about an invoice
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const Invoice = require('../models/Invoice');
const {
  extractInvoiceData,
  detectAnomalies,
  askAboutInvoice,
} = require('../services/geminiService');

// ═══════════════════════════════════════════════════════════════════════════
// Multer — disk storage, file-type whitelist, 10 MB cap
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const ts  = Date.now();
    const rnd = Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `invoice-${ts}-${rnd}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(null, true);
  }
  // Pass a MulterError so handleMulterError() can catch it cleanly
  cb(
    Object.assign(new multer.MulterError('LIMIT_UNEXPECTED_FILE'), {
      message: `Unsupported file type "${file.mimetype}". Allowed: PDF, PNG, JPEG, WEBP, TIFF.`,
    }),
    false
  );
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// ─── Multer error middleware ────────────────────────────────────────────────
// Must have 4 parameters so Express recognises it as an error handler.
const handleMulterError = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`
        : err.message;
    return res.status(400).json({ success: false, message: msg });
  }
  next(err); // pass non-multer errors to the global handler
};

// ═══════════════════════════════════════════════════════════════════════════
// Helper utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return true when err is a Mongoose CastError on the _id field.
 * Used to surface a clean 400 instead of a 500 for bad ObjectId strings.
 */
const isInvalidId = (err) => err.name === 'CastError' && err.path === '_id';

/**
 * Delete a file from disk without throwing if it no longer exists.
 * @param {string} filePath
 */
const safeUnlink = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`[safeUnlink] Could not delete "${filePath}":`, e.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/invoice/upload
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full synchronous pipeline:
 *   1. Receive file via multer
 *   2. Read file buffer from disk
 *   3. Call extractInvoiceData(buffer, mimeType)  → structured fields + risk from single-doc analysis
 *   4. Query MongoDB for past invoices from the same vendor
 *   5. Call detectAnomalies(current, pastInvoices) → cross-invoice risk assessment
 *   6. Merge both AI results (detectAnomalies wins on risk_level + flags if higher)
 *   7. Save to MongoDB
 *   8. Return 201 with the full saved invoice document
 *
 * Multipart field name: "invoice"
 */
router.post(
  '/upload',
  upload.single('invoice'),   // (1) multer middleware
  handleMulterError,          // (2) multer error catcher
  async (req, res) => {
    // ── Guard: file must be present ────────────────────────────────────────
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file received. Send a file in the "invoice" field of a multipart/form-data request.',
      });
    }

    const { path: filePath, filename, originalname, mimetype, size } = req.file;

    // ── Step 1: persist a placeholder record immediately ───────────────────
    // This ensures we always have a record even if AI calls fail partway through.
    const invoice = new Invoice({
      originalFileName: originalname,
      storedFileName:   filename,
      filePath,
      mimeType:         mimetype,
      fileSize:         size,
      status:           'processing',
    });

    try {
      await invoice.save();
    } catch (dbErr) {
      safeUnlink(filePath); // don't leave orphaned files
      console.error('[POST /upload] DB save (initial) failed:', dbErr.message);
      return res.status(500).json({
        success: false,
        message: 'Database error while creating invoice record.',
      });
    }

    // ── Step 2: read file into buffer ──────────────────────────────────────
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(filePath);
    } catch (fsErr) {
      await _markFailed(invoice, `Could not read uploaded file: ${fsErr.message}`);
      return res.status(500).json({
        success: false,
        message: 'Failed to read the uploaded file from disk.',
      });
    }

    // ── Step 3: Gemini extraction (single-document analysis) ───────────────
    let extractedData, rawText;
    try {
      const result = await extractInvoiceData(fileBuffer, mimetype);
      extractedData = result.parsed;
      rawText       = result.rawText;
    } catch (aiErr) {
      console.error(`[POST /upload] extractInvoiceData failed for ${invoice._id}:`, aiErr.message);
      await _markFailed(invoice, `AI extraction failed: ${aiErr.message}`);
      return res.status(422).json({
        success: false,
        message: 'AI could not extract data from the uploaded document.',
        detail:  aiErr.message,
      });
    }

    // ── Step 4: fetch past invoices for the same vendor ────────────────────
    let pastInvoices = [];
    if (extractedData.vendor_name) {
      try {
        pastInvoices = await Invoice.find({
          vendor_name: extractedData.vendor_name,
          status:      'completed',               // only use successfully processed records
          _id:         { $ne: invoice._id },      // exclude the current record
        })
          .sort({ createdAt: -1 })
          .limit(20)                              // cap at 20 to keep prompt tokens manageable
          .lean();
      } catch (dbErr) {
        // Non-fatal: log and proceed without history
        console.warn('[POST /upload] Could not fetch past invoices:', dbErr.message);
      }
    }

    // ── Step 5: Gemini anomaly detection (cross-invoice analysis) ──────────
    let anomalyResult = { flags: [], risk_level: 'low', reasoning: null };
    try {
      anomalyResult = await detectAnomalies(extractedData, pastInvoices);
    } catch (anomalyErr) {
      // Non-fatal: log and fall back to extraction-only risk
      console.warn(`[POST /upload] detectAnomalies failed for ${invoice._id}:`, anomalyErr.message);
    }

    // ── Step 6: merge extraction + anomaly results ─────────────────────────
    // Strategy: take the higher of the two risk levels; merge flag arrays.
    const RISK_RANK = { low: 0, medium: 1, high: 2 };

    const extractionRisk = extractedData.risk_level ?? 'low';
    const anomalyRisk    = anomalyResult.risk_level  ?? 'low';
    const finalRiskLevel =
      RISK_RANK[anomalyRisk] >= RISK_RANK[extractionRisk]
        ? anomalyRisk
        : extractionRisk;

    // Deduplicate flags from both sources
    const mergedFlags = [
      ...new Set([
        ...(extractedData.flags  ?? []),
        ...(anomalyResult.flags  ?? []),
      ]),
    ];

    // Combine reasoning strings (one from extraction, one from anomaly detection)
    const reasoningParts = [extractedData.reasoning, anomalyResult.reasoning].filter(Boolean);
    const finalReasoning = reasoningParts.length > 0 ? reasoningParts.join(' | ') : null;

    // ── Step 7: update the invoice document with all results ───────────────
    Object.assign(invoice, {
      status:           'completed',
      // Vendor
      vendor_name:      extractedData.vendor_name    ?? null,
      vendor_address:   extractedData.vendor_address ?? null,
      // Invoice identification
      invoice_number:   extractedData.invoice_number ?? null,
      invoice_date:     extractedData.invoice_date   ? new Date(extractedData.invoice_date) : null,
      due_date:         extractedData.due_date        ? new Date(extractedData.due_date)     : null,
      // Financials
      line_items:       extractedData.line_items      ?? [],
      subtotal:         extractedData.subtotal        ?? null,
      tax:              extractedData.tax             ?? null,
      total_amount:     extractedData.total_amount    ?? null,
      currency:         extractedData.currency        ?? 'USD',
      // Merged AI risk assessment
      risk_level:       finalRiskLevel,
      flags:            mergedFlags,
      reasoning:        finalReasoning,
      // Audit trail
      rawGeminiResponse: rawText,
      errorMessage:     null,
    });

    try {
      await invoice.save();
    } catch (saveErr) {
      console.error(`[POST /upload] Final DB save failed for ${invoice._id}:`, saveErr.message);
      return res.status(500).json({
        success: false,
        message: 'Extraction succeeded but saving results to the database failed.',
        invoiceId: invoice._id,
      });
    }

    // ── Step 8: return the full saved document ─────────────────────────────
    console.log(`✅  Invoice ${invoice._id} processed — risk: ${finalRiskLevel}, flags: ${mergedFlags.length}`);

    return res.status(201).json({
      success: true,
      message: 'Invoice processed successfully.',
      data:    invoice.toObject(),
      meta: {
        pastInvoicesAnalysed: pastInvoices.length,
        extractionRisk,
        anomalyRisk,
        finalRisk: finalRiskLevel,
      },
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/invoice/history
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return all invoices sorted by createdAt descending.
 *
 * Optional query params:
 *   ?status=completed|pending|processing|failed
 *   ?risk_level=low|medium|high
 *   ?vendor=partialName          (case-insensitive regex match on vendor_name)
 *   ?page=1&limit=20             (pagination; limit capped at 100)
 */
router.get('/history', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    // ── Build filter ────────────────────────────────────────────────────────
    const filter = {};
    if (req.query.status)     filter.status     = req.query.status;
    if (req.query.risk_level) filter.risk_level = req.query.risk_level;
    if (req.query.vendor) {
      filter.vendor_name = { $regex: req.query.vendor, $options: 'i' };
    }

    // ── Query ───────────────────────────────────────────────────────────────
    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ createdAt: -1 })   // newest first
        .skip(skip)
        .limit(limit)
        .select('-rawGeminiResponse') // omit large blob from list view
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      data: invoices,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    console.error('[GET /history]', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoice history.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/invoice/:id
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return a single invoice by its MongoDB ObjectId.
 * Includes rawGeminiResponse (omitted from the history list).
 */
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: `Invoice with id "${req.params.id}" not found.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: invoice.toObject(),
    });
  } catch (err) {
    if (isInvalidId(err)) {
      return res.status(400).json({
        success: false,
        message: `"${req.params.id}" is not a valid invoice ID.`,
      });
    }
    console.error('[GET /:id]', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve the invoice.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/invoice/:id
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Delete an invoice record from MongoDB and remove its file from disk.
 */
router.delete('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findByIdAndDelete(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: `Invoice with id "${req.params.id}" not found.`,
      });
    }

    safeUnlink(invoice.filePath);

    return res.status(200).json({
      success: true,
      message: 'Invoice deleted successfully.',
    });
  } catch (err) {
    if (isInvalidId(err)) {
      return res.status(400).json({
        success: false,
        message: `"${req.params.id}" is not a valid invoice ID.`,
      });
    }
    console.error('[DELETE /:id]', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete the invoice.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/invoice/:id/ask
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ask Gemini a follow-up question about a specific invoice.
 *
 * Body (JSON):
 *   { "question": "What is the tax amount?" }
 */
router.post('/:id/ask', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !String(question).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Request body must include a non-empty "question" string.',
      });
    }

    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: `Invoice with id "${req.params.id}" not found.`,
      });
    }

    if (invoice.status !== 'completed') {
      return res.status(409).json({
        success: false,
        message: `Invoice is not yet fully processed (current status: "${invoice.status}"). Try again later.`,
      });
    }

    const answer = await askAboutInvoice(String(question).trim(), invoice.toObject());

    return res.status(200).json({
      success: true,
      invoiceId: invoice._id,
      question:  String(question).trim(),
      answer,
    });
  } catch (err) {
    if (isInvalidId(err)) {
      return res.status(400).json({
        success: false,
        message: `"${req.params.id}" is not a valid invoice ID.`,
      });
    }
    console.error('[POST /:id/ask]', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get an AI answer for this invoice.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Private helpers (module-scoped, not exported)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mark an invoice as failed, persist it, and log the error.
 * @param {import('../models/Invoice')} invoice
 * @param {string} reason
 */
async function _markFailed(invoice, reason) {
  try {
    invoice.status       = 'failed';
    invoice.errorMessage = reason;
    await invoice.save();
  } catch (e) {
    console.error('[_markFailed] Could not update invoice status:', e.message);
  }
  console.error(`❌  Invoice ${invoice._id} failed: ${reason}`);
}

module.exports = router;
