'use strict'

// !dmbg
const { model, Schema, Types } = require('mongoose'); // Erase if already required

const DOCUMENT_NAME = 'Shop'
const COLLECTION_NAME = 'Shops'

// Declare the Schema of the Mongo model
var shopSchema = new Schema({
    name: {
        type: String,
        trim: true,
        maxLength: 150
    },
    email: {
        type: String,
        required: true,
        trim: true
    },
    mobile: {
        type: String,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'inactive'
    },
    verify: {
        type: Schema.Types.Boolean,
        default: false
    },
    roles: {
        type: Array,
        default: []
    }
}, {
    timestamps: true,
    collection: COLLECTION_NAME
});

// indexes
shopSchema.index({ email: 1 }, { unique: true });
// Chỉ unique khi mobile có giá trị (khác null và khác undefined)
shopSchema.index(
    { mobile: 1 },
    { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } }
);

//Export the model
module.exports = model(DOCUMENT_NAME, shopSchema)