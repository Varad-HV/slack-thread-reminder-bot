require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Define the Schema (Must match index.js)
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

const BACKUP_FILE = path.join(__dirname, '../../reminders_db.json.bak_2026-01-29T100000.json');

(async () => {
    try {
        if (!process.env.MONGODB_URI) {
            console.error('❌ MONGODB_URI is missing in .env');
            process.exit(1);
        }

        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected.');

        if (!fs.existsSync(BACKUP_FILE)) {
            console.error(`❌ Backup file not found at: ${BACKUP_FILE}`);
            process.exit(1);
        }

        console.log(`📂 Reading backup from: ${BACKUP_FILE}`);
        const rawData = fs.readFileSync(BACKUP_FILE, 'utf-8');
        const reminders = JSON.parse(rawData);

        console.log(`🔍 Found ${reminders.length} reminders to migrate.`);

        let successCount = 0;
        let errorCount = 0;

        for (const r of reminders) {
            try {
                // Ensure dates are actual Date objects
                if (r.created_at) r.created_at = new Date(r.created_at);
                if (r.lastSent) r.lastSent = new Date(r.lastSent);
                if (r.resolved_at) r.resolved_at = new Date(r.resolved_at);

                await ReminderModel.updateOne(
                    { id: r.id },
                    { $set: r },
                    { upsert: true }
                );
                successCount++;
            } catch (err) {
                console.error(`❌ Failed to migrate reminder ${r.id}:`, err.message);
                errorCount++;
            }
        }

        console.log(`\n🎉 Migration Complete!`);
        console.log(`✅ Successfully migrated: ${successCount}`);
        console.log(`❌ Errors: ${errorCount}`);

        process.exit(0);

    } catch (e) {
        console.error('❌ Migration Critical Error:', e);
        process.exit(1);
    }
})();
