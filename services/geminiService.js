'use strict';

/**
 * services/geminiService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All communication with the Google Gemini API lives here.
 *
 * Public API
 *   extractInvoiceData(fileBuffer, mimeType)          → Promise<{ parsed, rawText }>
 *   detectAnomalies(currentInvoice, pastInvoices)     → Promise<{ flags, risk_level, reasoning }>
 *   askAboutInvoice(question, invoiceData)            → Promise<string>
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// ─── Guard: API key check ──────────────────────────────────────────────────
const hasApiKey = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '';
if (!hasApiKey) {
  console.warn(
    '⚠️  [geminiService] GEMINI_API_KEY is not set. ' +
    'AI extraction and chat features will fail until a key is provided in your environment or .env file.'
  );
}

// ─── Client ────────────────────────────────────────────────────────────────
// Fallback to a dummy key to prevent initialization from throwing immediately
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'MISSING_GEMINI_API_KEY');

/**
 * Throw a descriptive runtime error if the Gemini API key is missing.
 * Prevents execution from proceeding with the dummy key fallback.
 */
const ensureApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === '' || key === 'MISSING_GEMINI_API_KEY') {
    throw new Error('Gemini API key is not configured. Please set the GEMINI_API_KEY environment variable and restart the server.');
  }
};

// ─── Model ─────────────────────────────────────────────────────────────────
const MODEL_NAME = 'gemini-2.5-flash'; // fast + multimodal; swap to gemini-2.5-pro for higher accuracy

// ─── Safety settings ───────────────────────────────────────────────────────
// Relax all categories — invoice documents contain no harmful content
// but may contain flagged keywords (e.g. "explosive" charges, "weapon" parts, etc.)
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ─── Extraction Prompt ─────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are an expert invoice data extraction and risk assessment AI.
Analyse the provided invoice document (image or PDF), extract all data, and assess its risk.

Return a single, valid JSON object with EXACTLY this structure (use null for missing fields):
{
  "vendor_name":    "string | null",
  "vendor_address": "string | null",
  "invoice_number": "string | null",
  "invoice_date":   "YYYY-MM-DD | null",
  "due_date":       "YYYY-MM-DD | null",
  "line_items": [
    {
      "description": "string",
      "quantity":    number,
      "unit_price":  number,
      "amount":      number
    }
  ],
  "subtotal":      number | null,
  "tax":           number | null,
  "total_amount":  number | null,
  "currency":      "ISO 4217 code e.g. USD, EUR, INR | null",
  "risk_level":    "low | medium | high",
  "flags":         ["array of short strings describing any anomalies or concerns"],
  "reasoning":     "string explaining the risk_level decision | null"
}

Risk assessment guidelines:
- "low"    → amounts match, dates are valid, no anomalies detected.
- "medium" → minor discrepancies (e.g. line_items don't sum to subtotal, missing due_date).
- "high"   → major red flags (e.g. large round-number amounts, duplicate invoice numbers suspected,
              missing vendor info, subtotal/tax/total are mathematically inconsistent, future invoice_date).

Rules:
- All monetary values must be plain numbers — no currency symbols, commas, or extra text.
- Dates must be ISO 8601 format (YYYY-MM-DD) or null.
- "amount" in each line_item must equal quantity × unit_price (verify this).
- "flags" must be an array (empty array [] if none).
- "risk_level" is REQUIRED — never null.
- Return ONLY the JSON object — no markdown fences, no explanation outside the JSON.`;

// ─── Anomaly Detection Prompt ──────────────────────────────────────────────
/**
 * Used by detectAnomalies(). Receives two JSON blocks — the current invoice
 * and an array of past invoices from the same vendor — and returns a focused
 * risk assessment based purely on cross-invoice pattern analysis.
 */
const ANOMALY_PROMPT = `You are a financial fraud detection AI specialising in invoice anomaly detection.

You will be given:
1. CURRENT INVOICE  — the invoice being assessed right now.
2. PAST INVOICES    — an array of previous invoices from the same vendor (may contain 1 or more).

Your task is to compare the current invoice against the vendor's historical pattern and identify anomalies.

Check for ALL of the following signals:
- Duplicate invoice_number already present in past invoices.
- Unusual total_amount spike or drop (>50% deviation from the vendor's historical average).
- Unusually high or low unit_price for the same line-item descriptions seen before.
- Currency change compared to past invoices from this vendor.
- Billing frequency anomaly (e.g. two invoices within days of each other from same vendor).
- Vendor address changed compared to historical records (possible vendor impersonation).
- Round-number totals with no line-item detail (common in fraudulent invoices).
- Missing required fields (invoice_number, invoice_date, vendor_name) that were present before.
- Tax rate inconsistency compared to past invoices.
- Due date shorter than historically observed payment terms.

Return a single, valid JSON object with EXACTLY this structure:
{
  "flags":      ["concise string per detected anomaly — empty array if none"],
  "risk_level": "low | medium | high",
  "reasoning":  "One clear paragraph explaining the overall risk verdict, referencing specific data points from both the current and past invoices."
}

Risk level rules:
- "low"    → no meaningful anomalies detected.
- "medium" → 1–2 minor anomalies that warrant a human review (e.g. small amount deviation, different address).
- "high"   → any of: duplicate invoice number, amount spike >50%, currency change, missing vendor info, address mismatch.

Return ONLY the JSON object — no markdown fences, no explanation outside the JSON.`;

// ═══════════════════════════════════════════════════════════════════════════
// Private helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a Node.js Buffer to a Gemini inline-data content part.
 *
 * @param {Buffer} buffer   - Raw file bytes.
 * @param {string} mimeType - MIME type, e.g. 'image/png' or 'application/pdf'.
 * @returns {{ inlineData: { data: string, mimeType: string } }}
 */
const bufferToGenerativePart = (buffer, mimeType) => ({
  inlineData: {
    data: buffer.toString('base64'), // Step 1: base64-encode the raw bytes
    mimeType,
  },
});

/**
 * Strip markdown code fences that Gemini sometimes wraps its JSON in.
 *
 * Handles all of:
 *   ```json { ... } ```
 *   ``` { ... } ```
 *   plain { ... }
 *
 * @param {string} text - Raw model output.
 * @returns {string}    - Clean JSON string ready for JSON.parse().
 */
const stripCodeFences = (text) =>
  text
    .replace(/^```(?:json)?\s*/i, '') // opening fence  (```json or ```)
    .replace(/\s*```\s*$/i, '')       // closing fence  (```)
    .trim();

/**
 * Validate that a parsed invoice extraction object contains the required fields
 * and that risk_level is one of the allowed enum values.
 *
 * @param {unknown} obj - The value returned by JSON.parse().
 * @throws {Error}      - If required fields are missing or invalid.
 */
const validateParsed = (obj) => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Parsed response is not a JSON object.');
  }

  const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
  if (!VALID_RISK_LEVELS.has(obj.risk_level)) {
    throw new Error(
      `Invalid risk_level "${obj.risk_level}". Expected one of: low, medium, high.`
    );
  }

  if (!Array.isArray(obj.flags)) {
    throw new Error('"flags" must be an array.');
  }

  if (!Array.isArray(obj.line_items)) {
    throw new Error('"line_items" must be an array.');
  }
};

/**
 * Validate that a parsed anomaly-detection result has the three required fields
 * with correct types.
 *
 * @param {unknown} obj - Value from JSON.parse().
 * @throws {Error}      - If the shape is wrong.
 */
const validateAnomalyResult = (obj) => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Anomaly result is not a JSON object.');
  }

  const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
  if (!VALID_RISK_LEVELS.has(obj.risk_level)) {
    throw new Error(
      `Invalid risk_level "${obj.risk_level}". Expected one of: low, medium, high.`
    );
  }

  if (!Array.isArray(obj.flags)) {
    throw new Error('"flags" must be an array.');
  }

  if (obj.reasoning !== null && typeof obj.reasoning !== 'string') {
    throw new Error('"reasoning" must be a string or null.');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract structured invoice data from a file buffer using Gemini 1.5 Flash.
 *
 * @param {Buffer} fileBuffer - Raw bytes of the uploaded invoice file.
 *                             Typically sourced from multer's `req.file.buffer`
 *                             (memoryStorage) or `fs.readFileSync(req.file.path)`.
 * @param {string} mimeType  - MIME type of the file.
 *                             Supported: 'application/pdf', 'image/png',
 *                             'image/jpeg', 'image/webp', 'image/tiff'.
 *
 * @returns {Promise<{ parsed: Object, rawText: string }>}
 *   - `parsed`  : Validated JS object matching the extraction schema.
 *   - `rawText` : Original model output (kept for audit trail / re-processing).
 *
 * @throws {Error} If the Gemini API call fails, the model returns a blocked
 *                 response, the output is not valid JSON, or required fields
 *                 fail validation.
 *
 * @example
 * const { parsed, rawText } = await extractInvoiceData(req.file.buffer, req.file.mimetype);
 * console.log(parsed.risk_level); // 'low' | 'medium' | 'high'
 */
const extractInvoiceData = async (fileBuffer, mimeType) => {
  // ── Input guards ──────────────────────────────────────────────────────────
  ensureApiKey();
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error('[extractInvoiceData] fileBuffer must be a non-empty Buffer.');
  }
  if (typeof mimeType !== 'string' || !mimeType.trim()) {
    throw new Error('[extractInvoiceData] mimeType must be a non-empty string.');
  }

  // ── Step 1: Build the inline data part ───────────────────────────────────
  const filePart = bufferToGenerativePart(fileBuffer, mimeType);

  // ── Step 2: Call Gemini API ───────────────────────────────────────────────
  let rawText;
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await model.generateContent([EXTRACTION_PROMPT, filePart]);
    const response = result.response;

    // Check for a blocked response (safety / recitation filters)
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(
        `Gemini returned an unexpected finish reason: "${finishReason}". ` +
        'The content may have been blocked by safety filters.'
      );
    }

    rawText = response.text();
  } catch (apiErr) {
    // Surface API errors clearly, preserving the original message
    throw new Error(`[extractInvoiceData] Gemini API call failed — ${apiErr.message}`);
  }

  // ── Step 3: Strip markdown fences & parse JSON ────────────────────────────
  const cleanText = stripCodeFences(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (parseErr) {
    // Include a snippet of the raw output so the caller can debug
    const preview = rawText.length > 400
      ? rawText.slice(0, 400) + '…[truncated]'
      : rawText;

    throw new Error(
      `[extractInvoiceData] Failed to parse Gemini response as JSON.\n` +
      `Parse error : ${parseErr.message}\n` +
      `Raw output  : ${preview}`
    );
  }

  // ── Step 4: Validate required fields ─────────────────────────────────────
  try {
    validateParsed(parsed);
  } catch (validationErr) {
    throw new Error(
      `[extractInvoiceData] Gemini response failed schema validation — ${validationErr.message}`
    );
  }

  // ── Step 5: Return both the parsed object and the original text ───────────
  return { parsed, rawText };
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask a follow-up natural-language question about an already-extracted invoice.
 *
 * @param {string} question    - Plain English question from the user.
 * @param {Object} invoiceData - The previously extracted + stored invoice object.
 * @returns {Promise<string>}  - Gemini's concise answer as a plain string.
 *
 * @throws {Error} If the API call fails.
 *
 * @example
 * const answer = await askAboutInvoice('Is this invoice overdue?', invoice.toObject());
 */
const askAboutInvoice = async (question, invoiceData) => {
  ensureApiKey();
  if (!question || !question.trim()) {
    throw new Error('[askAboutInvoice] question must be a non-empty string.');
  }

  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const prompt =
    `You are a helpful invoice assistant. Below is extracted invoice data in JSON format:\n\n` +
    `${JSON.stringify(invoiceData, null, 2)}\n\n` +
    `User question: ${question.trim()}\n\n` +
    `Answer concisely and factually based only on the invoice data above.`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    throw new Error(`[askAboutInvoice] Gemini API call failed — ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare a current invoice against the vendor's past invoices and surface
 * any cross-invoice anomalies using Gemini's pattern-recognition capability.
 *
 * @param {Object}   currentInvoice - The freshly extracted invoice object
 *                                   (plain JS object or Mongoose document).
 * @param {Object[]} pastInvoices   - Array of past Invoice documents from the
 *                                   same vendor, fetched from MongoDB.
 *                                   If empty, the function short-circuits and
 *                                   returns a safe default.
 *
 * @returns {Promise<{ flags: string[], risk_level: string, reasoning: string }>}
 *
 * @throws {Error} If the Gemini API call fails or the response cannot be parsed.
 *
 * @example
 * const pastInvoices = await Invoice.find({ vendor_name: invoice.vendor_name, _id: { $ne: invoice._id } }).lean();
 * const anomalies = await detectAnomalies(invoice.toObject(), pastInvoices);
 * // → { flags: ['Amount 80% above vendor average'], risk_level: 'high', reasoning: '...' }
 */
const detectAnomalies = async (currentInvoice, pastInvoices) => {
  // ── Input guards ──────────────────────────────────────────────────────────
  ensureApiKey();
  if (typeof currentInvoice !== 'object' || currentInvoice === null) {
    throw new Error('[detectAnomalies] currentInvoice must be a non-null object.');
  }
  if (!Array.isArray(pastInvoices)) {
    throw new Error('[detectAnomalies] pastInvoices must be an array.');
  }

  // ── Early exit: no history available ─────────────────────────────────────
  if (pastInvoices.length === 0) {
    return {
      flags:      [],
      risk_level: 'low',
      reasoning:  'No prior history for this vendor. Baseline cannot be established; manual review recommended for first-time vendors.',
    };
  }

  // ── Build prompt context — strip large/binary fields to save tokens ────────
  const sanitise = (inv) => {
    // eslint-disable-next-line no-unused-vars
    const { rawGeminiResponse, filePath, storedFileName, __v, ...safe } = inv;
    return safe;
  };

  const contextBlock =
    `## CURRENT INVOICE\n${JSON.stringify(sanitise(currentInvoice), null, 2)}\n\n` +
    `## PAST INVOICES (same vendor — ${pastInvoices.length} record${pastInvoices.length === 1 ? '' : 's'})\n` +
    `${JSON.stringify(pastInvoices.map(sanitise), null, 2)}`;

  const fullPrompt = `${ANOMALY_PROMPT}\n\n${contextBlock}`;

  // ── Call Gemini API ───────────────────────────────────────────────────────
  let rawText;
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await model.generateContent(fullPrompt);
    const response = result.response;

    // Guard against blocked responses
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(
        `Gemini returned an unexpected finish reason: "${finishReason}". ` +
        'The response may have been blocked by safety filters.'
      );
    }

    rawText = response.text();
  } catch (apiErr) {
    throw new Error(`[detectAnomalies] Gemini API call failed — ${apiErr.message}`);
  }

  // ── Strip fences & parse JSON ─────────────────────────────────────────────
  const cleanText = stripCodeFences(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (parseErr) {
    const preview = rawText.length > 400
      ? rawText.slice(0, 400) + '…[truncated]'
      : rawText;

    throw new Error(
      `[detectAnomalies] Failed to parse Gemini response as JSON.\n` +
      `Parse error : ${parseErr.message}\n` +
      `Raw output  : ${preview}`
    );
  }

  // ── Validate shape ────────────────────────────────────────────────────────
  try {
    validateAnomalyResult(parsed);
  } catch (validationErr) {
    throw new Error(
      `[detectAnomalies] Gemini response failed schema validation — ${validationErr.message}`
    );
  }

  // ── Return only the three fields the caller needs ─────────────────────────
  return {
    flags:      parsed.flags,
    risk_level: parsed.risk_level,
    reasoning:  parsed.reasoning ?? null,
  };
};

/**
 * Chat with the Invoice Processing Agent using historical context and conversation history.
 *
 * @param {string} message               - The current message from the user.
 * @param {Object[]} conversationHistory - The array of prior messages (last 6 maximum).
 *                                         Each is { role: 'user' | 'model', content: string }.
 * @param {Object[]} invoiceContext      - Array of relevant invoice database objects.
 * @returns {Promise<string>}            - The text response from Gemini.
 */
const chatWithAgent = async (message, conversationHistory, invoiceContext) => {
  // ── Input guards (returning a friendly fallback message instead of throwing) ──
  if (typeof message !== 'string' || !message.trim()) {
    return "I didn't receive a message. How can I help you today?";
  }
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const context = Array.isArray(invoiceContext) ? invoiceContext : [];

  ensureApiKey();

  try {
    // 1. Format conversation history as "User: ... / Assistant: ..." string
    const historyStr = history
      .map(msg => {
        const roleName = msg.role === 'user' ? 'User' : 'Assistant';
        const textContent = msg.content || msg.text || '';
        return `${roleName}: ${textContent.trim()}`;
      })
      .join('\n');

    // 2. Sanitise invoice context fields to reduce token usage
    const sanitise = (inv) => {
      // eslint-disable-next-line no-unused-vars
      const { rawGeminiResponse, filePath, storedFileName, __v, ...safe } = inv;
      return safe;
    };
    const cleanContext = context.map(sanitise);

    // 3. Build the full prompt using the exact user-specified template
    const fullPrompt = `You are an Invoice Assistant Agent for a company's finance team. You have access to the company's invoice records and must answer questions helpfully, accurately, and concisely.

You will be given:
1. Conversation history (previous messages between you and the user)
2. Relevant invoice data as JSON context

Your capabilities:
- Answer questions about spending, vendors, totals, and trends using ONLY the invoice data provided in context
- Summarize risk flags and explain why an invoice was flagged
- Compare spending across vendors or time periods if data allows
- If asked something the provided context can't answer, say so clearly instead of guessing

Rules:
1. Never invent numbers or vendor names not present in the provided invoice data.
2. Keep answers conversational but precise — use actual figures from the data.
3. If the user asks to "show" or "list" invoices, format them as a clean bullet list (vendor, amount, date, risk level).
4. If context is insufficient to answer, respond: "I don't have enough invoice data to answer that — could you upload more invoices or rephrase your question?"
5. Do not perform any actions outside answering questions (no deleting, no approving).
6. Keep responses under 150 words unless the user asks for a detailed breakdown.

Conversation history:
${historyStr || 'No previous conversation history.'}

Relevant invoice data:
${JSON.stringify(cleanContext, null, 2)}

User's question:
${message.trim()}`;

    // 4. Initialise model and call generateContent
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: SAFETY_SETTINGS
    });

    const result = await model.generateContent(fullPrompt);
    return result.response.text();
  } catch (err) {
    console.error('[chatWithAgent] Error calling Gemini:', err.message);
    return "I don't have enough invoice data to answer that — could you upload more invoices or rephrase your question?";
  }
};

// ─── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  extractInvoiceData,
  detectAnomalies,
  askAboutInvoice,
  chatWithAgent,
  // Exposed for unit testing
  _internals: {
    bufferToGenerativePart,
    stripCodeFences,
    validateParsed,
    validateAnomalyResult,
    EXTRACTION_PROMPT,
    ANOMALY_PROMPT,
    MODEL_NAME,
  },
};
