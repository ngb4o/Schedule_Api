'use strict'

const mongoose = require('mongoose')
const os = require('os')
const process = require('process')
const _SECOND = 5000

// Count connect
const countConnect = () => {
    const numConnection = mongoose.connections.length
    console.log(`Number connection: ${numConnection}`)
}

// Check over load
const checkOverLoad = () => {
    setInterval(() => {
        const numConnection = mongoose.connections.length
        const numCores = os.cpus().length
        const memoryUsage = process.memoryUsage().rss
        // Example maximum number of connections based on number of cores
        const maxConnections = numCores * 5

        console.log(`Active connections: ${numConnection}`)
        console.log(`Memory usage: ${memoryUsage / 1024 / 1024} MB`)

        if(numConnection > maxConnections) {
            console.log(`Connection overload detected`)
        }
    }, _SECOND) // Monitor every 5 seconds
}

module.exports = {
    countConnect,
    checkOverLoad
}