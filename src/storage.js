// simple in-memory storage for phase 1
const reminders = {}; // { reminderId: {thread, assignee, note, frequency, initiator, quote, lastSent, intervalObj} }

function addReminder(id, data) {
  reminders[id] = data;
}

function removeReminder(id) {
  if (reminders[id]) {
    clearInterval(reminders[id].intervalObj);
    delete reminders[id];
  }
}

function getActiveRemindersByUser(userId) {
  return Object.values(reminders).filter(r => r.initiator === userId);
}

function getReminder(id) {
  return reminders[id];
}

module.exports = {
  reminders,
  addReminder,
  removeReminder,
  getActiveRemindersByUser,
  getReminder
};
