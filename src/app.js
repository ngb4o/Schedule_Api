const express = require('express')
const { default: helmet } = require('helmet')
const morgan = require('morgan')
const compression = require('compression')
const cors = require('cors')
const cron = require('node-cron')
const axios = require('axios')
const crypto = require('crypto')
const { DateTime } = require('luxon')

const app = express()
const AutoScheduleConfig = require('./models/autoScheduleConfig.model')
const CronLock = require('./models/cronLock.model')

const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Ho_Chi_Minh'

// ─── ENCRYPTION ───────────────────────────────────────────────────────────────
const ALGO = 'aes-256-cbc'
const SECRET = process.env.TOKEN_SECRET || 'default_secret_change_this_32chr!'
const ENC_KEY = crypto.scryptSync(SECRET, 'salt', 32)

function encrypt(text) {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGO, ENC_KEY, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return iv.toString('hex') + ':' + encrypted.toString('hex')
}

function decrypt(data) {
    const [ivHex, encHex] = data.split(':')
    const iv = Buffer.from(ivHex, 'hex')
    const encrypted = Buffer.from(encHex, 'hex')
    const decipher = crypto.createDecipheriv(ALGO, ENC_KEY, iv)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

// Hash cố định để làm key tìm kiếm — cùng token luôn ra cùng hash
function hashToken(text) {
    return crypto.createHmac('sha256', SECRET).update(text).digest('hex')
}

function maskToken(token) {
    if (!token || token.length < 10) return '***'
    return token.slice(0, 6) + '...' + token.slice(-4)
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(morgan('tiny'))
app.use(helmet())
app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

require('./dbs/init.mongodb')

// ─── HELPERS ──────────────────────────────────────────────────────────────────
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
        return true
    } catch (e) {
        if (e.code === 11000) return false
        console.error('acquireLock error:', e?.message)
        return false
    }
}

async function callAPI({ token, name, groupId }, isCheckIn) {
    try {
        let rawToken
        try {
            rawToken = decrypt(token)
        } catch {
            rawToken = token
        }

        let auth = String(rawToken || '').trim()
        if (!auth.toLowerCase().startsWith('beare ')) {
            auth = 'Beare ' + auth
        }

        const body = {
            being_posted_user_id: groupId,
            post_content: isCheckIn ? '' : 'out',
            file_main: {
                post_file_name: 'smile_sticker',
                post_file_path: isCheckIn
                    ? 'users/686b1f0b6754815c4e361fc7/3a56f8f0-224d-41ef-8bcc-339bb05939e4.webp'
                    : 'users/686b1f0b6754815c4e361fc7/9ffb64d5-524e-4a9b-a050-958469fa4608.webp',
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

        const postId = res.data?._id || res.data?.data?._id || '—'
        console.log(`✅ [${isCheckIn ? 'IN' : 'OUT'}] ${name} | postId: ${postId}`)
    } catch (e) {
        const status = e?.response?.status || '—'
        const msg = e?.response?.data?.message || e?.message || 'unknown'
        console.error(`❌ [${isCheckIn ? 'IN' : 'OUT'}] ${name} | ${status} — ${msg}`)
    }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.post('/save-config', async (req, res) => {
    const data = req.body || {}
    if (!data.token || !data.name || !data.group_id) {
        return res.status(400).json({ success: false, message: 'Missing required fields: token, name, group_id' })
    }

    const normalized = normalizeUserConfig(data)
    const encryptedToken = encrypt(normalized.token)
    const tokenHash = hashToken(normalized.token)

    try {
        const doc = await AutoScheduleConfig.findOneAndUpdate(
            { tokenHash },
            {
                $set: {
                    token: encryptedToken,
                    tokenHash,
                    name: normalized.name,
                    group_id: normalized.group_id,
                    schedules: normalized.schedules,
                },
            },
            { upsert: true, new: true },
        ).lean()
        console.log(`💾 Saved: ${doc.name} | token: ${maskToken(normalized.token)} | schedules: ${doc.schedules.length}`)
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

        const items = docs.map(d => ({
            ...d,
            token: maskToken(d.token),
        }))
        return res.json({ count: items.length, items })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

// ─── CRON ─────────────────────────────────────────────────────────────────────
const instanceId = process.env.pm_id ?? process.env.NODE_APP_INSTANCE ?? '0'
const isCronWorker = instanceId === '0'

if (isCronWorker) {
    console.log(`[CRON] Worker ${instanceId} — ACTIVE`)

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

            for (const cfg of configs) {
                for (const s of cfg.schedules || []) {
                    if (!Array.isArray(s.days) || !s.days.includes(today)) continue
                    const groupId = s.group_id || cfg.group_id

                    if (s.checkin_time === nowTime) {
                        const lockKey = `checkin:${cfg._id}:${todayKey}:${nowTime}`
                        const ok = await acquireLock(lockKey)
                        if (ok) {
                            console.log(`🚀 CHECKIN → ${cfg.name} lúc ${nowTime}`)
                            await callAPI({ token: cfg.token, name: cfg.name, groupId }, true)
                        }
                    }

                    if (s.checkout_time === nowTime) {
                        const lockKey = `checkout:${cfg._id}:${todayKey}:${nowTime}`
                        const ok = await acquireLock(lockKey)
                        if (ok) {
                            console.log(`🚀 CHECKOUT → ${cfg.name} lúc ${nowTime}`)
                            await callAPI({ token: cfg.token, name: cfg.name, groupId }, false)
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Cron error:', e?.message || e)
        }
    })

    // ─── KEEP ALIVE ───────────────────────────────────────────────────────────
    const APP_URL = process.env.APP_URL || ''
    if (APP_URL) {
        cron.schedule('*/14 * * * *', () => {
            const start = Date.now()
            axios.get(APP_URL + '/health', { timeout: 30000 })
                .then(r => console.log(`🏓 Ping OK (${r.status}) — ${Date.now() - start}ms`))
                .catch(err => console.error(`❌ Ping failed: ${err.message}`))
        }, { timezone: 'Asia/Ho_Chi_Minh' })
        console.log(`🏓 Keep-alive → ${APP_URL}/health mỗi 14 phút`)
    }

} else {
    console.log(`[CRON] Worker ${instanceId} — DISABLED`)
}

app.use('/', require('./routes'))

module.exports = app