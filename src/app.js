'use strict'

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

// ─── MODELS ───────────────────────────────────────────────────────────────────
const AutoScheduleConfig = require('./models/autoScheduleConfig.model')
const CronLock = require('./models/cronLock.model')
const CrmScheduleConfig = require('./models/crmScheduleConfig.model.js')

const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Ho_Chi_Minh'

// ─── ENCRYPTION (dùng chung cho cả OneChat & CRM) ────────────────────────────
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

function hashValue(text) {
    return crypto.createHmac('sha256', SECRET).update(text).digest('hex')
}

function maskStr(s) {
    if (!s || s.length < 10) return '***'
    return s.slice(0, 6) + '...' + s.slice(-4)
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(morgan('tiny'))
app.use(helmet())
app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

require('./dbs/init.mongodb')

// ─── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Map() // Map<staffId, Set<res>>

app.get('/sse/checkin-status', (req, res) => {
    const { staffId } = req.query
    if (!staffId) return res.status(400).end()

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()

    if (!sseClients.has(staffId)) sseClients.set(staffId, new Set())
    sseClients.get(staffId).add(res)

    const ping = setInterval(() => res.write(': ping\n\n'), 30000)

    req.on('close', () => {
        clearInterval(ping)
        sseClients.get(staffId)?.delete(res)
    })
})

function pushCheckinEvent(staffId, payload) {
    const clients = sseClients.get(String(staffId))
    if (!clients?.size) return
    const data = `data: ${JSON.stringify(payload)}\n\n`
    clients.forEach(res => res.write(data))
}

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────
function getNowTime() {
    return DateTime.now().setZone(SCHEDULE_TZ).toFormat('HH:mm')
}

function getDay() {
    return DateTime.now().setZone(SCHEDULE_TZ).weekday // 1=T2…7=CN
}

function getTodayKey() {
    return DateTime.now().setZone(SCHEDULE_TZ).toISODate()
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ONECHAT — helpers & routes
// ═══════════════════════════════════════════════════════════════════════════════

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

// ── Default location ──────────────────────────────────────────────────────────
const DEFAULT_LAT = 16.070499364870287
const DEFAULT_LNG = 108.168304369952

async function callOneChatAPI({ token, name, groupId, lat, lng }, isCheckIn) {
    const finalLat = lat ?? DEFAULT_LAT
    const finalLng = lng ?? DEFAULT_LNG

    try {
        let rawToken
        try { rawToken = decrypt(token) } catch { rawToken = token }

        let auth = String(rawToken || '').trim()
        if (!auth.toLowerCase().startsWith('beare ')) auth = 'Beare ' + auth

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
                    location: { lat: finalLat, lng: finalLng },
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
        console.log(`✅ [OneChat ${isCheckIn ? 'IN' : 'OUT'}] ${name} | postId: ${postId}`)
    } catch (e) {
        const status = e?.response?.status || '—'
        const msg = e?.response?.data?.message || e?.message || 'unknown'
        console.error(`❌ [OneChat ${isCheckIn ? 'IN' : 'OUT'}] ${name} | ${status} — ${msg}`)
    }
}

// ── OneChat routes ────────────────────────────────────────────────────────────
app.post('/save-config', async (req, res) => {
    const data = req.body || {}
    if (!data.token || !data.name || !data.group_id) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: token, name, group_id',
        })
    }

    const normalized = normalizeUserConfig(data)
    const encryptedToken = encrypt(normalized.token)
    const tokenHash = hashValue(normalized.token)

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
                    ...(data.lat != null && { lat: Number(data.lat) }),
                    ...(data.lng != null && { lng: Number(data.lng) }),
                },
            },
            { upsert: true, new: true },
        ).lean()
        console.log(`💾 [OneChat] Saved: ${doc.name} | token: ${maskStr(normalized.token)} | schedules: ${doc.schedules.length} | lat: ${doc.lat} | lng: ${doc.lng}`)
        return res.json({ success: true, schedules: doc.schedules.length, lat: doc.lat, lng: doc.lng })
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
            { token: 1, name: 1, group_id: 1, schedules: 1, lat: 1, lng: 1, updatedAt: 1 },
        ).sort({ updatedAt: -1 }).lean()
        const items = docs.map((d) => ({ ...d, token: maskStr(d.token) }))
        return res.json({ count: items.length, items })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

// ═══════════════════════════════════════════════════════════════════════════════
//  CRM — helpers & routes
// ═══════════════════════════════════════════════════════════════════════════════

async function callCrmAPI({ cookie, csrf, staffId, name }, isCheckIn) {
    let rawCookie, rawCsrf
    try { rawCookie = decrypt(cookie) } catch { rawCookie = cookie }
    try { rawCsrf = decrypt(csrf) } catch { rawCsrf = csrf }

    const label = isCheckIn ? 'CHECKIN' : 'CHECKOUT'

    try {
        const res = await axios.post(
            'https://crm.vdiarybook.com/admin/timesheets/check_in_ts',
            new URLSearchParams({
                csrf_token_name: rawCsrf,
                staff_id: staffId,
                type_check: isCheckIn ? '1' : '2',
                edit_date: '',
                point_id: '',
                location_user: '',
                ...(!isCheckIn ? { today: 'Shop', tomorrow: 'Shop', hard: '' } : {}),
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': rawCookie,
                    'Referer': 'https://crm.vdiarybook.com/admin/timesheets/timekeeping',
                    'Origin': 'https://crm.vdiarybook.com',
                    'User-Agent':
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
                        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                },
                timeout: 12000,
                maxRedirects: 0,
                validateStatus: (s) => s < 400,
            },
        )
        console.log(`✅ [CRM ${label}] ${name} (staff:${staffId}) | HTTP ${res.status}`)
    } catch (e) {
        const status = e?.response?.status || '—'
        const msg = JSON.stringify(e?.response?.data || e?.message || 'unknown').slice(0, 120)
        console.error(`❌ [CRM ${label}] ${name} (staff:${staffId}) | ${status} — ${msg}`)
    }
}

// ── CRM routes ────────────────────────────────────────────────────────────────
app.post('/crm/save-config', async (req, res) => {
    const { cookie, csrf, staffId, name, enabled, schedules } = req.body || {}

    if (!cookie || !csrf || !staffId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: cookie, csrf, staffId',
        })
    }

    const normalizedSchedules = Array.isArray(schedules)
        ? schedules
            .filter((s) => s && (s.checkin_time || s.checkout_time))
            .map((s) => ({
                checkin_time: s.checkin_time || null,
                checkout_time: s.checkout_time || null,
                days: Array.isArray(s.days) ? s.days : [],
            }))
        : []

    const encCookie = encrypt(cookie)
    const encCsrf = encrypt(csrf)
    const cookieHash = hashValue(cookie)

    try {
        const doc = await CrmScheduleConfig.findOneAndUpdate(
            { cookieHash },
            {
                $set: {
                    cookie: encCookie,
                    csrf: encCsrf,
                    cookieHash,
                    staffId,
                    name: name || `Staff #${staffId}`,
                    enabled: enabled !== false,
                    schedules: normalizedSchedules,
                },
            },
            { upsert: true, new: true },
        ).lean()

        console.log(
            `💾 [CRM] Saved: ${doc.name} | staff:${staffId} | ` +
            `enabled:${doc.enabled} | schedules:${doc.schedules.length}`,
        )
        return res.json({ success: true, schedules: doc.schedules.length })
    } catch (e) {
        console.error('CRM save-config error:', e?.message || e)
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

app.get('/crm/configs', async (_req, res) => {
    try {
        const docs = await CrmScheduleConfig.find(
            {},
            { name: 1, staffId: 1, enabled: 1, schedules: 1, updatedAt: 1, cookie: 1 },
        ).sort({ updatedAt: -1 }).lean()
        const items = docs.map((d) => ({ ...d, cookie: maskStr(d.cookie), csrf: '***' }))
        return res.json({ count: items.length, items })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

app.delete('/crm/configs/:staffId', async (req, res) => {
    try {
        const result = await CrmScheduleConfig.deleteOne({ staffId: req.params.staffId })
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Not found' })
        }
        return res.json({ success: true })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

app.get('/crm/health', (_req, res) => {
    const t = DateTime.now().setZone(SCHEDULE_TZ)
    return res.json({
        ok: true,
        service: 'CRM Auto Schedule',
        scheduleTz: SCHEDULE_TZ,
        nowTime: t.toFormat('HH:mm'),
        weekday: t.weekday,
        weekdayNote: '1=T2 … 7=CN (Luxon ISO weekday)',
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
//  CRON — OneChat + CRM chạy chung mỗi phút
// ═══════════════════════════════════════════════════════════════════════════════
const instanceId = process.env.pm_id ?? process.env.NODE_APP_INSTANCE ?? '0'
const isCronWorker = instanceId === '0'

if (isCronWorker) {
    console.log(`[CRON] Worker ${instanceId} — ACTIVE (OneChat + CRM)`)

    cron.schedule('* * * * *', async () => {
        const nowTime = getNowTime()
        const today = getDay()
        const todayKey = getTodayKey()

        // ── OneChat ────────────────────────────────────────────────────────────
        try {
            const configs = await AutoScheduleConfig.find(
                { schedules: { $exists: true, $ne: [] } },
                { token: 1, name: 1, group_id: 1, schedules: 1, lat: 1, lng: 1 },
            ).lean()

            for (const cfg of configs) {
                for (const s of cfg.schedules || []) {
                    if (!Array.isArray(s.days) || !s.days.includes(today)) continue
                    const groupId = s.group_id || cfg.group_id

                    if (s.checkin_time === nowTime) {
                        const lockKey = `checkin:${cfg._id}:${todayKey}:${nowTime}`
                        if (await acquireLock(lockKey)) {
                            console.log(`🚀 [OneChat CHECKIN]  → ${cfg.name} lúc ${nowTime}`)
                            await callOneChatAPI(
                                { token: cfg.token, name: cfg.name, groupId, lat: cfg.lat, lng: cfg.lng },
                                true,
                            )
                            pushCheckinEvent(cfg._id.toString(), {
                                type: 'onechat', action: 'checkin', status: 'success',
                                name: cfg.name, time: nowTime,
                            })
                        }
                    }

                    if (s.checkout_time === nowTime) {
                        const lockKey = `checkout:${cfg._id}:${todayKey}:${nowTime}`
                        if (await acquireLock(lockKey)) {
                            console.log(`🚀 [OneChat CHECKOUT] → ${cfg.name} lúc ${nowTime}`)
                            await callOneChatAPI(
                                { token: cfg.token, name: cfg.name, groupId, lat: cfg.lat, lng: cfg.lng },
                                false,
                            )

                            pushCheckinEvent(cfg._id.toString(), {
                                type: 'onechat', action: 'checkout', status: 'success',
                                name: cfg.name, time: nowTime,
                            })
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[OneChat Cron] error:', e?.message || e)
        }

        // ── CRM ────────────────────────────────────────────────────────────────
        try {
            const crmConfigs = await CrmScheduleConfig.find(
                { enabled: true, schedules: { $exists: true, $ne: [] } },
                { cookie: 1, csrf: 1, staffId: 1, name: 1, schedules: 1 },
            ).lean()

            for (const cfg of crmConfigs) {
                for (const s of cfg.schedules || []) {
                    if (!Array.isArray(s.days) || !s.days.includes(today)) continue

                    if (s.checkin_time && s.checkin_time === nowTime) {
                        const lockKey = `crm:checkin:${cfg._id}:${todayKey}:${nowTime}`
                        if (await acquireLock(lockKey)) {
                            console.log(`🚀 [CRM CHECKIN]  → ${cfg.name} lúc ${nowTime}`)
                            await callCrmAPI(cfg, true)

                            pushCheckinEvent(cfg._id.toString(), {
                                type: 'crm', action: 'checkin', status: 'success',
                                staffId: cfg.staffId, name: cfg.name, time: nowTime,
                            })
                        }
                    }

                    if (s.checkout_time && s.checkout_time === nowTime) {
                        const lockKey = `crm:checkout:${cfg._id}:${todayKey}:${nowTime}`
                        if (await acquireLock(lockKey)) {
                            console.log(`🚀 [CRM CHECKOUT] → ${cfg.name} lúc ${nowTime}`)
                            await callCrmAPI(cfg, false)

                            pushCheckinEvent(cfg._id.toString(), {
                                type: 'crm', action: 'checkout', status: 'success',
                                staffId: cfg.staffId, name: cfg.name, time: nowTime,
                            })
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[CRM Cron] error:', e?.message || e)
        }

    }, { timezone: SCHEDULE_TZ })

    // ─── KEEP ALIVE ───────────────────────────────────────────────────────────
    const APP_URL = process.env.APP_URL || ''
    if (APP_URL) {
        cron.schedule('*/14 * * * *', () => {
            const start = Date.now()
            axios.get(`${APP_URL}/health`, { timeout: 30000 })
                .then((r) => console.log(`🏓 Ping OK (${r.status}) — ${Date.now() - start}ms`))
                .catch((err) => console.error(`❌ Ping failed: ${err.message}`))
        }, { timezone: SCHEDULE_TZ })
        console.log(`🏓 Keep-alive → ${APP_URL}/health mỗi 14 phút`)
    }

} else {
    console.log(`[CRON] Worker ${instanceId} — DISABLED`)
}

app.use('/', require('./routes'))

module.exports = app