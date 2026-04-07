'use strict'
 
const { Schema, model } = require('mongoose')
 
const CrmScheduleSchema = new Schema(
    {
        checkin_time:  { type: String, default: null },
        checkout_time: { type: String, default: null },
        days:          { type: [Number], default: [] },
    },
    { _id: false },
)
 
const CrmScheduleConfigSchema = new Schema(
    {
        cookieHash: { type: String, required: true, unique: true, index: true },
        cookie:     { type: String, required: true },  // AES encrypted
        csrf:       { type: String, required: true },  // AES encrypted
        staffId:    { type: String, required: true },
        name:       { type: String, default: '' },
        enabled:    { type: Boolean, default: true },
        schedules:  { type: [CrmScheduleSchema], default: [] },
    },
    { timestamps: true, collection: 'crm_schedule_configs' },
)
 
module.exports = model('CrmScheduleConfig', CrmScheduleConfigSchema)