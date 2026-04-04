const express = require('express')
const { default: helmet } = require('helmet')
const morgan = require('morgan')
const compression = require('compression')
const cors = require('cors')
const cron = require('node-cron')
const axios = require('axios')
const { DateTime } = require('luxon')

const app = express()
const AutoScheduleConfig = require('./models/autoScheduleConfig.model')
const CronLock = require('./models/cronLock.model')

const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Ho_Chi_Minh'

app.use(morgan('dev'))
app.use(helmet())
app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

require('./dbs/init.mongodb')

function normalizeUserConfig(data) {
    const u = { ...data }
    if (!Array.isArray(u.schedules) || u.schedules.length === 0) {
        if (u.checkin_time && u.checkout_time && Array.isArray(u.days)) {
            u.schedules = [{
                checkin_time: u.checkin_time,
                checkout_time: u.checkout_time,
                days: u.days,
            }]
        } else {
            u.schedules = []
        }
    }
    u.schedules = u.schedules
        .filter((s) => s && (s.checkin_time || s.checkout_time))
        .map((s) => ({
            checkin_time: s.checkin_time,
            checkout_time: s.checkout_time,
            days: Array.isArray(s.days) ? s.days : [],
            group_id: s.group_id || null,
        }))
    return u
}

function getNowTime() {
    return DateTime.now().setZone(SCHEDULE_TZ).toFormat('HH:mm')
}

function getDay() {
    return DateTime.now().setZone(SCHEDULE_TZ).weekday
}

async function acquireLock(key) {
    try {
        await CronLock.collection.insertOne({ key, createdAt: new Date() })
        console.log(`🔒 LOCK ACQUIRED: ${key}`)
        return true
    } catch (e) {
        if (e.code === 11000) {
            console.log(`⛔ LOCK EXISTS (skip): ${key}`)
            return false
        }
        console.error('acquireLock unexpected error:', e?.message)
        return false
    }
}

async function callAPI({ token, name, groupId }, isCheckIn) {
    try {
        let auth = String(token || '').trim()
        if (!auth.toLowerCase().startsWith('beare ')) {
            auth = 'Beare ' + auth
        }

        const body = {
            being_posted_user_id: groupId,
            post_content: isCheckIn ? '' : 'out',
            file_main: {
                post_file_name: 'checkin_sticker',
                post_file_path: 'users/66168f226004740c78af3751/282380a3-2d76-4f19-828e-0a869c2e8fd6.png',
                post_file_type: 'image/jpeg',
            },
            fileList: [],
            post_background: {},
            post_effect: {},
            post_privacy: 'public',
            list_friends_allowed: [],
            list_friends_excepted: [],
            post_place: {
                geometry: {
                    location: { lat: 16.070499364870287, lng: 108.168304369952 },
                },
                name: `Tại vị trí của ${name}`,
            },
            feed_type: 'normal',
            post_plugins: isCheckIn
                ? ['image', 'checkin', 'sticker', 'logtime_in']
                : ['image', 'checkin', 'sticker', 'logtime_out'],
            ref_type: 'message',
            post_shared: {},
            schedule_config: {
                is_ai: false,
                schedule_ai_reply: false,
                schedule_post_feed: false,
                schedule_config_user_ai: null,
            },
            isShowNameOwnerMess: false,
        }

        const res = await axios.post('https://api.canvanex.com/api/posts', body, {
            headers: {
                accept: 'application/json, text/plain, */*',
                authorization: auth,
                'content-type': 'application/json',
                'x-api-version': 'v3',
                'x-custom-domain': 'one_chat',
                'x-custom-header': 'xxx',
                'x-custom-origin': 'https://vdiarybook.com',
            },
            timeout: 10000,
            maxRedirects: 0,
        })

        console.log(
            `✅ ${isCheckIn ? 'Check-in' : 'Check-out'} success for ${name}`,
            `| status: ${res.status}`,
            `| postId: ${res.data?._id || res.data?.data?._id || JSON.stringify(res.data).slice(0, 80)}`,
        )
    } catch (e) {
        console.log('❌ Error:', e?.response?.status, e?.message)

        console.log('❌ Error detail:', JSON.stringify(e?.response?.data))
    }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.post('/save-config', async (req, res) => {
    const data = req.body || {}
    if (!data.token || !data.name || !data.group_id) {
        return res.status(400).json({ success: false, message: 'Missing required fields: token, name, group_id' })
    }
    const normalized = normalizeUserConfig(data)
    try {
        const doc = await AutoScheduleConfig.findOneAndUpdate(
            { token: normalized.token },
            {
                $set: {
                    token: normalized.token,
                    name: normalized.name,
                    group_id: normalized.group_id,
                    schedules: normalized.schedules,
                },
            },
            { upsert: true, new: true },
        ).lean()
        console.log('Saved config:', doc.name, `(${doc.schedules.length} schedules)`)
        return res.json({ success: true, schedules: doc.schedules.length })
    } catch (e) {
        console.error('Save config error:', e?.message || e)
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

app.get('/health', (_req, res) => {
    const t = DateTime.now().setZone(SCHEDULE_TZ)
    return res.json({
        ok: true,
        scheduleTz: SCHEDULE_TZ,
        nowTime: t.toFormat('HH:mm'),
        weekday: t.weekday,
        weekdayNote: '1=T2 … 7=CN (Luxon ISO weekday)',
    })
})

app.get('/configs', async (_req, res) => {
    try {
        const docs = await AutoScheduleConfig.find(
            {},
            { token: 1, name: 1, group_id: 1, schedules: 1, updatedAt: 1 },
        ).sort({ updatedAt: -1 }).lean()
        return res.json({ count: docs.length, items: docs })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

// ─── CRON ─────────────────────────────────────────────────────────────────────
const instanceId = process.env.pm_id ?? process.env.NODE_APP_INSTANCE ?? '0'
const isCronWorker = instanceId === '0'

if (isCronWorker) {
    console.log(`[CRON] Worker ${instanceId} — cron ACTIVE`)

    cron.schedule('* * * * *', async () => {
        const nowTime = getNowTime()
        const today = getDay()
        const todayKey = DateTime.now().setZone(SCHEDULE_TZ).toISODate()

        try {
            const configs = await AutoScheduleConfig.find(
                { schedules: { $exists: true, $ne: [] } },
                { token: 1, name: 1, group_id: 1, schedules: 1 },
            ).lean()

            if (!configs.length) return

            console.log(`Checking... ${nowTime} (${SCHEDULE_TZ}, weekday=${today})`)

            for (const cfg of configs) {
                for (const s of cfg.schedules || []) {
                    if (!Array.isArray(s.days) || !s.days.includes(today)) continue
                    const groupId = s.group_id || cfg.group_id

                    if (s.checkin_time === nowTime) {
                        const lockKey = `checkin:${cfg._id}:${todayKey}:${nowTime}`
                        const ok = await acquireLock(lockKey)
                        if (ok) {
                            console.log('🚀 RUN CHECKIN', cfg.name)
                            await callAPI({ token: cfg.token, name: cfg.name, groupId }, true)
                        }
                    }

                    if (s.checkout_time === nowTime) {
                        const lockKey = `checkout:${cfg._id}:${todayKey}:${nowTime}`
                        const ok = await acquireLock(lockKey)
                        if (ok) {
                            console.log('🚀 RUN CHECKOUT', cfg.name)
                            await callAPI({ token: cfg.token, name: cfg.name, groupId }, false)
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Cron error:', e?.message || e)
        }
    })
} else {
    console.log(`[CRON] Worker ${instanceId} — cron DISABLED (not primary)`)
}

app.use('/', require('./routes'))

module.exports = app