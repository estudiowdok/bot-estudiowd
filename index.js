const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'EWD_BOT_2026';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const SYNC_URL = process.env.SYNC_URL || 'https://estudiowd.com.ar/bot_session_sync.php';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://bot-estudiowd.onrender.com';

let sock = null;
let currentQR = null;
let isConnected = false;
let userNumber = null;
let syncTimeout = null;

// ── Sincronización Remota de Sesión (para que Render nunca pierda la conexión) ──

// Restaurar sesión desde cPanel si el disco local fue reiniciado
async function restaurarSesionRemota() {
    try {
        const credsLocal = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsLocal)) {
            console.log('[SYNC] Credenciales locales encontradas en disco.');
            return true;
        }

        console.log('[SYNC] Buscando respaldo de sesión en el servidor cPanel...');
        const resp = await fetch(`${SYNC_URL}?action=get&token=${encodeURIComponent(API_KEY)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EstudioWDBot/1.0' }
        });
        if (!resp.ok) {
            console.log('[SYNC] Servidor de sincronización respondió con HTTP ' + resp.status);
            return false;
        }

        const data = await resp.json();
        if (data.ok && data.has_session && data.files) {
            if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

            let count = 0;
            for (const [filename, base64Content] of Object.entries(data.files)) {
                const target = path.join(AUTH_DIR, filename);
                fs.writeFileSync(target, Buffer.from(base64Content, 'base64'));
                count++;
            }
            console.log(`[SYNC] ✅ Sesión restaurada con éxito desde cPanel (${count} archivos). Reconectando sin pedir QR.`);
            return true;
        } else {
            console.log('[SYNC] No hay sesión previa guardada en cPanel. Se esperará escaneo de QR.');
            return false;
        }
    } catch (err) {
        console.error('[SYNC] Aviso al consultar respaldo remoto:', err.message);
        return false;
    }
}

// Respaldar sesión actual a cPanel
async function respaldarSesionRemota() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
        if (files.length === 0 || !files.includes('creds.json')) return;

        const bundle = {};
        for (const file of files) {
            const content = fs.readFileSync(path.join(AUTH_DIR, file));
            bundle[file] = content.toString('base64');
        }

        const resp = await fetch(SYNC_URL, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EstudioWDBot/1.0',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                token: API_KEY,
                action: 'save',
                files: bundle
            })
        });

        if (resp.ok) {
            const resJson = await resp.json();
            if (resJson.ok) {
                console.log(`[SYNC] 💾 Sesión de WhatsApp respaldada con éxito en cPanel (${files.length} archivos).`);
            }
        }
    } catch (err) {
        console.error('[SYNC] Error al respaldar sesión en cPanel:', err.message);
    }
}

function programarRespaldo() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        respaldarSesionRemota();
    }, 4000);
}

// Borrar respaldo remoto si la sesión se cerró intencionalmente
async function borrarSesionRemota() {
    try {
        await fetch(`${SYNC_URL}?action=clear&token=${encodeURIComponent(API_KEY)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EstudioWDBot/1.0' }
        });
        console.log('[SYNC] Respaldo remoto eliminado tras cierre de sesión.');
    } catch (e) {}
}

async function iniciarBot() {
    await restaurarSesionRemota();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['EstudioWD Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        programarRespaldo();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQR = await QRCode.toDataURL(qr);
            } catch (err) {
                console.error('Error generando QR:', err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            userNumber = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[BOT] Conexión cerrada. Razón código: ${statusCode}. Reconectando: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(iniciarBot, 3000);
            } else {
                console.log('[BOT] Sesión cerrada permanentemente. Limpiando credenciales...');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {}
                await borrarSesionRemota();
                setTimeout(iniciarBot, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            userNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Conectado';
            console.log(`[BOT] ✅ Conectado exitosamente a WhatsApp con el número: ${userNumber}`);
            programarRespaldo();
        }
    });
}

// Keep-Alive anti-suspensión para Render (cada 10 minutos para que nunca se duerma)
setInterval(async () => {
    try {
        const pingUrl = `${SELF_URL}/status`;
        const res = await fetch(pingUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EstudioWD-KeepAlive/1.0' }
        });
        if (res.ok) {
            console.log('[KEEP-ALIVE] Ping exitoso a Render. El servicio se mantiene despierto.');
        }
    } catch (err) {
        console.log('[KEEP-ALIVE] Ping intentado:', err.message);
    }
}, 10 * 60 * 1000);

// Normalizar número telefónico a formato WhatsApp JID
function formatearJid(numero) {
    let clean = numero.toString().replace(/\D/g, '');

    // Formato Argentina: asegurar código 549 si empieza con 11 o con 54
    if (clean.startsWith('54') && !clean.startsWith('549') && clean.length === 12) {
        // ej: 541123456789 -> 5491123456789
        clean = '549' + clean.substring(2);
    } else if (clean.length === 10) {
        // ej: 1123456789 -> 5491123456789
        clean = '549' + clean;
    } else if (!clean.startsWith('54') && clean.length === 11 && clean.startsWith('9')) {
        clean = '54' + clean;
    }

    return `${clean}@s.whatsapp.net`;
}

// Página visual del bot (Panel con QR y prueba en vivo)
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EstudioWD | WhatsApp Bot Gateway</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { background-color: #0a0a0f; color: #fff; font-family: 'Inter', sans-serif; }
        .card { background: #12121a; border: 1px solid #232332; }
        .neon-text { color: #ccff00; }
        .btn-neon { background: #ccff00; color: #0a0a0f; font-weight: 700; transition: all 0.2s; }
        .btn-neon:hover { box-shadow: 0 0 20px rgba(204,255,0,0.4); transform: translateY(-1px); }
    </style>
</head>
<body class="min-h-screen flex flex-col justify-between p-6">
    <header class="max-w-xl mx-auto w-full flex justify-between items-center py-4 border-b border-gray-800">
        <span class="text-xl font-extrabold tracking-wider">ESTUDIO<span class="neon-text">WD</span></span>
        <span class="text-xs px-3 py-1 rounded-full ${isConnected ? 'bg-green-950 text-green-400 border border-green-800' : 'bg-yellow-950 text-yellow-400 border border-yellow-800'}">
            ${isConnected ? '● CONECTADO' : '○ ESPERANDO VINCULACIÓN'}
        </span>
    </header>

    <main class="max-w-xl mx-auto w-full my-8">
        <div class="card rounded-2xl p-6 sm:p-8 shadow-2xl text-center">
            ${isConnected ? `
                <div class="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-green-500/30">
                    <svg class="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                </div>
                <h2 class="text-2xl font-black mb-2 text-white">¡WhatsApp Conectado!</h2>
                <p class="text-gray-400 text-sm mb-6">El bot está activo y listo para recibir peticiones automáticas desde tu servidor.</p>
                <div class="bg-[#181824] rounded-xl p-3 border border-gray-800 text-xs font-mono text-gray-300 mb-6">
                    Línea conectada: <span class="neon-text font-bold">+${userNumber}</span>
                </div>
            ` : `
                <h2 class="text-2xl font-black mb-2 text-white">Vincular WhatsApp</h2>
                <p class="text-gray-400 text-sm mb-6">Abrí WhatsApp en tu teléfono > <b>Dispositivos vinculados</b> > <b>Vincular un dispositivo</b> y escaneá este código:</p>
                <div class="flex justify-center mb-6">
                    ${currentQR ? `
                        <div class="p-3 bg-white rounded-2xl shadow-lg inline-block">
                            <img src="${currentQR}" alt="Código QR" class="w-64 h-64 mx-auto rounded-lg" />
                        </div>
                    ` : `
                        <div class="w-64 h-64 bg-[#181824] rounded-2xl flex flex-col items-center justify-center border border-dashed border-gray-700 text-gray-500 text-sm p-4">
                            <span class="animate-spin mb-2">⏳</span>
                            Generando código QR...
                        </div>
                    `}
                </div>
                <p class="text-xs text-gray-500">Esta página se actualiza automáticamente cada 4 segundos.</p>
                <script>setTimeout(() => location.reload(), 4000);</script>
            `}

            <!-- Formulario de prueba directa -->
            <div class="mt-8 pt-6 border-t border-gray-800 text-left">
                <h3 class="text-xs uppercase tracking-wider font-bold text-gray-400 mb-3">⚡ Enviar Mensaje de Prueba</h3>
                <form action="/send" method="POST" class="space-y-3" onsubmit="return enviarTest(event, this)">
                    <input type="hidden" name="key" value="${API_KEY}">
                    <div>
                        <input name="to" placeholder="Número (ej: 5491125411740)" required class="w-full bg-[#181824] border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#ccff00]">
                    </div>
                    <div>
                        <textarea name="message" rows="2" placeholder="Escribí un mensaje..." required class="w-full bg-[#181824] border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#ccff00]">Hola! Este es un mensaje de prueba desde EstudioWD Bot.</textarea>
                    </div>
                    <button type="submit" class="w-full btn-neon py-2.5 rounded-xl text-sm font-bold uppercase tracking-wider">Enviar prueba</button>
                    <div id="test-resp" class="text-xs mt-2 hidden"></div>
                </form>
            </div>
        </div>
    </main>

    <footer class="max-w-xl mx-auto w-full text-center text-xs text-gray-600 py-4 border-t border-gray-900">
        EstudioWD — Microservicio de Notificaciones WhatsApp
    </footer>

    <script>
        async function enviarTest(e, form) {
            e.preventDefault();
            const btn = form.querySelector('button');
            const respDiv = document.getElementById('test-resp');
            btn.disabled = true;
            btn.textContent = 'Enviando...';
            respDiv.classList.add('hidden');

            try {
                const res = await fetch('/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        key: form.key.value,
                        to: form.to.value,
                        message: form.message.value
                    })
                });
                const data = await res.json();
                respDiv.classList.remove('hidden');
                if (data.ok) {
                    respDiv.className = 'text-xs mt-2 text-green-400 font-semibold';
                    respDiv.textContent = '✔ Mensaje enviado exitosamente.';
                } else {
                    respDiv.className = 'text-xs mt-2 text-red-400 font-semibold';
                    respDiv.textContent = '✘ Error: ' + (data.error || 'No se pudo enviar');
                }
            } catch (err) {
                respDiv.classList.remove('hidden');
                respDiv.className = 'text-xs mt-2 text-red-400 font-semibold';
                respDiv.textContent = '✘ Error de conexión: ' + err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Enviar prueba';
            }
        }
    </script>
</body>
</html>
    `);
});

// Endpoint para estado JSON
app.get('/status', (req, res) => {
    res.json({
        ok: true,
        connected: isConnected,
        user: userNumber,
        has_qr: !!currentQR,
        qr: currentQR
    });
});

// Endpoint para cerrar sesión y generar nuevo QR
app.all('/logout', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch(e){}
        }
        isConnected = false;
        userNumber = null;
        currentQR = null;
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch(e){}
        setTimeout(iniciarBot, 1000);
        res.json({ ok: true, msg: 'Sesión cerrada exitosamente' });
    } catch(err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para enviar mensaje (Soporta POST y GET)
const procesarEnvio = async (req, res) => {
    const key = req.body?.key || req.query?.key || req.headers['x-api-key'];
    const to = req.body?.to || req.query?.to;
    const message = req.body?.message || req.query?.message || req.body?.text || req.query?.text;

    if (key !== API_KEY) {
        return res.status(401).json({ ok: false, error: 'API_KEY inválida' });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({ ok: false, error: 'El bot no está conectado a WhatsApp aún. Escaneá el código QR.' });
    }

    if (!to || !message) {
        return res.status(400).json({ ok: false, error: 'Faltan parámetros obligatorios: to y message' });
    }

    try {
        const jid = formatearJid(to);
        const result = await sock.sendMessage(jid, { text: message });
        return res.json({
            ok: true,
            msg: 'Mensaje enviado con éxito',
            to: jid,
            id: result?.key?.id
        });
    } catch (error) {
        console.error('[BOT] Error al enviar mensaje:', error);
        return res.status(500).json({
            ok: false,
            error: error.message || 'Error al enviar mensaje'
        });
    }
};

app.post('/send', procesarEnvio);
app.get('/send', procesarEnvio);

// Iniciar servidor y bot
app.listen(PORT, () => {
    console.log(`[BOT] Servidor escuchando en puerto ${PORT}`);
    iniciarBot();
});

