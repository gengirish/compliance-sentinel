const { sendAppointmentReminders } = require("./reminders");

const ONE_HOUR = 60 * 60 * 1000;

// Background jobs. Each entry runs on a fixed interval.
function registerJobs() {
  setInterval(sendAppointmentReminders, ONE_HOUR);
}

module.exports = { registerJobs };
