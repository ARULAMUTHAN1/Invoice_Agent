'use strict';

const mongoose = require('mongoose');

/**
 * Database Connection Health Check Middleware
 * Instantly returns 503 Service Unavailable if the MongoDB connection is offline,
 * preventing queries from buffering and timing out (10s delay).
 */
module.exports = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Database connection is currently offline. Please ensure your MongoDB service is running and accessible.',
    });
  }
  next();
};
