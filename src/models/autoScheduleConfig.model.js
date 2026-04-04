'use strict'

const { Schema, model } = require('mongoose')

const AutoScheduleSchema = new Schema(
  {
    checkin_time: { type: String },
    checkout_time: { type: String },
    days: { type: [Number], default: [] },
    group_id: { type: String, default: null },
  },
  { _id: false },
)

const AutoScheduleConfigSchema = new Schema(
  {
    token: { type: String, required: true },
    tokenHash: { type: String, required: true, index: true, unique: true },
    name: { type: String, required: true },
    group_id: { type: String, required: true },
    schedules: { type: [AutoScheduleSchema], default: [] },
  },
  { timestamps: true, collection: 'auto_schedule_configs' },
)

module.exports = model('AutoScheduleConfig', AutoScheduleConfigSchema)