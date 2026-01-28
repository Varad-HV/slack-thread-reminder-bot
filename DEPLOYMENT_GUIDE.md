# 🚀 Deployment Guide: Slack Thread Reminder Bot

This guide will walk you through hosting your Slack bot on **Railway**, a platform that makes it easy to deploy Node.js applications.

## Prerequisites

1.  **GitHub Account**: You already have this since your code is on GitHub.
2.  **Railway Account**: Sign up at [railway.app](https://railway.app/) using your GitHub account.
3.  **Slack App Credentials**: You should have your `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` ready.

---

## Step 1: Create a Project on Railway

1.  Log in to your [Railway Dashboard](https://railway.app/dashboard).
2.  Click **+ New Project**.
3.  Select **Deploy from GitHub repo**.
4.  Select your repository: `Varad-HV/slack-thread-reminder-bot`.
5.  Click **Deploy Now**.

Railway will start the initial build, but it might fail or not work correctly yet because we haven't set up the environment variables. That's expected!

---

## Step 2: Configure Environment Variables

1.  Click on your project card in Railway.
2.  Click on the **Variables** tab.
3.  Add the following variables (copy values from your local `.env` or Slack App configuration):

| Variable Name | Value Description |
| :--- | :--- |
| `SLACK_BOT_TOKEN` | Your Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_APP_TOKEN` | Your App-Level Token (starts with `xapp-`) |
| `SLACK_SIGNING_SECRET` | Your App's Signing Secret |
| `ADMIN_USER_ID` | Your Slack User ID (e.g., `U12345678`) for admin alerts |
| `NODE_ENV` | Set this to `production` |
| `DATA_PATH` | Set this to `/app/data` (We will create this volume next) |
| `PORT` | Set this to `3000` (Optional, but good practice) |

---

## Step 3: Set Up Persistence (Volumes)

Since your bot saves reminders to a JSON file (`reminders_db.json`), you need a persistent storage volume. Without this, every time you redeploy, your database would be wiped!

1.  In your Railway project, go to the **Settings** tab.
2.  Scroll down to the **Service** section (or look for **Volumes**).
3.  Click **+ Add Volume**.
4.  Mount Path: `/app/data`
5.  Click **Add**.

**Why this matters:**
- We set `DATA_PATH` to `/app/data` in the variables.
- We mounted a volume at `/app/data`.
- The code checks `process.env.DATA_PATH` to decide where to save the DB files.
- Now, your `reminders_db.json` and `admin_stats.json` will be saved in this persistent volume and survive restarts/redeploys.

---

## Step 4: Verify Deployment

1.  Once variables and volumes are set, Railway usually triggers a redeploy automatically. If not, go to the **Deployments** tab and click **Redeploy**.
2.  Wait for the build to finish and the status to turn **Active** (Green).
3.  Click on the **Logs** tab to see the live output.
4.  You should see: `Jira Follow-up Bot is Live!` and `Health check running on port 3000`.

---

## Step 5: Test Your Bot

1.  Go to your Slack workspace.
2.  Mention the bot or use a shortcut to create a reminder.
3.  Check the Railway **Logs** to see if the interaction was received.

## Troubleshooting

-   **"Channel not found" error**: Ensure the bot is invited to the channel where you are trying to use it (`/invite @YourBotName`).
-   **Bot not responding**: Check if Socket Mode is enabled in your Slack App configuration (under "Socket Mode" in the left sidebar).
-   **Database not saving**: Double-check that the Volume Mount Path matches the `DATA_PATH` variable exactly (`/app/data`).

---

**🎉 You are now live in production!**
