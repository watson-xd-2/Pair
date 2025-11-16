require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const sessionsRoot = path.join(__dirname, 'generated_sessions');
if (!fs.existsSync(sessionsRoot)) fs.mkdirSync(sessionsRoot);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const pairingTasks = new Map();

app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const token = uuidv4();
    const sessionFolder = path.join(sessionsRoot, token);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const { version } = await fetchLatestBaileysVersion();
        const conn = makeWASocket({ version, auth: state, browser: Browsers.macOS('Safari'), logger: pino({ level: 'silent' }) });
        conn.ev.on('creds.update', saveCreds);
        const t = { phone, token, connected: false, code: null, zipBase64: null };
        pairingTasks.set(token, t);
        conn.ev.on('connection.update', (update) => { if (update.connection === 'open') t.connected = true; });
        const rawCode = await conn.requestPairingCode(phone);
        t.code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        setTimeout(() => { const zip = new AdmZip(); zip.addLocalFolder(sessionFolder); t.zipBase64 = zip.toBuffer().toString('base64'); pairingTasks.set(token, t); }, 2000);
        res.json({ token, message: 'pairing started', code: t.code });
    } catch (e) {
        console.error('pairing error', e?.message || e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status/:token', (req, res) => {
    const t = pairingTasks.get(req.params.token);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ phone: t.phone, code: t.code, connected: !!t.connected });
});

app.get('/api/download/:token', (req, res) => {
    const t = pairingTasks.get(req.params.token);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!t.zipBase64) return res.status(400).json({ error: 'not ready' });
    const buffer = Buffer.from(t.zipBase64, 'base64');
    res.setHeader('Content-Disposition', `attachment; filename=${t.token}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    res.send(buffer);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
