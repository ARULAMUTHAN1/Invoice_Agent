'use strict';

/**
 * services/vectorStore.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight in-process vector store for semantic invoice search.
 *
 * Strategy
 * ─────────
 * • Embeddings (768-dim float32 from Gemini text-embedding-004) are stored
 *   alongside each invoice in MongoDB (`embedding` field).
 * • On startup the store is seeded from MongoDB so no separate vector DB
 *   server is required — zero extra infrastructure.
 * • Similarity search uses cosine distance; top-K results are returned with
 *   their MongoDB _id so the caller can fetch full documents.
 *
 * Public API
 * ──────────
 *   upsert(id, vector)               → void
 *   remove(id)                       → void
 *   search(queryVector, topK = 5)    → [{ id, score }]
 *   seed(invoiceArray)               → void   (bulk-load at startup)
 *   size()                           → number
 */

// ─── Internal store ────────────────────────────────────────────────────────
// Map<string, Float32Array>  — id → normalised embedding vector
const store = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compute the L2 norm (Euclidean length) of a vector.
 * @param {number[]} v
 * @returns {number}
 */
const norm = (v) => {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
};

/**
 * Normalise a vector in-place so that ||v|| = 1.
 * Pre-normalising lets dot-product ≡ cosine similarity.
 * @param {number[]} v
 * @returns {Float32Array}
 */
const normalise = (v) => {
  const n = norm(v);
  const out = new Float32Array(v.length);
  if (n === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};

/**
 * Dot product of two Float32Arrays of equal length.
 * When both vectors are normalised this equals cosine similarity ∈ [-1, 1].
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert or update a vector in the store.
 *
 * @param {string}   id     - MongoDB _id string (used as the lookup key).
 * @param {number[]} vector - Raw embedding array from Gemini (768 dimensions).
 */
const upsert = (id, vector) => {
  if (!id || !Array.isArray(vector) || vector.length === 0) {
    console.warn('[vectorStore.upsert] Skipped — invalid id or empty vector.');
    return;
  }
  store.set(String(id), normalise(vector));
};

/**
 * Remove a vector from the store (call when an invoice is deleted).
 *
 * @param {string} id
 */
const remove = (id) => {
  store.delete(String(id));
};

/**
 * Find the top-K most similar vectors to a query vector using cosine similarity.
 *
 * @param {number[]} queryVector  - Raw embedding from Gemini.
 * @param {number}   [topK=5]     - Number of results to return.
 * @returns {{ id: string, score: number }[]}  - Sorted best-first.
 */
const search = (queryVector, topK = 5) => {
  if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
  if (store.size === 0) return [];

  const q = normalise(queryVector);
  const results = [];

  store.forEach((vec, id) => {
    if (vec.length !== q.length) return; // dimension mismatch — skip
    results.push({ id, score: dot(q, vec) });
  });

  // Sort descending by cosine similarity, return top-K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
};

/**
 * Bulk-load the vector store from MongoDB invoice documents.
 * Safe to call on startup — documents with no embedding are silently skipped.
 *
 * @param {{ _id: object|string, embedding: number[]|null }[]} invoiceArray
 */
const seed = (invoiceArray) => {
  let loaded = 0;
  for (const inv of invoiceArray) {
    if (inv.embedding && Array.isArray(inv.embedding) && inv.embedding.length > 0) {
      upsert(String(inv._id), inv.embedding);
      loaded++;
    }
  }
  console.log(`[vectorStore] Seeded ${loaded} / ${invoiceArray.length} invoices from MongoDB.`);
};

/**
 * Return the number of vectors currently in the store.
 * @returns {number}
 */
const size = () => store.size;

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = { upsert, remove, search, seed, size };
