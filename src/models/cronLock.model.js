'use strict'

const mongoose = require('mongoose')

const cronLockSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 120, // TTL 120s → auto xoá
    },
})

module.exports = mongoose.model('CronLock', cronLockSchema)