'use strict';

/**
 * routes/chat.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   POST /api/chat — Conversational chat with the Invoice Processing Agent.
 *                   Performs context retrieval from MongoDB based on the query,
 *                   then forwards to Gemini.
 */

const express = require('express');
const router  = express.Router();
const Invoice = require('../models/Invoice');
const { chatWithAgent } = require('../services/geminiService');

/**
 * POST /api/chat
 * Conversations with AI agent backed by MongoDB invoice context.
 *
 * Body (JSON):
 *   - message             {string}   Required. User input question/prompt.
 *   - conversationHistory {Object[]} Optional. Array of previous turns:
 *                                    [{ role: 'user'|'model', content: '...' }]
 */
router.post('/', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Request body must contain a non-empty "message" string.',
      });
    }

    const history = Array.isArray(conversationHistory) ? conversationHistory : [];
    // Limit to the last 6 messages to preserve token budget
    const trimmedHistory = history.slice(-6);

    // ── Context Retrieval Strategy ──────────────────────────────────────────
    let invoiceContext = [];
    let matchedVendor = null;
    const queryLower = message.toLowerCase();

    // 1. Check if the message contains a keyword related to risk, flags, or anomalies
    const isRiskQuery = /flag|risk|anomaly|suspicious|fraud|concern/i.test(queryLower);

    if (isRiskQuery) {
      console.log('🔍  Query contains risk keywords. Fetching medium/high risk invoices...');
      invoiceContext = await Invoice.find({
        status: 'completed',
        risk_level: { $in: ['medium', 'high'] },
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
    } else {
      // 2. Fetch distinct vendor names to see if one is mentioned in the query
      const distinctVendors = await Invoice.distinct('vendor_name', {
        status: 'completed',
        vendor_name: { $ne: null },
      });

      matchedVendor = distinctVendors.find(
        (vendor) => vendor && queryLower.includes(vendor.toLowerCase())
      );

      if (matchedVendor) {
        console.log(`🔍  Query mentions vendor "${matchedVendor}". Fetching vendor's invoices...`);
        invoiceContext = await Invoice.find({
          status: 'completed',
          vendor_name: matchedVendor,
        })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean();
      } else {
        // 3. Fallback: retrieve the 10 most recent invoices to serve as general context
        console.log('🔍  Fallback: Fetching 10 most recent completed invoices...');
        invoiceContext = await Invoice.find({ status: 'completed' })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean();
      }
    }

    // ── Send to Gemini Chat Agent ───────────────────────────────────────────
    const reply = await chatWithAgent(message, trimmedHistory, invoiceContext);

    return res.status(200).json({
      success: true,
      reply,
      meta: {
        contextRetrievedCount: invoiceContext.length,
        strategy: isRiskQuery ? 'risk' : (invoiceContext.length > 0 && !isRiskQuery && matchedVendor ? 'vendor' : 'fallback'),
      },
    });
  } catch (err) {
    console.error('[POST /api/chat] error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to process chat query.',
      detail: err.message,
    });
  }
});

module.exports = router;
