# 🚀 Deployment Guide: Slack Thread Reminder Bot (Render)

This guide will walk you through hosting your Slack bot on **Render** using a **Background Worker**, which is the correct service type for a Socket Mode bot.

## Prerequisites

1.  **GitHub Account**: You already have this since your code is on GitHub.
2.  **Render Account**: Sign up at [render.com](https://render.com/) using your GitHub account.
3.  **Slack App Credentials**: You should have your `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` ready.
4.  **MongoDB Connection String**: You need a free database from MongoDB Atlas. **Important:** You must allow access from anywhere (IP `0.0.0.0/0`) in Network Access.

---

## Step 1: Create a Background Worker on Render

1.  Log in to your Render Dashboard.
2.  Click **New +** and select **Background Worker**.
3.  Connect your GitHub repository: `Varad-HV/slack-thread-reminder-bot`.
4.  **Name**: Give your service a unique name, like `slack-reminder-bot-worker`.
5.  **Region**: Choose a region close to you.
6.  **Build Command**: `npm install`
7.  **Start Command**: `node index.js`
8.  **Instance Type**: **Free**

---

## Step 2: Configure Environment Variables

In the same setup screen, scroll down to the **Environment Variables** section and add these secrets:

| Variable Name | Value Description |
| :--- | :--- |
| `SLACK_BOT_TOKEN` | Your Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_APP_TOKEN` | Your App-Level Token (starts with `xapp-`) |
| `SLACK_SIGNING_SECRET` | Your App's Signing Secret |
| `ADMIN_USER_ID` | Your Slack User ID (e.g., `U12345678`) for admin features |
| `NODE_ENV` | Set this to `production` |
| `MONGODB_URI` | Your MongoDB Connection String |

---

## Step 3: Verify Deployment

1.  Click **Create Background Worker**.
2.  Wait for the build to finish.
3.  Go to the **Logs** tab and watch for the startup messages: `✅ Connected to MongoDB` and `🚀 Jira Follow-up Bot is Live!`.

---

## Troubleshooting

-   **"Channel not found" error**: Ensure the bot is invited to the channel where you are trying to use it (`/invite @YourBotName`).
-   **Bot not responding**: Check the logs on Render for any WebSocket connection errors or crashes after the "Bot is Live!" message. Ensure all environment variables are set correctly.
-   **Database Error**: Check that your `MONGODB_URI` is correct and your IP is allowed in MongoDB Atlas "Network Access" (set to `0.0.0.0/0`).
-   **Database Error (MongooseServerSelectionError)**: This means MongoDB blocked Render. Go to MongoDB Atlas -> Network Access -> Add IP Address -> **Allow Access from Anywhere**.

---

**🎉 Your bot is now live and will run 24/7!**
