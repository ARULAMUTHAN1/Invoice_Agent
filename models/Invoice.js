const mongoose = require('mongoose');

// ─── Line Item Sub-Schema ──────────────────────────────────────────────────
// Represents a single product/service row on the invoice.
const LineItemSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      trim: true,
      required: [true, 'Line item description is required'],
    },
    quantity: {
      type: Number,
      required: [true, 'Line item quantity is required'],
      min: [0, 'Quantity cannot be negative'],
    },
    unit_price: {
      type: Number,
      required: [true, 'Line item unit price is required'],
      min: [0, 'Unit price cannot be negative'],
    },
    amount: {
      type: Number,
      required: [true, 'Line item amount is required'],
      min: [0, 'Amount cannot be negative'],
    },
  },
  { _id: false } // no separate _id per line item
);

// ─── Main Invoice Schema ───────────────────────────────────────────────────
const InvoiceSchema = new mongoose.Schema(
  {
    // ── File Metadata (set by upload handler) ──────────────────────────────
    originalFileName: {
      type: String,
      trim: true,
      required: [true, 'Original file name is required'],
    },
    storedFileName: {
      type: String,
      required: [true, 'Stored file name is required'],
    },
    filePath: {
      type: String,
      required: [true, 'File path is required'],
    },
    mimeType: {
      type: String,
      enum: {
        values: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff'],
        message: 'Unsupported MIME type: {VALUE}',
      },
      required: [true, 'MIME type is required'],
    },
    fileSize: {
      type: Number, // in bytes
      required: true,
    },

    // ── Processing Status ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: {
        values: ['pending', 'processing', 'completed', 'failed'],
        message: 'Invalid status: {VALUE}',
      },
      default: 'pending',
    },
    errorMessage: {
      type: String,
      default: null,
    },

    // ── Vendor / Supplier ──────────────────────────────────────────────────
    vendor_name: {
      type: String,
      trim: true,
      default: null,
    },
    vendor_address: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Invoice Identification ─────────────────────────────────────────────
    invoice_number: {
      type: String,
      trim: true,
      default: null,
    },
    invoice_date: {
      type: Date,
      default: null,
    },
    due_date: {
      type: Date,
      default: null,
    },

    // ── Line Items ─────────────────────────────────────────────────────────
    line_items: {
      type: [LineItemSchema],
      default: [],
    },

    // ── Financials ─────────────────────────────────────────────────────────
    subtotal: {
      type: Number,
      default: null,
      min: [0, 'Subtotal cannot be negative'],
    },
    tax: {
      type: Number,
      default: null,
      min: [0, 'Tax cannot be negative'],
    },
    total_amount: {
      type: Number,
      default: null,
      min: [0, 'Total amount cannot be negative'],
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [3, 'Currency must be a 3-letter ISO 4217 code'],
      default: 'USD',
    },

    // ── AI Risk Assessment ─────────────────────────────────────────────────
    risk_level: {
      type: String,
      enum: {
        values: ['low', 'medium', 'high'],
        message: 'risk_level must be one of: low, medium, high',
      },
      default: null,
    },
    flags: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    reasoning: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Raw Gemini Response (audit trail) ─────────────────────────────────
    rawGeminiResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    // Mongoose auto-manages createdAt and updatedAt
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ───────────────────────────────────────────────────────────────
// Compound index for the most common lookup: vendor + invoice number
InvoiceSchema.index({ vendor_name: 1, invoice_number: 1 });

// Individual indexes for single-field queries
InvoiceSchema.index({ vendor_name: 1 });
InvoiceSchema.index({ invoice_number: 1 });
InvoiceSchema.index({ invoice_date: -1 });
InvoiceSchema.index({ risk_level: 1 });     // quickly filter high-risk invoices
InvoiceSchema.index({ status: 1 });
InvoiceSchema.index({ createdAt: -1 });

// ─── Virtuals ──────────────────────────────────────────────────────────────

/** Formatted file size, e.g. "245.30 KB" */
InvoiceSchema.virtual('fileSizeKB').get(function () {
  return this.fileSize ? `${(this.fileSize / 1024).toFixed(2)} KB` : null;
});

/** True when the invoice math is internally consistent (line_items sum ≈ subtotal). */
InvoiceSchema.virtual('isMathConsistent').get(function () {
  if (!this.line_items.length || this.subtotal === null) return null;
  const computed = this.line_items.reduce((sum, item) => sum + (item.amount || 0), 0);
  return Math.abs(computed - this.subtotal) < 0.01;
});

// ─── Instance Methods ──────────────────────────────────────────────────────

/**
 * Recompute subtotal and total_amount from line_items in place.
 * Call before saving if you modify line_items programmatically.
 */
InvoiceSchema.methods.recalculateTotals = function () {
  this.subtotal = this.line_items.reduce((sum, item) => sum + (item.amount || 0), 0);
  this.total_amount = this.subtotal + (this.tax || 0);
  return this;
};

// ─── Model ─────────────────────────────────────────────────────────────────
const Invoice = mongoose.model('Invoice', InvoiceSchema);

module.exports = Invoice;
