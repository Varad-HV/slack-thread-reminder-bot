const fetch = require('node-fetch');

// working hours: 9am-6pm
function isWorkingHours(date = new Date()) {
  const hour = date.getHours();
  const day = date.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

// time-aware nudge messages
function getTimeAwareMessage(assignee, note) {
  const now = new Date();
  const hour = now.getHours();
  let prefix = '';
  if (hour < 12) prefix = "Good morning ☀️";
  else if (hour < 14) prefix = "Hope you had lunch 🍽️";
  else if (hour < 18) prefix = "Afternoon check-in 🕒";
  else prefix = "Evening nudge 🌙";

  return `${prefix} <@${assignee}>, reminder: ${note}`;
}

// random motivational quote from public API
async function getRandomQuote() {
  try {
    const res = await fetch('https://api.quotable.io/random');
    const data = await res.json();
    return data.content ? `💡 "${data.content}"` : '';
  } catch {
    return '';
  }
}

// small library of humorous yet polite puns
function getRandomPun() {
  const puns = [
    "Just gently nudging 😉",
    "Not ignoring you, promise 😅",
    "Still pending, like my coffee ☕",
    "Friendly reminder — no pressure 😇",
    "Ping ping! 🏓"
  ];
  return puns[Math.floor(Math.random() * puns.length)];
}

module.exports = { isWorkingHours, getTimeAwareMessage, getRandomQuote, getRandomPun };
