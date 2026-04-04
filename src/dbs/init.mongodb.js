'use strict'

const mongoose = require('mongoose')
const { countConnect } = require('../helpers/check.connect')

// Dùng MONGODB_URI từ env (Atlas), fallback về local
const { db: { host, port, name } } = require('../configs/config.mongodb')
const connectString = process.env.MONGODB_URI || `mongodb://${host}:${port}/${name}`

console.log(`Connect to MongoDB: ${connectString.replace(/:\/\/.*@/, '://***@')}`)

class Database {

    constructor() {
        this.connect()
    }

    connect() {
        if (1 === 1) {
            mongoose.set('debug', true)
            mongoose.set('debug', { color: true })
        }

        mongoose.connect(connectString, {
            maxPoolSize: 50
        }).then(async _ => {
            console.log(`Connected to MongoDB success`, countConnect())
            try {
                const Shop = require('../models/shop.model')
                await Shop.syncIndexes()
                const AutoScheduleConfig = require('../models/autoScheduleConfig.model')
                await AutoScheduleConfig.syncIndexes()
            } catch (err) {
                console.error('Sync indexes error:', err && err.message ? err.message : err)
            }
        })
        .catch(err => console.log(`Error connect:`, err.message))
    }

    static getInstance() {
        if (!Database.instance) {
            Database.instance = new Database()
        }
        return Database.instance
    }
}

const instanceMongodb = Database.getInstance()
module.exports = instanceMongodb