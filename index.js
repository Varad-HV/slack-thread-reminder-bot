require('dotenv').config();
const { App } = require('@slack/bolt');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

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
    resolved_at: Date
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
    channels_used: [String]
});
const GlobalStatsModel = mongoose.model('GlobalStats', GlobalStatsSchema);

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

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'U123'; // Set in .env 
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

const getStartupGreeting = (user) => {
  const hour = new Date().getHours();
  let greet = "Ready to crush it?";
  if (hour < 12) greet = "Morning caffeine kick! ☕";
  else if (hour >= 12 && hour <= 14) greet = "Hope lunch was great! 🥗";
  else greet = "Evening vibes. 🌅";
  return `${greet} <@${user}>,`;
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
            { type: "button", text: { type: "plain_text", text: "ETA" }, action_id: "open_eta_modal", value: reminder.id },
            { type: "button", text: { type: "plain_text", text: "Report" }, action_id: "report_ticket", value: reminder.id }
        );
    } else if (!reminder.active && reminder.status !== 'RESOLVED') {
        // Always show Resume when paused
        actions.push({ type: "button", text: { type: "plain_text", text: "🚀 Resume" }, action_id: "resume_nudges", value: reminder.id });
    }

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

const generateCSVContent = (creatorId) => {
    const myReminders = reminders.filter(r => r.created_by === creatorId);
    if (myReminders.length === 0) return null;
    let csv = "Created At,Assignee,Status,Pings,Priority,ETA,Report Reason,Jira Link,Slack Link,Note\n";
    myReminders.forEach(r => {
        const stats = getAdminStats();
        const report = (stats.reports || []).find(rep => rep.reminder_id === r.id);
        const reportReason = report ? report.type : "None";
        const row = [
            new Date(r.created_at).toISOString().split('T')[0],
            `"${r.assigneeName}"`,
            r.status,
            r.pingCount,
            r.priority || 'N/A',
            r.eta || 'Not Set',
            reportReason,
            r.jira || 'Not Provided',
            getThreadLink(r.channel, r.thread_ts),
            `"${r.note.replace(/"/g, '""')}"`
        ];
        csv += row.join(",") + "\n";
    });
    return csv;
};

// sendDashboardAndCSV supports an optional stagger offset (ms)
const sendDashboardAndCSV = async (userId, offsetMs = 0) => {
    const sendNow = async () => {
        const myThreads = reminders.filter(r => r.created_by === userId && r.active);
        if (myThreads.length === 0) return;

        try {
            const dm = await app.client.conversations.open({ users: userId });
            const channelId = dm.channel.id;

            const blocks = [
                { type: "header", text: { type: "plain_text", text: "📋 Your Jira Dashboard" } },
                { type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}>, you have *${myThreads.length}* active tasks.` } }
            ];

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

            const csvContent = generateCSVContent(userId);
            if (csvContent) {
                await app.client.files.uploadV2({
                    channel_id: channelId,
                    content: csvContent,
                    filename: `Task_Report.csv`,
                    initial_comment: "📊 *Task Data Export:* Your tasks are ready for analysis."
                });
            }
        } catch (e) { console.error("Report Fail", e); }
    };

    if (offsetMs && offsetMs > 0) {
        setTimeout(() => { sendNow().catch(e => console.error('sendDashboardAndCSV failed', e)); }, offsetMs);
    } else {
        await sendNow();
    }
};

const sendAdminDashboard = async () => {
    if (!ADMIN_USER_ID || ADMIN_USER_ID === 'U123') return; // Skip if not configured
    
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
            { type: "header", text: { type: "plain_text", text: "📊 Admin Dashboard" } },
            
            // Quick Stats Section
            { type: "section", text: { type: "mrkdwn", text: "*📈 Quick Stats*" } },
            { type: "section", fields: [
                { type: "mrkdwn", text: `*Total Reminders*\n${reminders.length}` },
                { type: "mrkdwn", text: `*Active*\n${activeCount}` },
                { type: "mrkdwn", text: `*Resolved* ✅\n${resolvedCount}` },
                { type: "mrkdwn", text: `*Blocked* 🔴\n${blockedCount}` }
            ]},
            
            { type: "divider" },
            
            // Efficiency Metrics
            { type: "section", text: { type: "mrkdwn", text: "*⚡ Team Performance*" } },
            { type: "section", fields: [
                { type: "mrkdwn", text: `*Completion Rate*\n${metrics.completionRate}%` },
                { type: "mrkdwn", text: `*Avg Resolution*\n${metrics.avgResolutionDays.toFixed(1)} days` },
                { type: "mrkdwn", text: `*Avg Pings/Task*\n${metrics.avgPingsPerTask.toFixed(1)}` },
                { type: "mrkdwn", text: `*Waiting on SA*\n${waitingCount}` }
            ]},
            
            { type: "divider" },
            
            // Top Performers
            { type: "section", text: { type: "mrkdwn", text: "*🏆 Top Performers*" } }
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
                    text: { type: "mrkdwn", text: `*"${r.note}"*\n👤 <@${r.assignee}> | 🔥 ${r.pingCount} pings | ⏱️ ${hoursActive}h active | 🎯 ${r.priority}\n<${getThreadLink(r.channel, r.thread_ts)}|→ View Thread>` }
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
        const recipients = [ADMIN_USER_ID].filter(Boolean);
        const csvContent = generateAdminCSV(metrics, escalations);
        recipients.forEach((userId, idx) => {
            const delay = idx * 1500; // 1.5 seconds per user
            setTimeout(async () => {
                try {
                    const dm = await app.client.conversations.open({ users: userId });
                    await app.client.chat.postMessage({ channel: dm.channel.id, blocks, text: "Admin Dashboard" });
                    if (csvContent) {
                        await app.client.files.uploadV2({
                            channel_id: dm.channel.id,
                            content: csvContent,
                            filename: `Admin_Report_${new Date().toISOString().split('T')[0]}.csv`,
                            initial_comment: "📊 *Complete Admin Export*"
                        });
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
        recommendations.push(`💡 Check in with ${poorPerformers.join(', ')} - might need support or clarity`);
    }
    
    if (metrics.completionRate < 50) {
        recommendations.push(`⏱️ Completion rate is ${metrics.completionRate}% - consider reviewing priority/scope`);
    }
    
    return recommendations.length > 0 ? recommendations.map((r, i) => `${i+1}. ${r}`).join('\n') : "✅ Everything looks good!";
};

/**
 * Generate comprehensive admin CSV with all metrics
 */
const generateAdminCSV = (metrics, escalations) => {
    const escalationIds = new Set(escalations.map(r => r.id));
    let csv = "Ticket,Assignee,Reporter,Status,Pings,Priority,Created,Resolution Days,Channel,Thread Link,Blocker Reason,Escalated,Assignee Efficiency,Jira\n";
    
    reminders.forEach(r => {
        const assigneeData = metrics.assigneeMetrics[r.assignee];
        const resolutionDays = r.status === 'RESOLVED' 
            ? ((new Date(r.resolved_at || new Date()) - new Date(r.created_at)) / (1000 * 60 * 60 * 24)).toFixed(1)
            : 'Active';
        const efficiency = assigneeData ? assigneeData.efficiencyScore.toFixed(1) : 'N/A';
        const isEscalated = escalationIds.has(r.id) ? 'YES' : 'NO';
        
        const row = [
            `"${r.note.replace(/"/g, '""')}"`,
            `"${r.assigneeName}"`,
            `"${r.creatorName}"`,
            r.status,
            r.pingCount,
            r.priority || 'N/A',
            new Date(r.created_at).toISOString().split('T')[0],
            resolutionDays,
            r.channel,
            getThreadLink(r.channel, r.thread_ts),
            r.blockerReason ? `"${r.blockerReason.replace(/"/g, '""')}"` : 'None',
            isEscalated,
            efficiency,
            r.jira || 'N/A'
        ];
        csv += row.join(",") + "\n";
    });
    
    return csv;
};

// ---------------------------
// 4. Creation Flow
// ---------------------------

app.shortcut('set_thread_reminder', async ({ shortcut, ack, client }) => {
  await ack();
  const channel = (shortcut.channel?.id || shortcut.message?.channel?.id);
  const thread_ts = (shortcut.message?.ts || shortcut.shortcut_ts);

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
        { type: 'input', block_id: 'priority_block', element: { type: 'static_select', action_id: 'priority', options: [
            { text: { type: 'plain_text', text: '🔴 Critical - Every 2 hours' }, value: 'Critical' },
            { text: { type: 'plain_text', text: '🟠 High - Every 6 hours' }, value: 'High' },
            { text: { type: 'plain_text', text: '🟡 Medium - Daily morning' }, value: 'Medium' },
            { text: { type: 'plain_text', text: '🟢 Low - Every 2 days' }, value: 'Low' }
        ] }, label: { type: 'plain_text', text: 'Priority Level' } },
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

  const priority = view.state.values.priority_block.priority.selected_option.value;
  let frequencyMinutes;
  switch (priority) {
    case 'Critical': frequencyMinutes = 120; break;
    case 'High': frequencyMinutes = 360; break;
    case 'Medium': frequencyMinutes = 1440; break;
    case 'Low': frequencyMinutes = 2880; break;
    default: frequencyMinutes = 1440;
  }

  const reminder = {
    id: uuidv4(),
    channel: metadata.channel,
    thread_ts: metadata.thread_ts,
    assignee: assigneeId,
    assigneeName: assigneeInfo.user.real_name,
    created_by: body.user.id,
    creatorName: creatorInfo.user.real_name,
    created_at: new Date(),
    frequencyMinutes: frequencyMinutes,
    priority: priority,
    note: view.state.values.note_block.note.value,
    jira: view.state.values.jira_block.jira?.value || '',
    status: 'ACTIVE',
    pingCount: 0,
    dailyPingCount: 0,
    active: true,
    lastSent: new Date(),
    etaNotified: false
  };

  reminders.push(reminder);
  saveToDb(reminders);

  // Save to admin stats
  const stats = getAdminStats();
  stats.reminders_created = (stats.reminders_created || 0) + 1;
  if (!stats.channels_used) stats.channels_used = [];
  if (!stats.channels_used.includes(metadata.channel)) stats.channels_used.push(metadata.channel);
  try {
      const tmp = ADMIN_DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
      fs.renameSync(tmp, ADMIN_DB_FILE);
  } catch (e) {
      console.error('Could not write admin stats atomically:', e);
  }
  // Save to admin stats (Async update)
  updateGlobalStats(metadata.channel);

  // Education message - engaging with personality
  await client.chat.postMessage({
    channel: reminder.channel,
    thread_ts: reminder.thread_ts,
    text: `Follow-up created`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Follow-up Reminder Set ✨" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi <@${assigneeId}> 👋\n\nA reminder for this has been set by <@${body.user.id}>. We'll check in regularly to keep things moving.\n\nPro tip: Setting a target date means we'll stop bugging you until the final day. Smart move!`
        }
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*What you can do:*\n✅ *Done* - Task complete\n🛑 *Blocked* - Hit a blocker? Pause reminders\n📅 *Target Date* - Tell us when you'll finish. We'll remind you 1 day before\n🚩 *Report* - Something's off? Flag it"
        }
      }
    ]
  });

  // Send the action card separately so assignee can interact
  await client.chat.postMessage({
    channel: reminder.channel,
    thread_ts: reminder.thread_ts,
    blocks: buildThreadBlock(reminder),
    text: "Actions available"
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
    const r = reminders.find(rem => rem.id === action.value);
    if (!r || !r.active || r.status === 'RESOLVED') return;
    
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
});

// ---------------------------
// 6. ETA Logic
// ---------------------------

app.action('open_eta_modal', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (!r || !r.active || r.status === 'RESOLVED') return;
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
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    // Respect working days/hours strictly in production
    if (!WORKING_DAYS.includes(day) || hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) return;

    for (const r of reminders.filter(r => r.active)) {
        if (r.status === 'BLOCKED' || r.status === 'WAITING_ON_SA') continue; // Pause on blocker or waiting

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
                        await app.client.chat.postMessage({
                            channel: r.channel, thread_ts: r.thread_ts,
                            text: `Target date is tomorrow! Make sure this is ready.`
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
                    contextMsg = `${getStartupGreeting(target)} quick status update on this? We have it targeted for ${r.eta}`;
                } else {
                    contextMsg = `${getStartupGreeting(target)} any progress? If you can, drop a target date so we can plan around it 📅`;
                }
                
                await app.client.chat.postMessage({
                    channel: r.channel, thread_ts: r.thread_ts,
                    text: "Friendly Check-in",
                    blocks: [
                        { type: "section", text: { type: "mrkdwn", text: contextMsg } },
                        { type: "actions", elements: [
                            { type: "button", text: { type: "plain_text", text: "Done" }, action_id: "stop_reminder", value: r.id, style: "primary" },
                            { type: "button", text: { type: "plain_text", text: "Blocked" }, action_id: "open_blocker_modal", value: r.id, style: "danger" },
                            { type: "button", text: { type: "plain_text", text: "Target Date" }, action_id: "open_eta_modal", value: r.id },
                            { type: "button", text: { type: "plain_text", text: "Report" }, action_id: "report_ticket", value: r.id }
                        ]}
                    ]
                });
                r.lastSent = now; 
                r.pingCount++; 
                r.dailyPingCount++;
                
                // Escalation alert: if ping count hits threshold, notify admin
                if (r.pingCount === ESCALATION_PING_THRESHOLD) {
                    try {
                        const dm = await app.client.conversations.open({ users: ADMIN_USER_ID });
                        await app.client.chat.postMessage({
                            channel: dm.channel.id,
                            text: `⚠️ ESCALATION ALERT`,
                            blocks: [
                                { type: "section", text: { type: "mrkdwn", text: `🚨 Ticket in limbo: "*${r.note}*" for <@${r.assignee}> has reached ${r.pingCount} pings.\n*Priority:* ${r.priority} | *Assigned by:* <@${r.created_by}>\n<${getThreadLink(r.channel, r.thread_ts)}|View Thread>` } }
                            ]
                        });
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

// Daily Reset for Ping Counts & Admin Dashboard
// Reset daily ping counts and send admin dashboard every 2 days at 09:00
cron.schedule('0 9 */2 * *', async () => {
    reminders.forEach(r => r.dailyPingCount = 0);
    saveToDb(reminders);
    // Staggered admin send handled inside sendAdminDashboard
    await sendAdminDashboard();
});

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

            // Warn creator at 25 days for resolved reminders
            if (r.status === 'RESOLVED' && ageDays >= 25 && ageDays < 30) {
                warnings.push({ reminder: r, days: ageDays });
            }

            // Delete permanently at 30+ days for RESOLVED or BLOCKED
            if ((r.status === 'RESOLVED' || r.status === 'BLOCKED') && ageDays >= 30) {
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
                        { type: 'section', text: { type: 'mrkdwn', text: `Hi <@${reminder.created_by}>, your reminder "*${reminder.note}*" is ${days} days old and marked ${reminder.status}. It will be automatically purged in ${30 - days} day(s). If you'd like to keep a record, run /sa-report to download your tasks.` } }
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
                    // Generate per-creator CSV BEFORE deletion and send as final archive
                    const csv = generateCSVContent(r.created_by);
                    if (csv) {
                        const dm = await app.client.conversations.open({ users: r.created_by });
                        await app.client.files.uploadV2({
                            channel_id: dm.channel.id,
                            content: csv,
                            filename: `Final_Archive_${new Date().toISOString().split('T')[0]}.csv`,
                            initial_comment: `📦 Final Archive: reminder "${r.note}" is being purged from the system.`
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
});

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

app.action('stop_reminder', async ({ ack, body, action, client }) => {
    await ack();
    const r = reminders.find(rem => rem.id === action.value);
    if (!r || !r.active || r.status === 'RESOLVED') return;
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
app.command('/admin-stats', async ({ ack, body, client }) => {
    await ack();
    if (body.user_id !== ADMIN_USER_ID) {
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
    if (body.user_id !== ADMIN_USER_ID) {
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
            text: { type: "mrkdwn", text: `*"${r.note}"*\n👤 <@${r.assignee}> | 📍 ${r.priority} | 📊 ${r.pingCount} pings | ⏱️ Active ${Math.round(hoursActive)}h\n<${getThreadLink(r.channel, r.thread_ts)}|View Thread>` }
        });
    });
    
    await client.chat.postMessage({ channel: body.channel_id, blocks, text: "Attention Needed" });
});

app.command('/admin-workload', async ({ ack, body, client }) => {
    await ack();
    if (body.user_id !== ADMIN_USER_ID) {
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
        { type: "header", text: { type: "plain_text", text: "📊 Team Workload Distribution" } },
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

// --- Initialization & Startup ---
(async () => {
    try {
        // 1. Connect to MongoDB
        if (!process.env.MONGODB_URI) {
            console.error('❌ MONGODB_URI is missing in .env!');
            process.exit(1);
        }
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // 2. Load Data into Memory
        const dbReminders = await ReminderModel.find({});
        reminders = dbReminders.map(r => r.toObject());
        
        // Reset active pings on startup to prevent spam
        reminders.forEach(r => {
            if (r.active && r.status === 'ACTIVE') {
                r.lastSent = new Date();
                r.dailyPingCount = 0;
            }
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
