require('dotenv').config();
const { App } = require('@slack/bolt');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const http = require('http');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// --- Render Web Service Workaround ---
// Render expects a web service to bind to a port.
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Slack Bot is Alive! 🤖');
});
server.listen(PORT, () => {
    console.log(`✅ Dummy server listening on port ${PORT} for Render health checks.`);
});


// ---------------------------
// 1. Persistence & Database
// ---------------------------
const ReminderSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    channel: String,
    thread_ts: String,
    assignee: String,
    assigneeName: String,
    created_by: String,
    creatorName: String,
    creatorAvatar: String,
    created_at: Date,
    frequencyMinutes: Number,
    priority: String,
    note: String,
    jira: String,
    status: String,
    pingCount: Number,
    dailyPingCount: Number,
    active: Boolean,
    lastSent: Date,
    eta: String,
    etaNotified: Boolean,
    blockerReason: String,
    resolved_at: Date,
    lastActivityAt: Date,
    lastAssigneeActivityAt: Date
});
const ReminderModel = mongoose.model('Reminder', ReminderSchema);

const ReportSchema = new mongoose.Schema({
    type: String,
    reminder_id: String,
    reporter: String,
    created_by: String,
    ticket: String,
    timestamp: Date
});
const ReportModel = mongoose.model('Report', ReportSchema);

const GlobalStatsSchema = new mongoose.Schema({
    key: { type: String, default: 'main' },
    reminders_created: { type: Number, default: 0 },
    channels_used: [String],
    lastAdminReportSent: Date
});
const GlobalStatsModel = mongoose.model('GlobalStats', GlobalStatsSchema);

const UserSheetSchema = new mongoose.Schema({
    userId: String,
    type: { type: String, enum: ['personal', 'admin'] },
    spreadsheetId: String,
    url: String
});
const UserSheetModel = mongoose.model('UserSheet', UserSheetSchema);

// --- In-Memory Cache (Synced with DB) ---
let reminders = [];
let adminStatsCache = { reminders_created: 0, reports: [], channels_used: [] };

// --- DB Functions ---
const saveToDb = async (allReminders) => {
    // Fire and forget sync to MongoDB
    try {
        const ops = allReminders.map(r => ({
            updateOne: {
                filter: { id: r.id },
                update: { $set: r },
                upsert: true
            }
        }));
        // Also handle deletions (items in DB but not in memory)
        const currentIds = allReminders.map(r => r.id);
        await ReminderModel.deleteMany({ id: { $nin: currentIds } });
        if (ops.length > 0) await ReminderModel.bulkWrite(ops);
    } catch (e) {
        console.error('❌ DB Save Error:', e);
    }
};

const saveReport = async (report) => {
    try {
        // Update memory
        adminStatsCache.reports.push(report);
        // Save to DB
        await new ReportModel(report).save();
    } catch (e) { console.error('Report Save Error:', e); }
};

const updateGlobalStats = async (channel) => {
    try {
        adminStatsCache.reminders_created++;
        if (!adminStatsCache.channels_used.includes(channel)) {
            adminStatsCache.channels_used.push(channel);
        }
        await GlobalStatsModel.findOneAndUpdate(
            { key: 'main' },
            {
                $inc: { reminders_created: 1 },
                $addToSet: { channels_used: channel }
            },
            { upsert: true }
        );
    } catch (e) { console.error('Stats Save Error:', e); }
};

const getAdminStats = () => {
    // Return in-memory cache (synchronous to match original signature)
    return adminStatsCache;
};

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || 'U123').split(',').map(id => id.trim()); // Set in .env
// Enforce working hours in production; removed BYPASS_WORKING_HOURS override
const DAILY_PING_LIMIT = 10; // Max pings per day per reminder
const ESCALATION_PING_THRESHOLD = 15; // Flag tickets with 15+ pings
const EFFICIENCY_SCORE_MULTIPLIER = 0.95; // Reduce score over time (per day elapsed)

const WORKING_HOURS = { start: 9, end: 18 };
const WORKING_DAYS = [1, 2, 3, 4, 5];

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// ---------------------------
// 2. Logic & Formatting Brains
// ---------------------------

const getThreadLink = (channel, ts) => `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`;

const getDiverseGreeting = (user, pingCount = 0) => {
    const morning = [
        "Good morning! Just a tiny nudge at the top of your inbox.",
        "Morning! Hope you have a coffee in hand ☕. Quick check-in on this.",
        "Rise and shine! Popping in before the day gets too busy.",
        "Hey there! Bumping this up so it doesn't get buried."
    ];

    const afternoon = [
        "A little mid-day check-in! How's it going?",
        "Afternoon nudge! Hope your day is treating you well.",
        "Just sliding in with a quick status check. No rush!",
        "Hey! Stopping by to see if there's any update here."
    ];

    const evening = [
        "Evening! Checking in before we all wrap up for the day.",
        "Wrapping up soon? Just wanted to keep this on the radar.",
        "Hey! Hope you're having a productive one. Any news on this?",
        "Just a late-day ping to see where we stand."
    ];

    const funny = [
        "I promise I'm not a stalker, just a very dedicated robot helper! 🤖",
        "knock knock! Who's there? Definitely not a finished task yet! (JK, checking in! 😂)",
        "Help me, help you, help us all! Any updates on this one?",
        "I'm like a boomerang... I keep coming back! 🪃 Status check?",
        "If this task was a pizza, would it be out of the oven yet? 🍕",
        "Just making sure this thread doesn't feel lonely out here! 🛰️"
    ];

    // Determine time-based category
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + (3600000 * 5.5));
    const hour = ist.getHours();

    let pool = funny;
    if (pingCount < 3) {
        if (hour < 12) pool = morning;
        else if (hour >= 12 && hour <= 17) pool = afternoon;
        else pool = evening;
    }

    const msg = pool[Math.floor(Math.random() * pool.length)];
    return `${msg} <@${user}>,`;
};

/**
 * GOOGLE SHEETS SERVICE
 */
/**
 * 🛡️ PRIVACY SCRUBBER: Removes PII before sending to AI
 */
const anonymizeThread = (messages) => {
    // 🛠️ Filter out automated bot noise and boilerplate
    const humanMessages = messages.filter(m => {
        const text = m.text || '';
        const botSignatures = [
            'A follow-up reminder has been set',
            'Done → Mark complete',
            'Thread Recap for',
            'Thread Synthesis',
            'crushed this',
            'crushed it',
            'Follow-up Reminder Set'
        ];
        return !botSignatures.some(sig => text.includes(sig));
    });

    return humanMessages
        .map(m => {
            let text = m.text || '';
            // ✂️ Strip standard Greetings
            text = text.replace(/^Hi <@U[A-Z0-9]+>.*?\n\n/s, '');
            
            // 🔒 Redact PII
            text = text.replace(/<@U[A-Z0-9]+>/g, '[Member]');
            text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[Email]');
            text = text.replace(/https?:\/\/\S+/g, '[Link]');
            
            // 👤 Identify Speaker
            const speaker = m.user === 'U07FPT7RN7K' ? 'Bot' : (m.user || 'User');
            return `[${speaker}]: ${text.trim()}`;
        })
        .filter(msg => msg.split(']: ')[1]?.length > 2) // Ignore nearly empty messages
        .join('\n');
};

/**
 * 🧠 AI ENGINE: Hugging Face Inference
 */
const getHFSummary = async (rawText) => {
    const token = process.env.HUGGINGFACE_API_KEY;
    if (!token) return null;

    try {
        const response = await axios.post(
            "https://router.huggingface.co/v1/chat/completions",
            {
                model: "meta-llama/Llama-3.1-8B-Instruct",
                messages: [
                    { 
                        role: "system", 
                        content: "You are a professional project manager. Summarize the provided Slack thread into a plain-text status report.\n" +
                                 "CRITICAL RULES:\n" +
                                 "1. DO NOT use any markdown formatting like **bold** or __underline__ or asterisks. Use plain text ONLY.\n" +
                                 "2. Focus ONLY on human updates, deadlines, and technical facts.\n" +
                                 "3. BE REALISTIC. If a human says a bug is fixed or unreproducible, report that as the conclusion. Do not suggest 'next steps' that contradict the human.\n" +
                                 "4. Limit to 3 short paragraphs: CONTEXT, CURRENT STATUS, and CONCLUSION.\n" +
                                 "5. Max 100 words."
                    },
                    { role: "user", content: `THREAD CONTEXT:\n${rawText}` }
                ],
                max_tokens: 400,
                temperature: 0.2
            },
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        );

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content.trim();
        }
        return null;
    } catch (e) {
        console.error('AI Brain Fail:', e.response?.data || e.message);
        return null;
    }
};

const getGoogleAuth = () => {
    let credentials;
    let rawJson = (process.env.GOOGLE_CREDENTIALS_JSON || '').trim();

    if (rawJson) {
        // 🧪 BULLETPROOF RECURSIVE UNWRAPPER: Handles double/triple-encoded strings
        let current = rawJson;
        let attempts = 0;
        while (typeof current === 'string' && attempts < 5) {
            try {
                // If it looks like a JSON string wrapped in another string, unwrap it.
                // Examples: "\"{\\\"type\\\":...}\"" or "{\"type\":...}"
                const parsed = JSON.parse(current);
                if (parsed && typeof parsed === 'object') {
                    credentials = parsed;
                    break;
                }
                current = parsed; // Keep unwrapping if it's still a string
                attempts++;
            } catch (e) {
                // Last ditch effort: basic string cleanup
                try {
                    let cleaned = current.trim();
                    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
                        cleaned = cleaned.substring(1, cleaned.length - 1);
                    }
                    cleaned = cleaned.replace(/\\"/g, '"').replace(/\\n/g, '\n');
                    credentials = JSON.parse(cleaned);
                } catch (lastErr) {
                    throw new Error(`Google Credentials Parse Error: Please ensure your GOOGLE_CREDENTIALS_JSON environment variable is valid JSON content.`);
                }
                break;
            }
        }
    } else {
        const credentialsPath = path.join(__dirname, 'google-credentials.json');
        if (fs.existsSync(credentialsPath)) {
            credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        }
    }

    if (!credentials) {
        throw new Error('Google credentials missing. Set GOOGLE_CREDENTIALS_JSON env var or add google-credentials.json to root.');
    }

    // 🛡️ PRIVATE KEY HEALER: Ensure the PEM format is strictly followed
    try {
        if (credentials.private_key) {
            // First, fix literal \n strings which are common in JSON env vars
            let key = credentials.private_key.replace(/\\n/g, '\n');

            // If it's already a proper PEM, just normalize line endings
            if (key.includes('-----BEGIN PRIVATE KEY-----')) {
                credentials.private_key = key.trim() + '\n';
            } else {
                // Nuclear DER-to-PEM conversion if it's just a raw base64 string
                const b64Body = key.replace(/\s/g, ''); // Remove all whitespace
                const derBuffer = Buffer.from(b64Body, 'base64');
                const privateKey = crypto.createPrivateKey({
                    key: derBuffer,
                    format: 'der',
                    type: 'pkcs8'
                });
                credentials.private_key = privateKey.export({
                    format: 'pem',
                    type: 'pkcs8'
                });
            }
        }
    } catch (healError) {
        console.warn('⚠️ Google Key Healer issue (likely okay if key is already PEM):', healError.message);
    }

    return new google.auth.GoogleAuth({
        credentials,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ],
    });
};

/**
 * Aesthetic Sheet Formatter
 */
const formatGoogleSheet = async (sheets, spreadsheetId, sheetId = 0) => {
    try {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [
                    // 1. Bold Headers & Background Color
                    {
                        repeatCell: {
                            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.1, green: 0.1, blue: 0.2 }, // Dark Blue
                                    textFormat: { color: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 11 },
                                    horizontalAlignment: 'CENTER'
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
                        }
                    },
                    // 2. Freeze Header Row
                    {
                        updateSheetProperties: {
                            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                            fields: 'gridProperties.frozenRowCount'
                        }
                    },
                    // 3. Auto-Resize Columns
                    {
                        autoResizeDimensions: {
                            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 20 }
                        }
                    }
                ]
            }
        });
    } catch (e) {
        console.error('⚠️ Sheet Formatting Error:', e.message);
    }
};

const createGoogleSheetReport = async (title, headers, rows, spreadsheetId = null, overwrite = true) => {
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const drive = google.drive({ version: 'v3', auth });

        let finalSpreadsheetId = spreadsheetId;
        const ADMIN_ID_ENV = process.env.ADMIN_SPREADSHEET_ID;

        // If this is an admin report and we have a master ID, use it!
        if (title.toLowerCase().includes('admin') && ADMIN_ID_ENV) {
            finalSpreadsheetId = ADMIN_ID_ENV;
        }

        let url;

        if (!finalSpreadsheetId) {
            // 1. Create Spreadsheet if new
            const spreadsheet = await sheets.spreadsheets.create({
                resource: {
                    properties: { title: `${title} - Dashboard` },
                },
            });
            finalSpreadsheetId = spreadsheet.data.spreadsheetId;
            url = spreadsheet.data.spreadsheetUrl;

            // 2. Set Permissions (Anyone with link - WRITER)
            await drive.permissions.create({
                fileId: finalSpreadsheetId,
                resource: {
                    role: 'writer',
                    type: 'anyone',
                },
            });
        } else {
            url = `https://docs.google.com/spreadsheets/d/${finalSpreadsheetId}`;
            // If overwrite is enabled, clear the sheet first
            if (overwrite) {
                await sheets.spreadsheets.values.clear({
                    spreadsheetId: finalSpreadsheetId,
                    range: 'Sheet1!A1:Z5000',
                });
            }
        }

        // 2. Write Data
        const method = overwrite ? 'update' : 'append';
        const params = {
            spreadsheetId: finalSpreadsheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [headers, ...rows],
            },
        };

        if (overwrite) {
            await sheets.spreadsheets.values.update(params);
        } else {
            await sheets.spreadsheets.values.append(params);
        }

        // 3. Apply Professional Styling
        await formatGoogleSheet(sheets, finalSpreadsheetId);

        return { spreadsheetId: finalSpreadsheetId, url };
    } catch (e) {
        console.error('❌ Google Sheets Error:', e);
        throw e;
    }
};

/**
 * MINIMALISTIC & SEXY: Task Tracker Card
 */
const buildThreadBlock = (reminder) => {
    const priorityEmojis = { Critical: '🔥', High: '⚡', Medium: '🟡', Low: '🟢' };
    const statusEmojis = {
        ACTIVE: '🟢',
        BLOCKED: '🔴',
        WAITING_ON_SA: '👤',
        RESOLVED: '✅'
    };

    let statusText = reminder.status;
    if (reminder.status === 'BLOCKED') statusText += ` - ${reminder.blockerReason}`;
    else if (reminder.status === 'WAITING_ON_SA') statusText += ` - Waiting on <@${reminder.created_by}>`;
    else if (reminder.eta) statusText = `ETA: ${reminder.eta}`;
    else if (reminder.status === 'RESOLVED') statusText = 'Completed 🎉';

    const actions = [];
    // Show Done & Blocked only when active and not blocked/waiting
    if (reminder.active && reminder.status !== 'BLOCKED' && reminder.status !== 'WAITING_ON_SA') {
        actions.push(
            { type: "button", text: { type: "plain_text", text: "Done" }, action_id: "stop_reminder", value: reminder.id, style: "primary" },
            { type: "button", text: { type: "plain_text", text: "Blocked" }, action_id: "open_blocker_modal", value: reminder.id, style: "danger" },
            { type: "button", text: { type: "plain_text", text: "ETA" }, action_id: "open_eta_modal", value: reminder.id }
        );
    } else if (!reminder.active && reminder.status !== 'RESOLVED') {
        actions.push({ type: "button", text: { type: "plain_text", text: "🚀 Resume" }, action_id: "resume_nudges", value: reminder.id });
    }

    // 🧵 Universal: Recap is always available for everyone
    actions.push({ type: "button", text: { type: "plain_text", text: "🧵 Recap" }, action_id: "request_thread_recap", value: reminder.id });

    // 📎 Contextual: Report is usually available
    actions.push({ type: "button", text: { type: "plain_text", text: "Report" }, action_id: "report_ticket", value: reminder.id });

    return [
        {
            type: "context",
            elements: [
                { type: "mrkdwn", text: `${statusEmojis[reminder.status] || '.'} <@${reminder.assignee}> - ${statusText} - Goal: ${reminder.note} - Pings: ${reminder.pingCount}${reminder.jira ? ` - <${reminder.jira}|Jira>` : ''}` }
            ]
        },
        ...(actions.length > 0 ? [{
            type: "actions",
            elements: actions
        }] : [])
    ];
};

// ---------------------------
// 3. Reporting & CSV Engine
// ---------------------------

const generateReportData = (creatorId) => {
    const myReminders = reminders.filter(r => r.created_by === creatorId);
    if (myReminders.length === 0) return null;

    const headers = ["Created At", "Assignee", "Status", "Pings", "Frequency (Min)", "ETA", "Report Reason", "Jira Link", "Slack Link", "Note"];
    const rows = myReminders.map(r => {
        const stats = getAdminStats();
        const report = (stats.reports || []).find(rep => rep.reminder_id === r.id);
        const reportReason = report ? report.type : "None";
        return [
            new Date(r.created_at).toISOString().split('T')[0],
            r.assigneeName,
            r.status,
            r.pingCount,
            r.frequencyMinutes || 'N/A',
            r.eta || 'Not Set',
            reportReason,
            r.jira || 'Not Provided',
            getThreadLink(r.channel, r.thread_ts),
            r.note
        ];
    });
    return { headers, rows };
};

// sendDashboardAndCSV supports an optional stagger offset (ms)
const jsonToCsv = (headers, rows) => {
    const csvRows = [headers.join(',')];
    for (const row of rows) {
        csvRows.push(row.map(val => {
            const escaped = ('' + val).replace(/"/g, '""');
            return `"${escaped}"`;
        }).join(','));
    }
    return csvRows.join('\n');
};

const sendDashboardAndCSV = async (userId, offsetMs = 0) => {
    const sendNow = async () => {
        const allReminders = reminders.filter(r => r.created_by === userId);
        const myThreads = allReminders.filter(r => r.active);

        if (allReminders.length === 0) {
            try {
                const dm = await app.client.conversations.open({ users: userId });
                await app.client.chat.postMessage({
                    channel: dm.channel.id,
                    text: "You don't have any reminders tracking right now. Create one with the shortcut!"
                });
            } catch (e) { console.error("Could not send empty report DM", e); }
            return;
        }

        try {
            const dm = await app.client.conversations.open({ users: userId });
            const channelId = dm.channel.id;
            const isAdmin = ADMIN_USER_IDS.includes(userId);

            const blocks = [
                { type: "header", text: { type: "plain_text", text: isAdmin ? "📊 Admin Dashboard" : "📋 Your Jira Dashboard" } }
            ];

            if (myThreads.length > 0) {
                blocks.push({ type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}>, you have *${myThreads.length}* active tasks.` } });
            } else {
                blocks.push({ type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}>, you have no active tasks, but you can view your history below.` } });
            }

            myThreads.slice(0, 5).forEach(r => {
                blocks.push({
                    type: "section",
                    fields: [
                        { type: "mrkdwn", text: `*Assignee:*\n<@${r.assignee}>` },
                        { type: "mrkdwn", text: `*Status:*\n${r.status}` },
                        { type: "mrkdwn", text: `*Link:*\n<${getThreadLink(r.channel, r.thread_ts)}|Thread>` }
                    ]
                });
            });

            await app.client.chat.postMessage({ channel: channelId, blocks, text: "Dashboard is ready" });

            const reportData = generateReportData(userId);
            if (reportData) {
                if (isAdmin) {
                    try {
                        const existing = await UserSheetModel.findOne({ userId, type: 'personal' });
                        const { spreadsheetId, url } = await createGoogleSheetReport(
                            "Personal Dashboard",
                            reportData.headers,
                            reportData.rows,
                            existing?.spreadsheetId
                        );

                        if (!existing) {
                            await new UserSheetModel({ userId, type: 'personal', spreadsheetId, url }).save();
                        }

                        await app.client.chat.postMessage({
                            channel: channelId,
                            text: `📊 *Task Data Export:* Your tasks are ready for analysis.\n🔗 <${url}|View Google Sheet>`,
                            blocks: [
                                {
                                    type: "section",
                                    text: { type: "mrkdwn", text: "📊 *Task Data Export:* Your tasks are ready for analysis." },
                                    accessory: {
                                        type: "button",
                                        text: { type: "plain_text", text: "Open Google Sheet 🔗" },
                                        url: url,
                                        action_id: "open_sheet"
                                    }
                                }
                            ]
                        });
                    } catch (sheetErr) {
                        console.error("Personal Sheet Fail", sheetErr);
                        // SILENT FALLBACK: If Sheets fail, automatically send the CSV
                        const csvContent = jsonToCsv(reportData.headers, reportData.rows);
                        const fileName = `JiraPing_Report_${new Date().toISOString().split('T')[0]}.csv`;
                        await app.client.files.uploadV2({
                            channel_id: channelId,
                            content: csvContent,
                            filename: fileName,
                            title: 'Your Jira Follow-up Report',
                            initial_comment: "📊 *Note:* Google Sheets sync is currently unavailable (check your credentials). Falling back to CSV for your report."
                        });
                    }
                } else {
                    // Regular user: generate and upload CSV
                    try {
                        const csvContent = jsonToCsv(reportData.headers, reportData.rows);
                        const fileName = `JiraPing_Report_${new Date().toISOString().split('T')[0]}.csv`;

                        await app.client.files.uploadV2({
                            channel_id: channelId,
                            content: csvContent,
                            filename: fileName,
                            title: 'Your Jira Follow-up Report',
                            initial_comment: "📊 Here is your Jira Follow-up report as a CSV file."
                        });
                    } catch (csvErr) {
                        console.error("CSV Upload Fail", csvErr);
                        await app.client.chat.postMessage({
                            channel: channelId,
                            text: `⚠️ *Export Error:* I couldn't generate your CSV report.\n*Reason:* ${csvErr.message}`
                        });
                    }
                }
            }
        } catch (e) {
            console.error("Report System Fail", e);
        }
    };

    if (offsetMs && offsetMs > 0) {
        setTimeout(() => { sendNow().catch(e => console.error('sendDashboardAndCSV failed', e)); }, offsetMs);
    } else {
        await sendNow();
    }
};

const sendAdminDashboard = async () => {
    if (!ADMIN_USER_IDS.length || ADMIN_USER_IDS.includes('U123')) return; // Skip if not configured

    try {
        const stats = getAdminStats();
        const activeCount = reminders.filter(r => r.active && r.status === 'ACTIVE').length;
        const resolvedCount = reminders.filter(r => r.status === 'RESOLVED').length;
        const blockedCount = reminders.filter(r => r.status === 'BLOCKED').length;
        const waitingCount = reminders.filter(r => r.status === 'WAITING_ON_SA').length;

        // Calculate metrics
        const metrics = calculateMetrics();
        const escalations = findEscalationCandidates();
        const reportAnalytics = analyzeReports(stats);

        // Beautiful formatted blocks
        const blocks = [
            { type: "header", text: { type: "plain_text", text: "📊 Solutions / Integrations Dashboard" } },

            // Quick Stats Section
            { type: "section", text: { type: "mrkdwn", text: "*📈 Quick Stats*" } },
            {
                type: "section", fields: [
                    { type: "mrkdwn", text: `*Total Reminders*\n${reminders.length}` },
                    { type: "mrkdwn", text: `*Active*\n${activeCount}` },
                    { type: "mrkdwn", text: `*Resolved* ✅\n${resolvedCount}` },
                    { type: "mrkdwn", text: `*Blocked* 🔴\n${blockedCount}` }
                ]
            },

            { type: "divider" },

            // Efficiency Metrics
            { type: "section", text: { type: "mrkdwn", text: "*⚡ Partner Team Responsiveness*" } },
            {
                type: "section", fields: [
                    { type: "mrkdwn", text: `*Completion Rate*\n${metrics.completionRate}%` },
                    { type: "mrkdwn", text: `*Avg Resolution*\n${metrics.avgResolutionDays.toFixed(1)} days` },
                    { type: "mrkdwn", text: `*Avg Pings/Task*\n${metrics.avgPingsPerTask.toFixed(1)}` },
                    { type: "mrkdwn", text: `*Waiting on SA*\n${waitingCount}` }
                ]
            },

            { type: "divider" },

            // Top Performers
            { type: "section", text: { type: "mrkdwn", text: "*🏆 Fastest Responders*" } }
        ];

        // Top assignees
        const topAssignees = Object.entries(metrics.assigneeMetrics)
            .filter(([_, data]) => data.completed > 0) // Only show those with completions
            .sort((a, b) => b[1].efficiencyScore - a[1].efficiencyScore)
            .slice(0, 3);

        if (topAssignees.length > 0) {
            topAssignees.forEach(([assignee, data]) => {
                const stars = '⭐'.repeat(Math.round(data.efficiencyScore));
                blocks.push({
                    type: "section",
                    text: { type: "mrkdwn", text: `${stars} <@${assignee}>\n✓ ${data.completed} completed | ⏱️ ${data.avgResolutionTime.toFixed(1)}d | 📊 ${data.active} active` }
                });
            });
        } else {
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "No completed tasks yet to rank." } });
        }

        // Escalations - only show real ones (15+ pings)
        if (escalations.length > 0) {
            blocks.push({ type: "divider" });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "*🚨 Tickets Needing Attention (15+ pings or blocked >24h)*" } });
            escalations.slice(0, 5).forEach(r => {
                const hoursActive = Math.round((new Date() - new Date(r.created_at)) / (1000 * 60 * 60));
                blocks.push({
                    type: "section",
                    text: { type: "mrkdwn", text: `*"${r.note}"*\n👤 <@${r.assignee}> | 🔥 ${r.pingCount} pings | ⏱️ ${hoursActive}h active\n<${getThreadLink(r.channel, r.thread_ts)}|→ View Thread>` }
                });
            });
        } else {
            blocks.push({ type: "divider" });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "*✅ No tickets needing attention*\nAll reminders are on track!" } });
        }

        // Report breakdown
        if (reportAnalytics.byReason.length > 0) {
            blocks.push({ type: "divider" });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "*📋 Report Breakdown*" } });
            const reportText = reportAnalytics.byReason
                .map(item => `• ${item.reason}: ${item.count} (${item.percentage}%)`)
                .join('\n');
            blocks.push({
                type: "section",
                text: { type: "mrkdwn", text: reportText }
            });
        }

        // Recommendations
        const recommendations = generateRecommendations(metrics, escalations, reportAnalytics);
        if (recommendations && recommendations !== "✅ Everything looks good!") {
            blocks.push({ type: "divider" });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "*💡 Recommendations*" } });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: recommendations } });
        }

        // Open DM(s) and send with staggering to avoid rate limits
        const recipients = ADMIN_USER_IDS.filter(Boolean);
        recipients.forEach((userId, idx) => {
            const delay = idx * 1500; // 1.5 seconds per user
            setTimeout(async () => {
                try {
                    const dm = await app.client.conversations.open({ users: userId });
                    await app.client.chat.postMessage({ channel: dm.channel.id, blocks, text: "Admin Dashboard" });

                    const adminReportData = generateAdminReportData(metrics, escalations);
                    if (adminReportData) {
                        try {
                            // Persistent global admin sheet
                            const { spreadsheetId, url } = await createGoogleSheetReport(
                                "Admin Dashboard",
                                adminReportData.headers,
                                adminReportData.rows,
                                null, // Pass null so it checks for ADMIN_SPREADSHEET_ID in env
                                true  // Overwrite enabled for real-time snapshot
                            );

                            await app.client.chat.postMessage({
                                channel: dm.channel.id,
                                text: `📊 *Admin Dashboard*\n🔗 <${url}|View Master Spreadsheet>`,
                                blocks: [
                                    {
                                        type: "section",
                                        text: { type: "mrkdwn", text: "📊 *Admin Dashboard*\nYour master spreadsheet has been updated with the latest metrics." },
                                        accessory: {
                                            type: "button",
                                            text: { type: "plain_text", text: "Open Master Sheet 🔗" },
                                            url: url,
                                            action_id: "open_admin_sheet"
                                        }
                                    }
                                ]
                            });
                        } catch (adminSheetErr) {
                            console.error("Admin Sheet Fail", adminSheetErr);
                            // SILENT FALLBACK: If Sheets fail, automatically send the CSV
                            const csvContent = jsonToCsv(adminReportData.headers, adminReportData.rows);
                            const fileName = `JiraPing_Admin_Summary_${new Date().toISOString().split('T')[0]}.csv`;
                            await app.client.files.uploadV2({
                                channel_id: dm.channel.id,
                                content: csvContent,
                                filename: fileName,
                                title: 'Admin Master Summary Report',
                                initial_comment: "📊 *Note:* Master Google Sheet sync failed (check credentials). Falling back to CSV for your summary."
                            });
                        }
                    }
                } catch (err) {
                    console.error('Could not send admin dashboard to', userId, err);
                }
            }, delay);
        });
    } catch (e) {
        // Specific error handling for common issues
        if (e.data?.error === 'channel_not_found') {
            console.error("⚠️ Cannot send admin dashboard: ADMIN_USER_ID not found. Check .env file");
        } else if (e.code === 'slack_webapi_platform_error') {
            console.error("⚠️ Admin dashboard send failed - Slack API error:", e.data?.error);
        } else {
            console.error("Admin dashboard error:", e.message);
        }
    }
};

/**
 * Calculate efficiency metrics for all assignees
 */
const calculateMetrics = () => {
    const resolved = reminders.filter(r => r.status === 'RESOLVED');
    const assigneeMetrics = {};

    reminders.forEach(r => {
        if (!assigneeMetrics[r.assignee]) {
            assigneeMetrics[r.assignee] = {
                active: 0,
                completed: 0,
                totalPings: 0,
                totalResolutionTime: 0,
                avgResolutionTime: 0,
                avgPingsPerTask: 0,
                efficiencyScore: 0
            };
        }

        if (r.active) assigneeMetrics[r.assignee].active++;
        if (r.status === 'RESOLVED') {
            assigneeMetrics[r.assignee].completed++;
            const resolutionTime = (new Date(r.resolved_at || new Date()) - new Date(r.created_at)) / (1000 * 60 * 60 * 24);
            assigneeMetrics[r.assignee].totalResolutionTime += resolutionTime;
            assigneeMetrics[r.assignee].totalPings += r.pingCount;
        }
    });

    // Calculate averages and efficiency scores
    Object.entries(assigneeMetrics).forEach(([_, data]) => {
        if (data.completed > 0) {
            data.avgResolutionTime = data.totalResolutionTime / data.completed;
            data.avgPingsPerTask = data.totalPings / data.completed;
            // Score: 5 stars max, reduced by resolution time and ping count
            data.efficiencyScore = Math.max(1, 5 - (data.avgResolutionTime / 2) - (data.avgPingsPerTask / 5));
        }
    });

    const totalResolved = resolved.length;
    const avgResolutionDays = totalResolved > 0
        ? resolved.reduce((sum, r) => sum + (new Date(r.resolved_at || new Date()) - new Date(r.created_at)) / (1000 * 60 * 60 * 24), 0) / totalResolved
        : 0;
    const avgPingsPerTask = totalResolved > 0 ? resolved.reduce((sum, r) => sum + r.pingCount, 0) / totalResolved : 0;
    const completionRate = reminders.length > 0 ? Math.round((totalResolved / reminders.length) * 100) : 0;

    return {
        assigneeMetrics,
        avgResolutionDays,
        avgPingsPerTask,
        completionRate
    };
};

/**
 * Find reminders that need escalation (high ping count or blocked too long)
 * Only shows ACTIVE reminders with real issues (not test/completed ones)
 */
const findEscalationCandidates = () => {
    return reminders.filter(r => {
        // Skip resolved or non-active reminders
        if (r.status === 'RESOLVED' || !r.active) return false;

        // Only show reminders with actual escalation (15+ pings)
        const isPingEscalation = r.pingCount >= ESCALATION_PING_THRESHOLD;

        // Or blocked for >24 hours
        const isBlockedLong = r.status === 'BLOCKED' && (new Date() - new Date(r.created_at)) / (1000 * 60 * 60) > 24;

        return isPingEscalation || isBlockedLong;
    }).sort((a, b) => b.pingCount - a.pingCount);
};

/**
 * Analyze report patterns
 */
const analyzeReports = (stats) => {
    const reports = stats.reports || [];
    const reasonCounts = {};
    let total = reports.length;

    reports.forEach(r => {
        reasonCounts[r.type] = (reasonCounts[r.type] || 0) + 1;
    });

    const byReason = Object.entries(reasonCounts)
        .map(([reason, count]) => ({
            reason,
            count,
            percentage: total > 0 ? Math.round((count / total) * 100) : 0
        }))
        .sort((a, b) => b.count - a.count);

    return { byReason, total };
};

/**
 * Generate AI-like recommendations based on metrics
 */
const generateRecommendations = (metrics, escalations, reportAnalytics) => {
    const recommendations = [];

    if (escalations.length > 0) {
        recommendations.push(`🚨 ${escalations.length} ticket(s) at risk - consider manual intervention or re-prioritization`);
    }

    if (reportAnalytics.byReason[0]) {
        const topIssue = reportAnalytics.byReason[0];
        recommendations.push(`📌 Most common issue: ${topIssue.reason} (${topIssue.count} reports) - may indicate process problem`);
    }

    const poorPerformers = Object.entries(metrics.assigneeMetrics)
        .filter(([_, data]) => data.completed > 0 && data.avgPingsPerTask > 10)
        .map(([assignee]) => `<@${assignee}>`)
        .slice(0, 2);

    if (poorPerformers.length > 0) {
        recommendations.push(`💡 Check in with ${poorPerformers.join(', ')} - might require escalation or an alignment sync`);
    }

    if (metrics.completionRate < 50) {
        recommendations.push(`⏱️ Completion rate is ${metrics.completionRate}% - consider reviewing priority/scope`);
    }

    return recommendations.length > 0 ? recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n') : "✅ Everything looks good!";
};

const generateAdminReportData = (metrics, escalations) => {
    const escalationIds = new Set(escalations.map(r => r.id));
    const stats = getAdminStats();
    const reports = (stats && stats.reports) ? stats.reports : [];

    const headers = ["Ticket", "Assignee", "Reporter", "Status", "Pings", "Frequency", "Created", "Resolution Days", "Channel", "Thread Link", "Blocker Reason", "Reported As", "Escalated", "Assignee Efficiency", "Jira"];
    const rows = reminders.map(r => {
        const assigneeData = metrics.assigneeMetrics[r.assignee];
        const resolutionDays = r.status === 'RESOLVED'
            ? ((new Date(r.resolved_at || new Date()) - new Date(r.created_at)) / (1000 * 60 * 60 * 24)).toFixed(1)
            : 'Active';
        const efficiency = assigneeData ? assigneeData.efficiencyScore.toFixed(1) : 'N/A';
        const isEscalated = escalationIds.has(r.id) ? 'YES' : 'NO';
        const report = reports.find(rep => rep.reminder_id === r.id);
        const reportReason = report ? report.type : 'None';

        return [
            r.note,
            r.assigneeName,
            r.creatorName,
            r.status,
            r.pingCount,
            r.frequencyMinutes ? `${r.frequencyMinutes}m` : 'N/A',
            new Date(r.created_at).toISOString().split('T')[0],
            resolutionDays,
            r.channel,
            getThreadLink(r.channel, r.thread_ts),
            r.blockerReason || 'None',
            reportReason,
            isEscalated,
            efficiency,
            r.jira || 'N/A'
        ];
    });

    return { headers, rows };
};

// ---------------------------
// 4. Creation Flow
// ---------------------------

app.shortcut('set_thread_reminder', async ({ shortcut, ack, client }) => {
    await ack();
    const channel = (shortcut.channel?.id || shortcut.message?.channel?.id);
    const thread_ts = (shortcut.message?.thread_ts || shortcut.message?.ts || shortcut.shortcut_ts);

    await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: {
            type: 'modal',
            callback_id: 'create_reminder',
            private_metadata: JSON.stringify({ channel, thread_ts }),
            title: { type: 'plain_text', text: 'Jira Follow-up' },
            submit: { type: 'plain_text', text: 'Launch' },
            blocks: [
                { type: 'input', block_id: 'assignee_block', element: { type: 'users_select', action_id: 'assignee' }, label: { type: 'plain_text', text: 'Assignee' } },
                {
                    type: 'input', block_id: 'frequency_block', element: {
                        type: 'static_select', action_id: 'frequency', options: [
                            { text: { type: 'plain_text', text: '📅 Every Day' }, value: '1440' },
                            { text: { type: 'plain_text', text: '⏳ Every 2 Days' }, value: '2880' },
                            { text: { type: 'plain_text', text: '🗓️ Every 3 Days' }, value: '4320' },
                            { text: { type: 'plain_text', text: '🕒 Once a Week' }, value: '10080' }
                        ]
                    }, label: { type: 'plain_text', text: 'Reminder Frequency' }
                },
                { type: 'input', block_id: 'note_block', element: { type: 'plain_text_input', action_id: 'note' }, label: { type: 'plain_text', text: 'Context/Goal' } },
                { type: 'input', block_id: 'jira_block', element: { type: 'plain_text_input', action_id: 'jira' }, label: { type: 'plain_text', text: 'Jira URL' }, optional: true }
            ]
        }
    });
});

app.view('create_reminder', async ({ ack, body, view, client }) => {
    await ack();
    const metadata = JSON.parse(view.private_metadata);
    const assigneeId = view.state.values.assignee_block.assignee.selected_user;
    const [assigneeInfo, creatorInfo] = await Promise.all([
        client.users.info({ user: assigneeId }),
        client.users.info({ user: body.user.id })
    ]);

    const frequencyMinutes = parseInt(view.state.values.frequency_block.frequency.selected_option.value);

    const reminder = {
        id: uuidv4(),
        channel: metadata.channel,
        thread_ts: metadata.thread_ts,
        assignee: assigneeId,
        assigneeName: assigneeInfo.user.real_name,
        created_by: body.user.id,
        creatorName: creatorInfo.user.real_name,
        creatorAvatar: creatorInfo.user.profile.image_192,
        created_at: new Date(),
        frequencyMinutes: frequencyMinutes,
        note: view.state.values.note_block.note.value,
        jira: view.state.values.jira_block.jira?.value || '',
        status: 'ACTIVE',
        pingCount: 0,
        dailyPingCount: 0,
        active: true,
        lastSent: new Date(),
        lastActivityAt: new Date(),
        lastAssigneeActivityAt: new Date(0), // No activity yet
        etaNotified: false
    };

    reminders.push(reminder);
    saveToDb(reminders);
    updateGlobalStats(metadata.channel);

    // CONSOLIDATED CREATION MESSAGE (Education + Action Card)
    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `Hi <@${assigneeId}> 👋\n\nA follow-up reminder has been set by <@${body.user.id}>.\n\n• *Done* → Mark complete\n• *Blocked* → Pause reminders\n• *Target Date* → Set ETA (I'll remind you 1 day before)`
            }
        },
        ...buildThreadBlock(reminder)
    ];

    await client.chat.postMessage({
        channel: reminder.channel,
        thread_ts: reminder.thread_ts,
        username: `${creatorInfo.user.real_name} (via JiraPing)`,
        icon_url: creatorInfo.user.profile.image_192,
        blocks: blocks,
        text: `Follow-up set for <@${assigneeId}>`
    });

    // Removed automatic delayed personal dashboard send to avoid noisy behavior in production
});

// ---------------------------
// 5. Blocker & Call Orchestration
// ---------------------------

app.action('open_blocker_modal', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (!r || !r.active || r.status === 'RESOLVED') return;

    // 🔒 Security Check
    if (body.user.id !== r.assignee) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user.id,
            text: "🚫 Only the assignee can report a blocker for this task."
        });
        return;
    }
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal',
            callback_id: 'submit_blocker',
            private_metadata: action.value,
            title: { type: 'plain_text', text: 'Report Blocker' },
            submit: { type: 'plain_text', text: 'Pause Reminders' },
            blocks: [
                {
                    type: "input",
                    block_id: "type_block",
                    label: { type: "plain_text", text: "What's blocking you?" },
                    element: {
                        type: "static_select",
                        action_id: "type",
                        options: [
                            { text: { type: "plain_text", text: "Technical Issue" }, value: "Technical" },
                            { text: { type: "plain_text", text: "Waiting on Someone" }, value: "WAITING_ON_SA" },
                            { text: { type: "plain_text", text: "Dependency/Resource" }, value: "Dependency" }
                        ]
                    }
                },
                { type: "input", block_id: "desc_block", label: { type: "plain_text", text: "Details" }, element: { type: "plain_text_input", multiline: true, action_id: "desc" } }
            ]
        }
    });
});

app.view('submit_blocker', async ({ ack, body, view, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === view.private_metadata);
    const type = view.state.values.type_block.type.selected_option.value;
    const desc = view.state.values.desc_block.desc.value;

    if (r) {
        r.status = type === 'WAITING_ON_SA' ? 'WAITING_ON_SA' : 'BLOCKED';
        r.active = false; // PAUSE follow-ups when blocked
        r.blockerReason = `[${type}] ${desc}`;
        saveToDb(reminders);

        // Notify SA with clear/resume button
        await client.chat.postMessage({
            channel: r.created_by,
            text: `🛑 Blocker Alert`,
            blocks: [
                { type: "section", text: { type: "mrkdwn", text: `🛑 *Blocker Alert* from <@${body.user.id}>\n>Note: ${r.note}\n>Detail: ${r.blockerReason}` } },
                { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Clear & Resume 🚀" }, action_id: "resume_nudges", value: r.id, style: "primary" }] }
            ]
        });

        // Just confirm in thread, don't show all buttons
        await client.chat.postMessage({
            channel: r.channel, thread_ts: r.thread_ts,
            text: `⏸️ Got it. Reminders paused until you're ready.`
        });
    }
});

app.action('report_ticket', async ({ ack, body, action, client }) => {
    await ack();
    console.log(`[DEBUG] report_ticket clicked by ${body.user.id} for item ${action.value}`);

    const r = reminders.find(rem => rem.id === action.value);
    if (!r) { console.log('[DEBUG] Report: Reminder not found'); return; }
    if (!r.active) { console.log('[DEBUG] Report: Reminder inactive'); return; }
    if (r.status === 'RESOLVED') { console.log('[DEBUG] Report: Reminder resolved'); return; }

    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'submit_report',
                private_metadata: action.value,
                title: { type: 'plain_text', text: 'Report Issue' },
                submit: { type: 'plain_text', text: 'Submit' },
                blocks: [
                    { type: "section", text: { type: "mrkdwn", text: "Why are you reporting this?" } },
                    {
                        type: "input",
                        block_id: "reason_block",
                        element: {
                            type: "static_select",
                            action_id: "reason",
                            options: [
                                { text: { type: "plain_text", text: "Invalid/Not real work" }, value: "invalid" },
                                { text: { type: "plain_text", text: "Team won't pick up" }, value: "deprioritized" },
                                { text: { type: "plain_text", text: "Spam/Testing" }, value: "spam" },
                                { text: { type: "plain_text", text: "Other reason" }, value: "other" }
                            ]
                        },
                        label: { type: "plain_text", text: "Issue Type" }
                    }
                ]
            }
        });
    } catch (e) {
        console.error('[DEBUG] Report modal failed:', e);
    }
});

// ---------------------------
// 6. ETA Logic
// ---------------------------

app.action('open_eta_modal', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (!r || !r.active || r.status === 'RESOLVED') return;

    // 🔒 Security Check
    if (body.user.id !== r.assignee) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user.id,
            text: "🚫 Only the assignee can set a target date."
        });
        return;
    }
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal', callback_id: 'submit_eta', private_metadata: action.value,
            title: { type: 'plain_text', text: 'Set Target Date' },
            submit: { type: 'plain_text', text: 'Save' },
            blocks: [{ type: "input", block_id: "eta_block", element: { type: "datepicker", action_id: "date" }, label: { type: "plain_text", text: "When will this be done?" } }]
        }
    });
});

app.view('submit_eta', async ({ ack, body, view, client }) => {
    const r = reminders.find(rem => rem.id === view.private_metadata);
    const date = view.state.values.eta_block.date.selected_date;
    const selectedDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate < today) {
        await ack({
            response_action: 'errors',
            errors: {
                eta_block: 'ETA cannot be set to a past date. Please choose a future date.'
            }
        });
        return;
    }
    await ack();
    if (r) {
        r.eta = date;
        r.etaNotified = false;
        saveToDb(reminders);
        // Just show confirmation, not the action card
        await client.chat.postMessage({
            channel: r.channel,
            thread_ts: r.thread_ts,
            text: `Target date set to ${date}. No reminders until 1 day before.`
        });
    }
});

// ---------------------------
// 7. Engine & Listener
// ---------------------------

cron.schedule('* * * * *', async () => {
    // Convert to IST for working hours check
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + (3600000 * 5.5));

    const hour = ist.getHours();
    const day = ist.getDay();

    // Respect working days/hours strictly in production
    if (!WORKING_DAYS.includes(day) || hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) return;

    for (let i = reminders.length - 1; i >= 0; i--) {
        const r = reminders[i];
        if (!r.active) continue;

        // 🛡️ GHOST PROTECTION: Check if reminder still exists in DB
        const exists = await ReminderModel.exists({ id: r.id });
        if (!exists) {
            console.log(`👻 Cleanup: Removing reminder ${r.id} from memory (deleted from DB)`);
            reminders.splice(i, 1);
            continue;
        }

        // 🧠 SMART SILENCE (Observer Pattern)
        const lastActivity = r.lastActivityAt ? new Date(r.lastActivityAt) : new Date(0);
        const lastAssigneeActivity = r.lastAssigneeActivityAt ? new Date(r.lastAssigneeActivityAt) : new Date(0);
        const lastSent = r.lastSent ? new Date(r.lastSent) : new Date(0);

        // A. Ongoing Discussion Standoff: Skip if ANY message was sent in last 60 mins
        const minutesSinceActivity = (now - lastActivity) / 1000 / 60;
        if (minutesSinceActivity < 60) {
            console.log(`🤫 Silence: Skipping ping for ${r.id} due to recent discussion (${Math.round(minutesSinceActivity)}m ago)`);
            continue;
        }

        // B. Recent Progress Silence: Skip if Assignee has messaged SINCE the last ping
        if (lastAssigneeActivity > lastSent) {
            console.log(`🤫 Silence: Skipping ping for ${r.id} because assignee has already replied since last ping.`);
            continue;
        }

        if (r.status === 'BLOCKED' || r.status === 'WAITING_ON_SA') continue;

        // Special handling for Medium: only in the morning
        if (r.priority === 'Medium' && hour !== 9) continue;

        // ETA Silencing logic - if ETA exists and > 1 day away, skip pings
        if (r.eta && r.status === 'ACTIVE') {
            const etaDate = new Date(r.eta);
            const diffDays = (etaDate - now) / (1000 * 60 * 60 * 24);
            if (diffDays > 1) {
                // More than 1 day away - no pings yet
                continue;
            } else if (diffDays > 0 && diffDays <= 1) {
                // Within 1 day but not reached - send single "target date tomorrow" message once
                if (!r.etaNotified) {
                    try {
                        let icon_url = r.creatorAvatar;
                        if (!icon_url) {
                            try {
                                const creatorInfo = await app.client.users.info({ user: r.created_by });
                                icon_url = creatorInfo.user.profile.image_192;
                                r.creatorAvatar = icon_url;
                                saveToDb(reminders);
                            } catch (e) {
                                console.error('Could not fetch creator info for avatar', e);
                            }
                        }

                        await app.client.chat.postMessage({
                            channel: r.channel, thread_ts: r.thread_ts,
                            text: `Target date is tomorrow! Make sure this is ready.`,
                            username: `${r.creatorName} (via JiraPing)`,
                            icon_url: icon_url
                        });
                        r.etaNotified = true;
                        saveToDb(reminders);
                    } catch (e) {
                        console.error('Error sending ETA reminder:', e);
                    }
                }
                continue; // Don't send regular pings during final day
            }
        }

        const isWaitingOnSA = r.status === 'WAITING_ON_SA';
        const target = isWaitingOnSA ? r.created_by : r.assignee;
        const diff = (now - new Date(r.lastSent)) / 1000 / 60;

        if (diff >= r.frequencyMinutes) {
            if (r.dailyPingCount >= DAILY_PING_LIMIT) continue;
            try {
                // Contextual message based on whether ETA exists
                let contextMsg;
                if (r.eta) {
                    contextMsg = `${getDiverseGreeting(target, r.pingCount)} quick status update on this? We have it targeted for ${r.eta}`;
                } else {
                    contextMsg = `${getDiverseGreeting(target, r.pingCount)} any progress? If you can, drop a target date so we can plan around it 📅`;
                }

                let icon_url = r.creatorAvatar;
                if (!icon_url) {
                    try {
                        const creatorInfo = await app.client.users.info({ user: r.created_by });
                        icon_url = creatorInfo.user.profile.image_192;
                        r.creatorAvatar = icon_url;
                        saveToDb(reminders);
                    } catch (e) {
                        console.error('Could not fetch creator info for avatar', e);
                    }
                }

                await app.client.chat.postMessage({
                    channel: r.channel, thread_ts: r.thread_ts,
                    text: "Friendly Check-in",
                    username: `${r.creatorName} (via JiraPing)`,
                    icon_url: icon_url,
                    blocks: [
                        { type: "section", text: { type: "mrkdwn", text: contextMsg } },
                        {
                            type: "actions", elements: [
                                { type: "button", text: { type: "plain_text", text: "Done" }, action_id: "stop_reminder", value: r.id, style: "primary" },
                                { type: "button", text: { type: "plain_text", text: "Blocked" }, action_id: "open_blocker_modal", value: r.id, style: "danger" },
                                { type: "button", text: { type: "plain_text", text: "Target Date" }, action_id: "open_eta_modal", value: r.id },
                                { type: "button", text: { type: "plain_text", text: "Report" }, action_id: "report_ticket", value: r.id }
                            ]
                        }
                    ]
                });
                r.lastSent = now;
                r.pingCount++;
                r.dailyPingCount++;

                // Escalation alert: if ping count hits threshold, notify admins
                if (r.pingCount === ESCALATION_PING_THRESHOLD) {
                    try {
                        for (const adminId of ADMIN_USER_IDS.filter(Boolean)) {
                            try {
                                const dm = await app.client.conversations.open({ users: adminId });
                                await app.client.chat.postMessage({
                                    channel: dm.channel.id,
                                    text: `⚠️ ESCALATION ALERT`,
                                    blocks: [
                                        { type: "section", text: { type: "mrkdwn", text: `🚨 Ticket in limbo: "*${r.note}*" for <@${r.assignee}> has reached ${r.pingCount} pings.\n*Assigned by:* <@${r.created_by}>\n<${getThreadLink(r.channel, r.thread_ts)}|View Thread>` } }
                                    ]
                                });
                            } catch (dmErr) {
                                console.error(`Escalation alert failed for admin ${adminId}`, dmErr);
                            }
                        }
                    } catch (e) {
                        console.error('Could not send escalation alert:', e);
                    }
                }

                saveToDb(reminders);
            } catch (e) {
                if (e.code === 'slack_webapi_platform_error' && e.data.error === 'channel_not_found') {
                    console.log(`Channel ${r.channel} not found, ending follow-up for ${r.id}`);
                    r.active = false;
                    saveToDb(reminders);
                    try {
                        const dm = await app.client.conversations.open({ users: r.created_by });
                        await app.client.chat.postMessage({
                            channel: dm.channel.id,
                            text: `Follow-up ended for a thread due to channel access issues.`,
                            blocks: [
                                { type: "section", text: { type: "mrkdwn", text: `The follow-up for "${r.note}" has been stopped because the channel is no longer accessible.` } }
                            ]
                        });
                    } catch (dmError) {
                        console.log('Could not send DM to reporter');
                    }
                } else {
                    console.error('Error sending reminder:', e);
                }
            }
        }
    }
});

// Daily Reset for Ping Counts & Admin Dashboard (Every 3 days)
cron.schedule('0 9 * * 1-5', async () => {
    reminders.forEach(r => r.dailyPingCount = 0);
    saveToDb(reminders);

    const stats = await GlobalStatsModel.findOne({ key: 'main' });
    const lastSent = stats?.lastAdminReportSent || new Date(0);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    if (lastSent < threeDaysAgo) {
        await sendAdminDashboard();
        await GlobalStatsModel.findOneAndUpdate(
            { key: 'main' },
            { lastAdminReportSent: new Date() },
            { upsert: true }
        );
        console.log('📊 Admin Dashboard sent (3-day cycle)');
    }
}, { timezone: "Asia/Kolkata" });

// Daily SA report auto-send (Every morning at 10 AM IST)
cron.schedule('0 10 * * 1-5', async () => {
    console.log('📅 Starting Daily Auto SA Reports...');
    const uniqueCreators = [...new Set(reminders.filter(r => r.active).map(r => r.created_by))];

    for (let i = 0; i < uniqueCreators.length; i++) {
        const userId = uniqueCreators[i];
        const delay = i * 2000; // 2 second stagger to avoid rate limits
        setTimeout(async () => {
            await sendDashboardAndCSV(userId);
        }, delay);
    }
}, { timezone: "Asia/Kolkata" });

// ---------------------------
// Daily Midnight Cleanup & Archiving
// ---------------------------
cron.schedule('0 0 * * *', async () => {
    const now = new Date();
    const DAY = 1000 * 60 * 60 * 24;
    const warnings = [];
    const toDeleteIds = new Set();

    reminders.forEach(r => {
        try {
            // Use resolved_at when available for RESOLVED items
            const refDate = r.status === 'RESOLVED' && r.resolved_at ? new Date(r.resolved_at) : new Date(r.created_at);
            const ageDays = Math.floor((now - refDate) / DAY);

            // Warn creator at 85 days for resolved reminders
            if (r.status === 'RESOLVED' && ageDays >= 85 && ageDays < 90) {
                warnings.push({ reminder: r, days: ageDays });
            }

            // Delete permanently at 90+ days for RESOLVED or BLOCKED
            if ((r.status === 'RESOLVED' || r.status === 'BLOCKED') && ageDays >= 90) {
                toDeleteIds.add(r.id);
            }
        } catch (e) {
            console.error('Error during cleanup check for reminder', r && r.id, e);
        }
    });

    // Send warnings (grouped per user staggering)
    for (let i = 0; i < warnings.length; i++) {
        const { reminder, days } = warnings[i];
        const delay = i * 1500; // stagger
        setTimeout(async () => {
            try {
                const dm = await app.client.conversations.open({ users: reminder.created_by });
                await app.client.chat.postMessage({
                    channel: dm.channel.id,
                    text: `Reminder purge warning`,
                    blocks: [
                        { type: 'section', text: { type: 'mrkdwn', text: `Hi <@${reminder.created_by}>, your reminder "*${reminder.note}*" is ${days} days old and marked ${reminder.status}. It will be automatically purged in ${90 - days} day(s). If you'd like to keep a record, run /sa-report to download your tasks.` } }
                    ]
                });
            } catch (e) { console.error('Could not send purge warning for', reminder.id, e); }
        }, delay);
    }

    // For deletions, archive (final CSV) then remove
    if (toDeleteIds.size > 0) {
        // Prepare array of reminders to delete to avoid mutating while iterating
        const toDelete = reminders.filter(r => toDeleteIds.has(r.id));
        for (let i = 0; i < toDelete.length; i++) {
            const r = toDelete[i];
            const delay = i * 1500; // stagger
            setTimeout(async () => {
                try {
                    // Generate per-creator report BEFORE deletion and send as final archive
                    const reportData = generateReportData(r.created_by);
                    if (reportData) {
                        const existing = await UserSheetModel.findOne({ userId: r.created_by, type: 'personal' });
                        const { spreadsheetId, url } = await createGoogleSheetReport(
                            "My Archive",
                            reportData.headers,
                            reportData.rows,
                            existing?.spreadsheetId
                        );

                        if (!existing) {
                            await new UserSheetModel({ userId: r.created_by, type: 'personal', spreadsheetId, url }).save();
                        }

                        const dm = await app.client.conversations.open({ users: r.created_by });
                        await app.client.chat.postMessage({
                            channel: dm.channel.id,
                            text: `📦 *Final Archive:* Reminder "${r.note}" is being purged.\n🔗 <${url}|View Final Archive>`,
                            blocks: [
                                {
                                    type: "section",
                                    text: { type: "mrkdwn", text: `📦 *Final Archive:* Reminder "${r.note}" is being purged from the system.` },
                                    accessory: {
                                        type: "button",
                                        text: { type: "plain_text", text: "View Archive 🔗" },
                                        url: url,
                                        action_id: "open_archive"
                                    }
                                }
                            ]
                        });
                    }
                } catch (e) {
                    console.error('Could not send final archive for', r.id, e);
                }

                // Now remove from reminders and persist
                try {
                    reminders = reminders.filter(item => item.id !== r.id);
                    saveToDb(reminders);
                } catch (e) {
                    console.error('Could not delete reminder', r.id, e);
                }
            }, delay);
        }
    }
}, { timezone: 'Asia/Kolkata' });

app.message(async ({ message, client }) => {
    if (!message.thread_ts || message.bot_id) return;
    const r = reminders.find(rem => rem.thread_ts === message.thread_ts && rem.active);
    if (r && message.user === r.assignee) {
        if (['done', 'fixed', 'resolved'].some(k => message.text.toLowerCase().includes(k))) {
            r.active = false; r.status = 'RESOLVED'; saveToDb(reminders);
            await client.chat.postMessage({ channel: r.channel, thread_ts: r.thread_ts, blocks: buildThreadBlock(r), text: "🎉 Resolved!" });
        }
    }
});

// ---------------------------
// 8. Global Actions
// ---------------------------

app.action('resume_nudges', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (r) {
        r.status = 'ACTIVE';
        r.active = true; // RE-ACTIVATE follow-ups
        r.lastSent = new Date();
        r.etaNotified = false; // Reset ETA notification flag so it can trigger again if ETA exists
        saveToDb(reminders);
        await client.chat.postMessage({
            channel: r.channel,
            thread_ts: r.thread_ts,
            text: `🚀 Unblocked! Reminders back on.`
        });
    }
});

app.action('call_completed', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (r && r.active) {
        r.status = 'ACTIVE';
        r.lastSent = new Date();
        r.pingCount = 0;
        saveToDb(reminders);
        await client.chat.postMessage({
            channel: r.channel, thread_ts: r.thread_ts,
            text: `Call completed!`,
            blocks: [
                {
                    type: "context",
                    elements: [{ type: "mrkdwn", text: `Call completed! Resuming follow-ups with <@${r.assignee}>.` }]
                }
            ]
        });
    }
});

app.action('cancel_call', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (r) {
        await client.chat.postMessage({
            channel: r.channel, thread_ts: r.thread_ts,
            text: `Call request cancelled by <@${body.user.id}>.`
        });
    }
});

app.action('request_thread_recap', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (!r) return;

    try {
        // Fetch thread context (Backward-Aware: reads history before bot was raised)
        const replies = await client.conversations.replies({
            channel: r.channel,
            ts: r.thread_ts,
            limit: 100
        });

        const allMessages = replies.messages || [];
        
        // 🧠 INTELLIGENT FILTERING: Ignore bot's own noise and empty/ping messages
        const humanMessages = allMessages.filter(m => {
            if (m.bot_id) return false;
            if (!m.text) return false;
            const clean = m.text.trim();
            // Ignore if the message is JUST a bot ping (e.g., "@Jira Ping")
            if (clean.startsWith('<@') && clean.endsWith('>') && clean.length < 15) return false;
            return true;
        });

        const latestHumanMsg = humanMessages[humanMessages.length - 1] || { text: 'No status updates found yet.', user: r.assignee };
        const participantIds = [...new Set(humanMessages.map(m => m.user))];
        const participants = participantIds.length > 0 
            ? participantIds.map(id => `<@${id}>`).join(', ') 
            : `<@${r.assignee}>`;

        // 📑 SYNTHESIZE EXECUTIVE SUMMARY
        let execSummary = `<@${r.assignee}> is actively working on "${r.note}". `;
        if (r.status === 'BLOCKED') {
            execSummary = `🚨 *ATTENTION:* Progress on "${r.note}" is currently *STALLED* due to: ${r.blockerReason}.`;
        } else if (r.eta) {
            execSummary += `Currently on track for the target date of *${r.eta}*.`;
        } else {
            execSummary += `The latest update suggests steady progress is being made.`;
        }

        // 🤯 REAL AI SUMMARY (Privacy-First)
        let aiSummary = null;
        const hfToken = process.env.HUGGINGFACE_API_KEY;
        if (hfToken && humanMessages.length > 0) {
            const cleanText = anonymizeThread(humanMessages);
            aiSummary = await getHFSummary(cleanText);
        }

        let statusText = `*${r.status}*`;
        if (r.eta) statusText += ` (Target: ${r.eta})`;

        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            thread_ts: body.container.thread_ts || r.thread_ts,
            text: `🧵 Thread Recap: ${r.note}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*🧵 Thread Synthesis:* ${r.note}\n\n` +
                              (aiSummary || latestHumanMsg.text.substring(0, 200)) + 
                              `\n\n*Status Note:* ${execSummary}`
                    }
                },
            ]
        });
    } catch (e) {
        console.error('Recap failed', e);
        let errorMsg = "⚠️ Sorry, I couldn't generate a recap right now. Check my permissions or try again later.";
        
        if (e.data?.error === 'not_in_channel') {
            errorMsg = "⚠️ *I'm not in this channel!* Please invite me by typing `/invite @JiraPing` so I can read the thread context for your recap.";
        }

        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            thread_ts: body.container.thread_ts || r.thread_ts,
            text: errorMsg
        });
    }
});

app.action('admin_delete_reminder', async ({ ack, body, action, client }) => {
    await ack();
    const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',');
    
    // Security: Only admins can delete data
    if (!ADMIN_IDS.includes(body.user.id)) {
        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            text: "🚫 *Access Denied:* Only administrators can permanently delete follow-up data."
        });
        return;
    }

    const rIdx = reminders.findIndex(rem => rem.id === action.value);
    if (rIdx !== -1) {
        const r = reminders[rIdx];
        try {
            await ReminderModel.deleteOne({ id: r.id });
            reminders.splice(rIdx, 1);
            await client.chat.postEphemeral({
                channel: body.channel.id,
                user: body.user.id,
                text: `🗑️ *Permanent Delete:* Reminder "${r.note}" has been removed from the system.`
            });
        } catch (e) {
            console.error('Delete fail', e);
        }
    }
});

app.action('stop_reminder', async ({ ack, body, action, client }) => {
    await ack();
    console.log(`[DEBUG] stop_reminder clicked by ${body.user.id} for item ${action.value}`);

    const r = reminders.find(rem => rem.id === action.value);
    if (!r) { console.log('[DEBUG] Reminder not found in memory'); return; }
    if (!r.active) { console.log('[DEBUG] Reminder is not active'); return; }
    if (r.status === 'RESOLVED') { console.log('[DEBUG] Reminder is already resolved'); return; }

    // 🔒 Security Check: Only Assignee can mark as done
    if (body.user.id !== r.assignee) {
        console.log(`[DEBUG] Blocked non-assignee: ${body.user.id} !== ${r.assignee}`);
        try {
            await client.chat.postEphemeral({
                channel: r.channel, // Use reminder's channel to be safe
                user: body.user.id,
                text: "🚫 Only the assignee can mark this as active/done. You can 'Report' it if needed."
            });
        } catch (error) {
            console.error('[DEBUG] Failed to post ephemeral message:', error);
        }
        return;
    }

    console.log('[DEBUG] Security check passed. resolving reminder.');
    r.active = false;
    r.status = 'RESOLVED';
    r.resolved_at = new Date(); // Track resolution time for metrics
    saveToDb(reminders);

    // Dynamic appreciation message based on ping count
    let appreciation;
    if (r.pingCount <= 1) {
        appreciation = "🔥 Wow! That was fast. You crushed this.";
    } else if (r.pingCount <= 3) {
        appreciation = "👏 Nice! Got it done efficiently.";
    } else if (r.pingCount <= 5) {
        appreciation = "💪 Done! Your persistence paid off.";
    } else {
        appreciation = "🎉 Finally there! Great work sticking with it.";
    }

    await client.chat.postMessage({
        channel: r.channel,
        thread_ts: r.thread_ts,
        text: appreciation
    });
});

app.command('/sa-report', async ({ ack, body }) => {
    await ack();
    await sendDashboardAndCSV(body.user_id);
});

// Admin commands for deep insights and bulk operations
app.command('/ping-admin', async ({ ack, body, client }) => {
    await ack();
    const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',');
    
    if (!ADMIN_IDS.includes(body.user_id)) {
        await client.chat.postEphemeral({
            channel: body.channel_id, user: body.user_id,
            text: "You don't have permission to use this command."
        });
        return;
    }

    const commandText = body.text ? body.text.trim().toLowerCase() : '';

    if (commandText === 'sweep') {
        const initialCount = reminders.length;
        try {
            await ReminderModel.deleteMany({ note: /test/i });
            for (let i = reminders.length - 1; i >= 0; i--) {
                if (reminders[i].note.toLowerCase().includes('test')) {
                    reminders.splice(i, 1);
                }
            }
            const removed = initialCount - reminders.length;
            await client.chat.postEphemeral({
                channel: body.channel_id,
                user: body.user_id,
                text: `🧹 *Silent Sweep Complete:* Removed ${removed} reminders containing "test" from the system.`
            });
        } catch (e) {
            console.error('Sweep fail', e);
        }
    } else {
        await client.chat.postEphemeral({
            channel: body.channel_id, user: body.user_id,
            text: "Available admin subcommands: `sweep` (removes all reminders containing 'test')"
        });
    }
});

// Admin commands for deep insights and bulk operations
app.command('/admin-stats', async ({ ack, body, client }) => {
    await ack();
    if (!ADMIN_USER_IDS.includes(body.user_id)) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user_id,
            text: "You don't have permission to use this command."
        });
        return;
    }
    await sendAdminDashboard();
});

app.command('/admin-escalations', async ({ ack, body, client }) => {
    await ack();
    if (!ADMIN_USER_IDS.includes(body.user_id)) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user_id,
            text: "You don't have permission to use this command."
        });
        return;
    }

    const escalations = findEscalationCandidates();
    if (escalations.length === 0) {
        await client.chat.postMessage({
            channel: body.channel_id,
            text: "✅ No tickets needing attention - all tickets are on track!"
        });
        return;
    }

    const blocks = [
        { type: "header", text: { type: "plain_text", text: "🚨 Tickets Needing Attention Report" } },
        { type: "section", text: { type: "mrkdwn", text: `Found *${escalations.length}* ticket(s) requiring attention:` } },
        { type: "divider" }
    ];

    escalations.forEach(r => {
        const hoursActive = (new Date() - new Date(r.created_at)) / (1000 * 60 * 60);
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*"${r.note}"*\n👤 <@${r.assignee}> | 📊 ${r.pingCount} pings | ⏱️ Active ${Math.round(hoursActive)}h\n<${getThreadLink(r.channel, r.thread_ts)}|View Thread>` }
        });
    });

    await client.chat.postMessage({ channel: body.channel_id, blocks, text: "Attention Needed" });
});

app.command('/admin-workload', async ({ ack, body, client }) => {
    await ack();
    if (!ADMIN_USER_IDS.includes(body.user_id)) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user_id,
            text: "You don't have permission to use this command."
        });
        return;
    }

    const workload = {};
    reminders.forEach(r => {
        if (!workload[r.assignee]) {
            workload[r.assignee] = { name: r.assigneeName, active: 0, blocked: 0, completed: 0 };
        }
        if (r.active && r.status === 'ACTIVE') workload[r.assignee].active++;
        if (r.status === 'BLOCKED') workload[r.assignee].blocked++;
        if (r.status === 'RESOLVED') workload[r.assignee].completed++;
    });

    const sorted = Object.entries(workload).sort((a, b) => b[1].active - a[1].active);

    const blocks = [
        { type: "header", text: { type: "plain_text", text: "📊 External Workload Distribution" } },
        { type: "section", text: { type: "mrkdwn", text: "Assignee | Active | Blocked | Completed\n" } }
    ];

    sorted.forEach(([userId, data]) => {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `<@${userId}> | *${data.active}* active | ${data.blocked} blocked | ${data.completed}% done` }
        });
    });

    await client.chat.postMessage({ channel: body.channel_id, blocks, text: "Workload" });
});

app.view('submit_report', async ({ ack, body, view, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === view.private_metadata);
    const reason = view.state.values.reason_block.reason.selected_option.value;

    if (!r) return;

    // Log report
    const report = {
        type: reason.toUpperCase(),
        reminder_id: r.id,
        reporter: body.user.id,
        created_by: r.created_by,
        ticket: r.note,
        timestamp: new Date().toISOString()
    };
    r.active = false;
    r.status = 'REPORTED';
    saveToDb(reminders);
    saveReport(report);

    // Funny messages based on reason
    const messages = {
        invalid: "Got it. Removing invalid ticket from tracking.",
        deprioritized: "Understood. Priorities shift. No hard feelings.",
        spam: "Flagged as spam. Keeping the bot clean.",
        other: "Thanks for the feedback. Admin will review."
    };

    // Thank you message to reporter
    await client.chat.postMessage({
        channel: r.channel, thread_ts: r.thread_ts,
        text: `Thank you for reporting!`,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: `${messages[reason] || messages.other}` } }
        ]
    });

    // Notification to creator
    const dm = await client.conversations.open({ users: r.created_by });
    await client.chat.postMessage({
        channel: dm.channel.id,
        text: `Ticket Flagged`,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: `Your reminder for "${r.note}" was flagged. Please ensure you're using this bot responsibly.` } }
        ]
    });
});

// --- Conversation-Aware Intelligence (The Observer) ---

app.event('message', async ({ event, client }) => {
    // 🔍 Debug: Log event properties
    console.log(`💬 Message received | user: ${event.user} | channel: ${event.channel} | thread_ts: ${event.thread_ts} | ts: ${event.ts}`);

    // Only care about thread replies
    if (!event.thread_ts) return;

    const r = reminders.find(rem => rem.thread_ts === event.thread_ts && rem.active);
    if (!r) {
        console.log(`❌ No active reminder found for thread_ts: ${event.thread_ts}`);
        return;
    }

    // 1. Update activity timestamps
    const now = new Date();
    r.lastActivityAt = now;

    const isAssignee = event.user === r.assignee;
    if (isAssignee) {
        console.log(`💬 Assignee Activity detected for reminder ${r.id}`);
        r.lastAssigneeActivityAt = now;
    }

    // 2. Adaptive Natural Language Parsing (NLP) - ONLY for Assignee
    if (isAssignee && event.text) {
        const text = event.text.toLowerCase();
        let adapted = false;
        let feedbackMsg = '';

        // A. ETA Detection (EOD, EOB, Friday, Tomorrow, etc.)
        const dateMatch = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|eod|eob|after lunch)\b/i);
        if (dateMatch) {
            const dateStr = dateMatch[0].toLowerCase();
            let targetDate = new Date();

            if (dateStr === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
            else if (dateStr === 'tonight' || dateStr === 'eod' || dateStr === 'eob') targetDate.setHours(19, 0, 0, 0);
            else if (dateStr === 'after lunch') targetDate.setHours(14, 0, 0, 0);
            else if (dateStr === 'next week') targetDate.setDate(targetDate.getDate() + 7);
            else {
                // Find next weekday
                const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const targetDay = days.indexOf(dateStr);
                const currentDay = targetDate.getDay();
                let diff = targetDay - currentDay;
                if (diff <= 0) diff += 7;
                targetDate.setDate(targetDate.getDate() + diff);
            }

            const isoDate = targetDate.toISOString().split('T')[0];
            r.eta = isoDate;
            r.etaNotified = false;
            feedbackMsg = `🎯 *Sync:* I've set your target date to *${isoDate}* and paused earlier nudges!`;
            adapted = true;
        }

        // B. Ambiguity Support: "later" or "snooze"
        if (/\b(later|snooze|busy|away)\b/i.test(text) && !adapted) {
            try {
                await client.chat.postEphemeral({
                    channel: event.channel,
                    user: event.user,
                    thread_ts: event.thread_ts,
                    text: "Snooze these reminders?",
                    blocks: [
                        { type: "section", text: { type: "mrkdwn", text: "🕒 *I heard 'later'!* Should I snooze these reminders for a bit?" } },
                        {
                            type: "actions",
                            elements: [
                                { type: "button", text: { type: "plain_text", text: "For 4h" }, action_id: "open_eta_modal", value: r.id },
                                { type: "button", text: { type: "plain_text", text: "Until Tomorrow" }, action_id: "pause_reminders", value: r.id },
                                { type: "button", text: { type: "plain_text", text: "Ignore" }, action_id: "ignore_suggestion" }
                            ]
                        }
                    ]
                });
            } catch (e) { console.error('Ambiguity check failed', e); }
        }

        // C. Visual Confirmation & Sync
        if (adapted) {
            try {
                // VISIBLE THREAD REPLY (Previously Ephemeral)
                await client.chat.postMessage({
                    channel: event.channel,
                    thread_ts: event.thread_ts,
                    text: feedbackMsg,
                    blocks: [
                        {
                            type: "section",
                            text: { type: "mrkdwn", text: feedbackMsg },
                            accessory: {
                                type: "button",
                                text: { type: "plain_text", text: "Undo ↩️" },
                                action_id: "open_eta_modal",
                                value: r.id
                            }
                        }
                    ]
                });
            } catch (e) { console.error('Feedback failed', e); }
        }
    }

    // 3. Smart Suggestion: Done/Fixed/Waiting check
    if (isAssignee && event.text) {
        const text = event.text.toLowerCase();

        // A. Done detection
        if (/\b(done|fixed|resolved|completed|closed)\b/i.test(text)) {
            try {
                await client.chat.postEphemeral({
                    channel: event.channel,
                    user: event.user,
                    thread_ts: event.thread_ts,
                    text: "I see you mentioned this might be done! Should I mark it as resolved?",
                    blocks: [
                        { type: "section", text: { type: "mrkdwn", text: "✨ *Detected completion!* Should I stop tracking this reminder?" } },
                        {
                            type: "actions",
                            elements: [
                                { type: "button", text: { type: "plain_text", text: "Yes, Resolve! ✅" }, action_id: "stop_reminder", value: r.id, style: "primary" },
                                { type: "button", text: { type: "plain_text", text: "No, ignore" }, action_id: "ignore_suggestion" }
                            ]
                        }
                    ]
                });
            } catch (e) { console.error('Suggestion failed', e); }
        }

        // B. Blocker/Waiting detection
        if (/\b(waiting|stuck|blocked|pending|dependency)\b/i.test(text)) {
            try {
                await client.chat.postEphemeral({
                    channel: event.channel,
                    user: event.user,
                    thread_ts: event.thread_ts,
                    text: "Need to pause nudges?",
                    blocks: [
                        { type: "section", text: { type: "mrkdwn", text: "⏸️ *I see you might be blocked.* Should I pause these reminders until you're ready?" } },
                        {
                            type: "actions",
                            elements: [
                                { type: "button", text: { type: "plain_text", text: "Pause Nudges ⏸️" }, action_id: "open_blocker_modal", value: r.id, style: "danger" },
                                { type: "button", text: { type: "plain_text", text: "Keep Pinging" }, action_id: "ignore_suggestion" }
                            ]
                        }
                    ]
                });
            } catch (e) { console.error('Blocker suggestion failed', e); }
        }
    }

    saveToDb(reminders);
});

// --- Initialization & Startup ---
(async () => {
    try {
        // 1. Connect to MongoDB
        if (!process.env.MONGODB_URI) {
            console.error('❌ MONGODB_URI is missing in .env!');
            console.error('👉 Please add MONGODB_URI=your_connection_string to your .env file.');
            console.error('👉 If on Render, add it in the Environment Variables section.');
            process.exit(1);
        }
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // 2. Load Data into Memory
        const dbReminders = await ReminderModel.find({});
        reminders = dbReminders.map(r => r.toObject());

        // Reset active pings on startup to prevent spam & initialize tracking fields
        reminders.forEach(r => {
            if (r.active && r.status === 'ACTIVE') {
                r.lastSent = new Date();
                r.dailyPingCount = 0;
            }
            // Ensure activity fields exist for old reminders
            if (!r.lastActivityAt) r.lastActivityAt = new Date();
            if (!r.lastAssigneeActivityAt) r.lastAssigneeActivityAt = new Date(0);
        });

        // Load Stats
        const globalStats = await GlobalStatsModel.findOne({ key: 'main' }) || { reminders_created: 0, channels_used: [] };
        const reports = await ReportModel.find({});
        adminStatsCache = {
            reminders_created: globalStats.reminders_created,
            channels_used: globalStats.channels_used,
            reports: reports.map(r => r.toObject())
        };
        console.log(`✅ Loaded ${reminders.length} reminders and ${reports.length} reports.`);

        // 3. Start Slack App
        await app.start();
        console.log('🚀 Jira Follow-up Bot is Live!');

    } catch (e) {
        console.error('❌ Startup Error:', e);
        process.exit(1);
    }
})();
