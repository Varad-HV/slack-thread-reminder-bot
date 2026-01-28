# Quick Reference - New Bot Commands & Features

## 📋 User Commands

### `/sa-report`
**What:** Get your personal Jira dashboard + CSV export
**Output:** 
- Dashboard with your top 5 active tasks
- CSV file: `Task_Report.csv` with all your reminders
- Use in: Any DM or channel

**Columns in CSV:**
- Created At, Assignee, Status, Pings, Priority, ETA, Report Reason, Jira Link, Slack Link, Note

---

## 🔐 Admin-Only Commands

### `/admin-stats`
**What:** Manually trigger full admin dashboard
**Output:**
- Quick stats (Total, Active, Resolved, Blocked, Waiting)
- Efficiency metrics (avg resolution time, pings/task, completion rate)
- Top 3 performers with efficiency scores
- Escalation alerts (15+ pings)
- Report breakdown by reason
- AI recommendations
- CSV export: `Admin_Report_[DATE].csv` (13 columns)

**Who:** Only `ADMIN_USER_ID` (set in .env)
**When:** Use anytime, automatically sent at 9 AM weekdays

---

### `/admin-escalations`
**What:** See all high-risk tickets that need attention
**Criteria:**
- Ping count ≥ 15, OR
- Blocked > 24 hours

**Output per ticket:**
- Ticket name
- Assignee
- Priority level
- Current ping count
- Hours active
- Direct Slack thread link

**Action:** Manually intervene, reassign, or reprioritize

---

### `/admin-workload`
**What:** See how work is distributed across team
**Output:** Table with per-assignee breakdown
- Active reminders count
- Blocked reminders count
- Completed count

**Use for:** 
- Identifying overloaded team members
- Balancing work distribution
- Performance conversations

---

## 📊 Auto-Sent Features

### Daily Admin Dashboard (9 AM, Weekdays)
**Automatically sent to:** `ADMIN_USER_ID` (in Slack DM)
**Includes:**
1. Quick stats banner
2. Efficiency metrics
3. Top 3 performers (ranked by score)
4. All escalation alerts
5. Report reason breakdown
6. Smart recommendations (3-5 actionable insights)
7. Admin CSV export

**No action needed** - arrives automatically!

---

## 📈 CSV Exports

### User CSV (`/sa-report`)
**File:** `Task_Report.csv`
**Rows:** Your created reminders only
**Columns:** 10
- Created At
- Assignee
- Status
- Pings
- Priority
- ETA
- Report Reason
- Jira Link
- Slack Link
- Note

---

### Admin CSV (Auto-sent dashboard)
**File:** `Admin_Report_[YYYY-MM-DD].csv`
**Rows:** ALL reminders (entire team)
**Columns:** 13
- Ticket name
- Assignee
- Status
- Pings
- Priority
- Created date
- Resolution days (or "Active")
- Channel
- Thread Link
- Blocker Reason
- Escalated (YES/NO)
- Assignee Efficiency Score
- Jira Link

**Great for:**
- Excel analysis
- Trend tracking
- Historical records
- Sharing with leadership

---

## 🌟 Efficiency Score Explained

**Scale:** 1-5 stars ⭐

**How it's calculated:**
```
Score = 5 - (avg_resolution_days / 2) - (avg_pings_per_task / 5)
```

**Interpretation:**
- **5.0 stars:** Super fast, needs almost no follow-ups
- **4.0+ stars:** Great performer, very responsive
- **3.0-4.0:** Good, normal pace
- **2.0-3.0:** Slower, needs more reminders
- **< 2.0:** Very slow or many blocks

**What it measures:**
- How quickly they complete work
- How responsive they are to nudges
- Overall efficiency

---

## 🚨 Escalation Alert Logic

**Escalation triggered when:**
1. A reminder reaches 15 pings, OR
2. A reminder is blocked for >24 hours

**What happens:**
- Admin gets instant Slack notification
- Alert includes: ticket, assignee, priority, thread link
- Suggestions: manual intervention, reprioritization, reassignment

**Use case:** Catch stuck tickets before they become critical delays

---

## 📌 Key Metrics Explained

### Average Resolution Days
**What:** How many days (on average) it takes to complete a ticket

### Average Pings Per Task
**What:** How many times we had to nudge before someone completed

### Completion Rate
**What:** % of reminders that are fully resolved (vs. still active/blocked)

### Assignee Efficiency
**What:** Personal efficiency score (1-5 stars) based on speed + responsiveness

---

## 💡 Pro Tips

1. **Check `/admin-escalations` daily** to catch problems early
2. **Use `/admin-workload` before assigning new tickets** to avoid overloading anyone
3. **Export CSV weekly** to track trends in Excel/Sheets
4. **Act on recommendations** - they're data-driven insights about your process
5. **Look for escalation patterns** - if "SPAM" reports are high, educate team on proper use

---

## ⚙️ Configuration

### In `.env` file:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
ADMIN_USER_ID=U12345...      # Set this! (your Slack user ID)
BYPASS_WORKING_HOURS=false   # Set to true only for testing
```

### Thresholds (in code):
- **15 pings** = escalation alert
- **10 pings/day** = max daily nudges per ticket
- **24 hours** = time before blocked ticket escalates

### Auto-send schedule:
- **9 AM, Monday-Friday** = Admin dashboard + CSV
- **Every minute** = Check for due pings (respects working hours: 9-18)

---

## 🔧 Troubleshooting

**Q: I'm admin but `/admin-stats` says "no permission"**
A: Check `ADMIN_USER_ID` in `.env` matches your Slack user ID

**Q: Why is CSV not in admin dashboard?**
A: Updated! It now auto-uploads. Check channel for attachment.

**Q: Efficiency score seems wrong**
A: It only calculates for completed reminders. Need at least 1 resolved ticket.

**Q: How do I know my efficiency score?**
A: Check admin dashboard - you'll be in the "Top Performers" list with your score

---

## 📊 Analysis Workflow

### Daily (9 AM):
1. Admin gets dashboard + CSV in DM
2. Skim quick stats
3. Read recommendations
4. Check escalations column

### Weekly:
1. Download CSV
2. Paste into Excel/Sheets
3. Create pivot table by assignee
4. Track trend: avg resolution time decreasing?
5. Share insights with team

### Monthly:
1. Compare CSVs month-over-month
2. Calculate team velocity
3. Identify process improvements
4. Celebrate top performers!
