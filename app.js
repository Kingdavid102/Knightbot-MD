// app.js - Unified server for Heroku deployment
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session management
const activeSessions = new Map();
const MAX_SESSIONS = 50;

// Import bot functionality
const { startBotSession } = require('./index');

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to request pairing code
app.post('/api/pair', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number is required' 
            });
        }

        // Clean phone number
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        if (cleanPhone.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }

        // Check session limit
        if (activeSessions.size >= MAX_SESSIONS) {
            return res.status(429).json({
                success: false,
                error: `Session limit reached. Maximum ${MAX_SESSIONS} sessions allowed.`,
                limit: MAX_SESSIONS,
                current: activeSessions.size
            });
        }

        const sessionId = `session_${cleanPhone}_${Date.now()}`;
        
        console.log(chalk.blue(`📱 New pairing request for ${cleanPhone} - Session: ${sessionId}`));

        // Start bot session
        try {
            const sock = await startBotSession(cleanPhone, sessionId);
            activeSessions.set(sessionId, {
                phoneNumber: cleanPhone,
                session: sock,
                createdAt: new Date(),
                status: 'active'
            });

            res.json({
                success: true,
                sessionId,
                phoneNumber: cleanPhone,
                message: 'Session created successfully'
            });
        } catch (error) {
            console.error(`Error starting session:`, error);
            res.status(500).json({
                success: false,
                error: 'Failed to start session'
            });
        }

    } catch (error) {
        console.error('Error in /api/pair:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.entries()).map(([sessionId, data]) => ({
        sessionId,
        phoneNumber: data.phoneNumber,
        status: data.status,
        createdAt: data.createdAt
    }));
    
    res.json({
        success: true,
        count: sessions.length,
        limit: MAX_SESSIONS,
        sessions
    });
});

// Remove a session
app.delete('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    if (!activeSessions.has(sessionId)) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
    
    const session = activeSessions.get(sessionId);
    
    try {
        // Close WebSocket connection if exists
        if (session.session && session.session.ws) {
            session.session.ws.close();
        }
        
        // Remove session folder
        const sessionPath = path.join(__dirname, 'sessions', sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        activeSessions.delete(sessionId);
        
        res.json({
            success: true,
            message: 'Session removed successfully'
        });
    } catch (error) {
        console.error(`Error removing session ${sessionId}:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to remove session'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'online',
        uptime: process.uptime(),
        activeSessions: activeSessions.size,
        memory: process.memoryUsage()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(chalk.green(`\n✅ WhatsApp Multi-Session Server Started`));
    console.log(chalk.cyan(`🌐 Web Interface: http://localhost:${PORT}`));
    console.log(chalk.yellow(`📱 Session limit: ${MAX_SESSIONS} concurrent sessions\n`));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️ Shutting down...'));
    
    // Close all active sessions
    for (const [sessionId, data] of activeSessions) {
        try {
            if (data.session && data.session.ws) {
                await data.session.ws.close();
            }
        } catch (e) {
            console.error(`Error closing session ${sessionId}:`, e);
        }
    }
    
    process.exit(0);
});