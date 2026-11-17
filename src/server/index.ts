import { startServer } from './app.js';
import { getDb } from '../db/connection.js';
import { fireDueReminders } from '../analytics/reminders.js';

// npm run server / npm run dev: the API only (Vite serves the UI and proxies /api)
const { port } = await startServer();
console.log(`Household API on http://127.0.0.1:${port}`);
// reminders become alerts at their time (the desktop app also shows them as notifications)
const reminders = () => { try { fireDueReminders(getDb()); } catch (err) { console.error('reminders failed:', err); } };
reminders();
setInterval(reminders, 60_000).unref();
