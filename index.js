/** 
 * Multi-Session WhatsApp Bot
 * Based on Knight Bot by Professor
 * Modified for multi-user support
 */

require('./settings');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const FileType = require('file-type');
const path = require('path');
const axios = require('axios');
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber');
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif');
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, sleep, reSize } = require('./lib/myfunc');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    generateForwardMessageContent, 
    prepareWAMessageMedia, 
    generateWAMessageFromContent, 
    generateMessageID, 
    downloadContentFromMessage, 
    jidDecode, 
    proto, 
    jidNormalizedUser, 
    makeCacheableSignalKeyStore,
    delay 
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const pino = require("pino");
const readline = require("readline");
const { parsePhoneNumber } = require("libphonenumber-js");
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics');
const { rmSync, existsSync } = require('fs');
const { join } = require('path');

// Import lightweight store
const store = require('./lib/lightweight_store');
store.readFromFile();

const settings = require('./settings');
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

// Memory optimization
setInterval(() => {
    if (global.gc) {
        global.gc();
        console.log('🧹 Garbage collection completed');
    }
}, 60_000);

// Active sessions storage
const activeSessions = new Map();
const sessionRetries = new Map();
const MAX_RETRIES = 3;

global.botname = "KNIGHT BOT";
global.themeemoji = "•";

// Multi-session pairing
const pairingCode = true;
const useMobile = false;

/**
 * Start a bot session for a specific phone number
 * @param {string} phoneNumber - User's phone number
 * @param {string} sessionId - Unique session identifier
 * @returns {Promise<Object>} Bot instance
 */
async function startBotSession(phoneNumber, sessionId) {
    try {
        // Check if session already exists
        if (activeSessions.has(sessionId)) {
            console.log(chalk.yellow(`⚠️ Session ${sessionId} already active`));
            return activeSessions.get(sessionId);
        }

        const sessionPath = `./sessions/${sessionId}`;
        
        // Create session directory if it doesn't exist
        if (!existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        let { version, isLatest } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const msgRetryCounterCache = new NodeCache();

        const XeonBotInc = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !pairingCode,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        // Save credentials when they update
        XeonBotInc.ev.on('creds.update', saveCreds);
        
        // Bind store
        store.bind(XeonBotInc.ev);

        // Store session info
        XeonBotInc.sessionId = sessionId;
        XeonBotInc.phoneNumber = phoneNumber;

        // Message handling
        XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;
                
                mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') 
                    ? mek.message.ephemeralMessage.message 
                    : mek.message;
                
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    await handleStatus(XeonBotInc, chatUpdate);
                    return;
                }

                if (!XeonBotInc.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
                    const isGroup = mek.key?.remoteJid?.endsWith('@g.us');
                    if (!isGroup) return;
                }

                if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

                if (XeonBotInc?.msgRetryCounterCache) {
                    XeonBotInc.msgRetryCounterCache.clear();
                }

                try {
                    await handleMessages(XeonBotInc, chatUpdate, true);
                } catch (err) {
                    console.error(`[${sessionId}] Error in handleMessages:`, err);
                    if (mek.key && mek.key.remoteJid) {
                        await XeonBotInc.sendMessage(mek.key.remoteJid, {
                            text: '❌ An error occurred while processing your message.',
                        }).catch(console.error);
                    }
                }
            } catch (err) {
                console.error(`[${sessionId}] Error in messages.upsert:`, err);
            }
        });

        // Contact updates
        XeonBotInc.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        XeonBotInc.ev.on('contacts.update', update => {
            for (let contact of update) {
                let id = XeonBotInc.decodeJid(contact.id);
                if (store && store.contacts) store.contacts[id] = { id, name: contact.notify };
            }
        });

        XeonBotInc.getName = (jid, withoutContact = false) => {
            id = XeonBotInc.decodeJid(jid);
            withoutContact = XeonBotInc.withoutContact || withoutContact;
            let v;
            if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
                v = store.contacts[id] || {};
                if (!(v.name || v.subject)) v = XeonBotInc.groupMetadata(id) || {};
                resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'));
            });
            else v = id === '0@s.whatsapp.net' ? { id, name: 'WhatsApp' } 
                : id === XeonBotInc.decodeJid(XeonBotInc.user.id) ? XeonBotInc.user 
                : (store.contacts[id] || {});
            return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international');
        };

        XeonBotInc.public = true;
        XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store);

        // Handle pairing code
        if (pairingCode && !XeonBotInc.authState.creds.registered) {
            if (useMobile) throw new Error('Cannot use pairing code with mobile api');

            let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
            
            const pn = require('awesome-phonenumber');
            if (!pn('+' + cleanPhone).isValid()) {
                console.log(chalk.red(`[${sessionId}] Invalid phone number`));
                throw new Error('Invalid phone number');
            }

            setTimeout(async () => {
                try {
                    let code = await XeonBotInc.requestPairingCode(cleanPhone);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    console.log(chalk.bgGreen(chalk.black(`[${sessionId}] Pairing Code: `)), chalk.white(code));
                    
                    // Save pairing code to session
                    const pairingData = {
                        sessionId,
                        phoneNumber: cleanPhone,
                        code,
                        timestamp: Date.now(),
                        status: 'pending'
                    };
                    
                    fs.writeFileSync(
                        path.join(sessionPath, 'pairing.json'),
                        JSON.stringify(pairingData, null, 2)
                    );
                    
                    // Return code for web display
                    if (global.pairingCallbacks && global.pairingCallbacks[sessionId]) {
                        global.pairingCallbacks[sessionId](code);
                    }
                    
                } catch (error) {
                    console.error(`[${sessionId}] Error requesting pairing code:`, error);
                    throw error;
                }
            }, 3000);
        }

        // Connection handling
        XeonBotInc.ev.on('connection.update', async (s) => {
            const { connection, lastDisconnect, qr } = s;
            
            if (connection === 'connecting') {
                console.log(chalk.yellow(`[${sessionId}] 🔄 Connecting...`));
            }

            if (connection == "open") {
                console.log(chalk.green(`[${sessionId}] ✅ Connected Successfully!`));
                
                // Reset retry counter
                sessionRetries.delete(sessionId);
                
                // Store active session
                activeSessions.set(sessionId, XeonBotInc);
                
                // Update pairing status
                const pairingFile = path.join(sessionPath, 'pairing.json');
                if (existsSync(pairingFile)) {
                    const pairingData = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
                    pairingData.status = 'connected';
                    pairingData.connectedAt = Date.now();
                    fs.writeFileSync(pairingFile, JSON.stringify(pairingData, null, 2));
                }
                
                try {
                    const botNumber = XeonBotInc.user.id.split(':')[0] + '@s.whatsapp.net';
                    await XeonBotInc.sendMessage(botNumber, {
                        text: `🤖 Bot Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!`
                    });
                } catch (error) {
                    console.error(`[${sessionId}] Error sending connection message:`, error.message);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(chalk.red(`[${sessionId}] Connection closed. Code: ${statusCode}`));
                
                // Remove from active sessions
                activeSessions.delete(sessionId);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    try {
                        rmSync(sessionPath, { recursive: true, force: true });
                        console.log(chalk.yellow(`[${sessionId}] Session deleted. Re-authentication required.`));
                    } catch (error) {
                        console.error(`[${sessionId}] Error deleting session:`, error);
                    }
                    sessionRetries.delete(sessionId);
                    return;
                }

                if (shouldReconnect) {
                    const retries = sessionRetries.get(sessionId) || 0;
                    
                    if (retries >= MAX_RETRIES) {
                        console.log(chalk.red(`[${sessionId}] Max retries reached. Session abandoned.`));
                        rmSync(sessionPath, { recursive: true, force: true });
                        sessionRetries.delete(sessionId);
                        return;
                    }
                    
                    sessionRetries.set(sessionId, retries + 1);
                    console.log(chalk.yellow(`[${sessionId}] Reconnecting... Attempt ${retries + 1}/${MAX_RETRIES}`));
                    
                    await delay(5000);
                    startBotSession(phoneNumber, sessionId);
                }
            }
        });

        XeonBotInc.ev.on('group-participants.update', async (update) => {
            await handleGroupParticipantUpdate(XeonBotInc, update);
        });

        return XeonBotInc;

    } catch (error) {
        console.error(`[${sessionId}] Error in startBotSession:`, error);
        throw error;
    }
}

/**
 * Get active session by ID
 */
function getSession(sessionId) {
    return activeSessions.get(sessionId);
}

/**
 * Get all active sessions
 */
function getAllSessions() {
    return Array.from(activeSessions.keys());
}

/**
 * Delete a session
 */
async function deleteSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        try {
            await session.logout();
        } catch (e) {
            console.error(`Error logging out session ${sessionId}:`, e);
        }
        activeSessions.delete(sessionId);
    }
    
    const sessionPath = `./sessions/${sessionId}`;
    if (existsSync(sessionPath)) {
        rmSync(sessionPath, { recursive: true, force: true });
    }
    
    sessionRetries.delete(sessionId);
    console.log(chalk.green(`✅ Session ${sessionId} deleted`));
}

/**
 * Check if session exists and is connected
 */
function isSessionActive(sessionId) {
    return activeSessions.has(sessionId);
}

/**
 * Get session info
 */
function getSessionInfo(sessionId) {
    const sessionPath = `./sessions/${sessionId}`;
    const pairingFile = path.join(sessionPath, 'pairing.json');
    
    if (existsSync(pairingFile)) {
        return JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
    }
    
    return null;
}

module.exports = {
    startBotSession,
    getSession,
    getAllSessions,
    deleteSession,
    isSessionActive,
    getSessionInfo
};

// Handle process termination
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️ Shutting down all sessions...'));
    for (const [sessionId, session] of activeSessions) {
        try {
            await session.logout();
        } catch (e) {}
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});