# Architecture & Data Flow Diagram

## 🔄 Daily Workflow (Auto at 9 AM Weekdays)

```
┌─────────────────────────────────────────────────────────────┐
│                      EVERY 9 AM                              │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  cron.schedule('0 9 * * 1-5', async () => {                │
│    1. Load all reminders from DB                            │
│    2. Call calculateMetrics()                               │
│    3. Call findEscalationCandidates()                       │
│    4. Call analyzeReports()                                 │
│    5. Generate recommendations                             │
│    6. Build Slack blocks (dashboard)                        │
│    7. Upload CSV file                                       │
│    8. Post message + attach CSV to admin DM                │
│  })                                                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                            ↓
        Varad's Slack DM gets:
        ✅ Rich dashboard message
        ✅ CSV attachment (13 columns)
        ✅ All metrics + recommendations
```

---

## 📊 Data Processing Pipeline

```
┌──────────────┐
│ reminders[]  │  (loaded from DB on startup)
└──────┬───────┘
       │
       ├─────────────────────┬─────────────────────┬─────────────────────┐
       │                     │                     │                     │
       ▼                     ▼                     ▼                     ▼
   
calculateMetrics()      findEscalations()    analyzeReports()   [Raw Data]
   │                        │                    │
   ├─ Group by assignee    ├─ Filter ≥15 pings  ├─ Count reasons
   ├─ Sum resolution time  ├─ Filter blocked >24h├─ Calculate %
   ├─ Calc avg pings       ├─ Sort by pings     ├─ Rank by frequency
   └─ Efficiency score     └─ ~3-5 results      └─ List top issues
        │                        │                    │
        ▼                        ▼                    ▼
   {assigneeMetrics}      [{escalations}]     {reportAnalytics}
        │                        │                    │
        └────────────────────────┼────────────────────┘
                                 │
                 generateRecommendations()
                                 │
                ┌────────────────┼────────────────┐
                ▼                ▼                ▼
            Insight1          Insight2         Insight3
           (Risk Alert)    (Process Issue)   (Support Needed)
                │                │                │
                └────────────────┼────────────────┘
                                 │
                     [Admin sees on Dashboard]
                     + CSV download
```

---

## 🎯 Admin Dashboard Structure

```
┌─────────────────────────────────────────────────┐
│ 📊 Admin Dashboard - Full Insights              │
├─────────────────────────────────────────────────┤
│ QUICK STATS                                     │
│ Total: 28 | Active: 4 | Resolved: 21 ...       │
├─────────────────────────────────────────────────┤
│ EFFICIENCY METRICS                              │
│ Avg Days: 3.2 | Avg Pings: 2.1 | Rate: 75%    │
├─────────────────────────────────────────────────┤
│ TOP PERFORMERS                                  │
│ ⭐4.8 @john (8 done in 2.1d)                   │
│ ⭐4.5 @sarah (6 done in 2.8d)                  │
│ ⭐3.9 @mike (7 done in 3.5d)                   │
├─────────────────────────────────────────────────┤
│ ESCALATION ALERTS                               │
│ ⚠️ "SDK bug" - 16 pings | View Thread           │
│ ⚠️ "Auth fix" - 15 pings | View Thread          │
├─────────────────────────────────────────────────┤
│ REPORT BREAKDOWN                                │
│ INVALID: 2 (67%) | SPAM: 1 (33%)               │
├─────────────────────────────────────────────────┤
│ RECOMMENDATIONS                                 │
│ 1. 2 tickets at risk - consider intervention   │
│ 2. Invalid reports are 67% - process issue?    │
│ 3. Check in with @mike - needs support?        │
├─────────────────────────────────────────────────┤
│ ATTACHMENT: Admin_Report_2026-01-28.csv        │
│ (13 columns, all reminders, full metrics)      │
└─────────────────────────────────────────────────┘
```

---

## 💾 CSV Data Structure

```
Admin_Report_2026-01-28.csv

Row Headers (13 columns):
Ticket | Assignee | Status | Pings | Priority | Created | 
Resolution Days | Channel | Thread Link | Blocker Reason | 
Escalated | Assignee Efficiency | Jira

Example Rows:
"Update SDK version" | john | ACTIVE | 16 | High | 2026-01-20 | 
Active | C123 | https://slack.com/..../p... | None | YES | 4.8 | https://jira...

"Fix auth bug" | sarah | ACTIVE | 15 | Critical | 2026-01-19 | 
Active | C123 | https://slack.com/..../p... | None | YES | 4.5 | https://jira...

"Database migration" | mike | RESOLVED | 5 | Medium | 2026-01-25 | 
2.1 | C456 | https://slack.com/..../p... | None | NO | 3.9 | https://jira...

(28 rows total = all reminders)
```

---

## 🔄 Escalation Alert Logic (Every Minute)

```
cron.schedule('* * * * *', async () => {
    
    for each reminder:
        
        if not ACTIVE or BLOCKED/WAITING:
            skip (paused)
        
        if time to send:
            send ping message
            r.pingCount++
            
            ┌─────────────────────────────────────────┐
            │ NEW: Escalation Check                   │
            ├─────────────────────────────────────────┤
            │ if (r.pingCount === 15) {  // Exactly   │
            │   send alert to ADMIN_USER_ID:          │
            │   "🚨 Ticket '{name}' hit threshold"   │
            │   Thread: {link}                        │
            │   Pings: {count}                        │
            │   Priority: {priority}                  │
            │ }                                        │
            └─────────────────────────────────────────┘
            
            saveToDb(reminders)
})
```

---

## ⭐ Efficiency Score Calculation

```
For each assignee:

1. Find all RESOLVED reminders they handled
   Resolved = [reminder1, reminder2, ...]

2. For each resolved reminder, calculate:
   resolution_days = (resolved_at - created_at) / (1000 * 60 * 60 * 24)
   Sum all resolution_days
   Average = total_days / count_resolved

3. Count pings for each resolved:
   total_pings = sum of all pingCounts
   Average = total_pings / count_resolved

4. Apply efficiency formula:
   
   ┌──────────────────────────────────────────────────┐
   │ Score = 5 - (avg_resolution_days / 2)           │
   │           - (avg_pings_per_task / 5)            │
   │                                                  │
   │ Min: 1.0  (very slow)                          │
   │ Max: 5.0  (super fast)                         │
   └──────────────────────────────────────────────────┘

Example:
John: avg 2 days, avg 1.2 pings
Score = 5 - (2/2) - (1.2/5)
Score = 5 - 1 - 0.24
Score = 3.76 ⭐ (rounds to 3.8)

Sarah: avg 3 days, avg 2 pings
Score = 5 - (3/2) - (2/5)
Score = 5 - 1.5 - 0.4
Score = 3.1 ⭐
```

---

## 🎯 Command Flow

```
USER INPUT
    │
    ├─ /sa-report
    │  └─ sendDashboardAndCSV(user_id)
    │     ├─ Load reminders where created_by = user_id
    │     ├─ Build dashboard message
    │     ├─ generateCSVContent(user_id)
    │     ├─ Upload CSV to DM
    │     └─ Send dashboard blocks
    │
    ├─ /admin-stats (admin only)
    │  └─ sendAdminDashboard() [FULL VERSION]
    │     ├─ calculateMetrics()
    │     ├─ findEscalationCandidates()
    │     ├─ analyzeReports()
    │     ├─ generateRecommendations()
    │     ├─ Build rich dashboard
    │     ├─ generateAdminCSV()
    │     └─ Send + upload to admin DM
    │
    ├─ /admin-escalations (admin only)
    │  └─ findEscalationCandidates()
    │     ├─ Filter: pings ≥ 15 OR blocked > 24h
    │     └─ Format + send detail view
    │
    └─ /admin-workload (admin only)
       └─ Group reminders by assignee
          ├─ Count: active, blocked, completed
          └─ Send workload snapshot
```

---

## 📈 Analysis Workflow

```
DAILY (9 AM)
    │
    └─→ Dashboard + CSV arrives in DM
        │
        ├─ Scan top performers
        ├─ Check escalations
        ├─ Read recommendations
        └─ Take action

WEEKLY (Every Friday)
    │
    └─→ Collect 5 recent CSVs
        │
        ├─ Download all
        ├─ Paste into Excel
        ├─ Create pivot table
        ├─ Calculate trends:
        │  ├─ Avg resolution time
        │  ├─ Completion rate
        │  └─ Per-assignee metrics
        └─ Identify improvements

MONTHLY (End of month)
    │
    └─→ Compare to previous month
        │
        ├─ Is velocity improving?
        ├─ Are escalations down?
        ├─ Report to leadership
        ├─ Plan next sprint
        └─ Celebrate wins!
```

---

## 🔐 Permission Model

```
Bot Actions (All Users):
    │
    ├─ set_thread_reminder → Create reminder
    ├─ /sa-report → Get personal dashboard + CSV
    ├─ Click buttons → Done, Blocked, ETA, Report
    └─ View dashboards in thread → Yes

Admin Actions (ADMIN_USER_ID only):
    │
    ├─ /admin-stats → Full dashboard + CSV
    ├─ /admin-escalations → Escalation list
    ├─ /admin-workload → Workload distribution
    └─ Auto-receive @ 9 AM → Dashboard + CSV

Non-Admin trying /admin-*:
    │
    └─ postEphemeral: "You don't have permission"
       (message visible only to them)
```

---

## 🗄️ Database State

```
reminders_db.json
└─ reminders[] (loaded on startup)
   ├─ id, channel, thread_ts
   ├─ assignee, assigneeName, created_by
   ├─ created_at, resolved_at  [NEW: resolved_at]
   ├─ frequencyMinutes, priority
   ├─ note, jira
   ├─ status (ACTIVE | BLOCKED | WAITING_ON_SA | RESOLVED)
   ├─ pingCount, dailyPingCount
   ├─ active (true/false), lastSent, etaNotified
   ├─ eta?, blockerReason?
   └─ [more fields...]

admin_stats.json
├─ reminders_created
├─ reports[]
│  ├─ type, reminder_id, reporter, ticket, timestamp
│  └─ ...
├─ channels_used[]
└─ (assignee_metrics - optional for future caching)
```

---

## 🚀 Performance Metrics

```
calculateMetrics()
    Input: reminders[] (28 reminders)
    Logic: O(n) iteration, grouping, averaging
    Time: ~100ms

findEscalationCandidates()
    Input: reminders[] (28 reminders)
    Logic: O(n) scan + filter
    Time: ~10ms

analyzeReports()
    Input: stats.reports (3 reports)
    Logic: O(m) count + percentage
    Time: ~5ms

generateAdminCSV()
    Input: metrics + reminders[] (28)
    Logic: O(n) string building
    Time: ~300ms

Total Slack API calls:
    - conversations.open() → ~500ms
    - chat.postMessage() → ~1500ms
    - files.uploadV2() → ~500ms
    
Total Dashboard Send Time: ~2.5 seconds
```

---

## 🎯 Use Cases

### Use Case 1: Identify Top Performer
```
Tuesday 9 AM Dashboard arrives
→ See @john with ⭐4.8 efficiency
→ Recognize publicly in team chat
→ John feels valued
```

### Use Case 2: Unblock Stuck Ticket
```
Tuesday 9 AM Dashboard arrives
→ See "SDK bug" with 16 pings
→ Click "View Thread" link
→ Jump directly to Slack thread
→ Offer help: "Let me take this one"
```

### Use Case 3: Detect Process Issue
```
Tuesday 9 AM Dashboard arrives
→ Report breakdown: INVALID 67%
→ Realize: team doesn't understand bot
→ Email team: proper use guide
→ Next month: INVALID drops to 20%
```

### Use Case 4: Balance Workload
```
Friday afternoon
→ Run /admin-workload
→ See @sarah has 5 active, @mike has 1
→ DM @mike: "Want to take one of Sarah's?"
→ Next week: distribution more even
```

---

## 📋 State Transitions

```
Reminder State Machine (with new tracking):

    ┌─────────────────────┐
    │ ACTIVE              │
    │ (actively pinging)  │
    └──────────┬──────────┘
               │
         ┌─────┴─────┐
         │           │
         ▼           ▼
    BLOCKED      RESOLVED
    (paused)     (done)
    [pingCount]  [pingCount + resolved_at]
    [blocker]    [used in metrics]
         │           ▲
         │           │
         └───────────┘
          (resume)

Every resolve:
    ├─ Set resolved_at = now
    ├─ Used in: calculateMetrics()
    └─ Enables: efficiency score calculation
```

This architecture ensures:
✅ Real-time alerting (escalations every minute)
✅ Daily insights (9 AM dashboard)
✅ Weekly analysis (CSV export)
✅ Data-driven decisions (metrics + recommendations)
✅ Fair treatment (workload view)
✅ Process improvement (report analytics)
