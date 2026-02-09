# 🚀 Deployment Guide: Slack Thread Reminder Bot (Render Free Tier)

This guide will walk you through hosting your Slack bot on **Render** using a **Web Service (Free Tier)**.

> **Note:** I have updated the code (`index.js`) to open a dummy web server. This is required because Render's free tier expects your app to listen on a port, even though we are using Socket Mode.

## Prerequisites

1.  **GitHub Account**: You already have this.
2.  **Render Account**: Sign up at [render.com](https://render.com/).
3.  **Slack App Credentials**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`.
4.  **MongoDB Connection String**: `MONGODB_URI`.

---

## Step 1: Create a Web Service on Render

1.  Log in to your Render Dashboard.
2.  Click **New +** and select **Web Service**.
3.  Connect your GitHub repository: `Varad-HV/slack-thread-reminder-bot`.
4.  **Name**: Give it a name like `slack-reminder-bot`.
5.  **Region**: Choose a region close to you.
6.  **Build Command**: `npm install`
7.  **Start Command**: `node index.js`
8.  **Instance Type**: **Free**
9.  **Advanced Settings** (Optional but good): Disable "Auto-Deploy" if you want to control when updates go live.

---

## Step 2: Configure Environment Variables

Scroll down to **Environment Variables** and add these:

| Variable Name | Value Description |
| :--- | :--- |
| `SLACK_BOT_TOKEN` | Your Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_APP_TOKEN` | Your App-Level Token (starts with `xapp-`) |
| `SLACK_SIGNING_SECRET` | Your App's Signing Secret |
| `ADMIN_USER_ID` | Your Slack User ID (e.g., `U12345678`) |
| `MONGODB_URI` | Your MongoDB Connection String |
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Render will likely set this automatically, but good to have) |

---

## Step 3: Verify Deployment

1.  Click **Create Web Service**.
2.  Wait for the build.
3.  In the logs, you should see:
    -   `✅ Connected to MongoDB`
    -   `✅ Dummy server listening on port 3000...`
    -   `🚀 Jira Follow-up Bot is Live!`

**Important:** Render's free tier spins down after inactivity. Since we have a "dummy" server now, Render will keep it alive as long as it receives traffic. However, for a Slack bot, it might sleep.
*   **Pro Tip:** Use a free uptime monitor (like UptimeRobot) to ping your Render URL (`https://your-bot-name.onrender.com`) every 5 minutes. This keeps the free tier active!

---

## 🛠️ Validation
Attempting to migrate legacy data? See the `src/scripts/migrate_json_to_mongo.js` script.
