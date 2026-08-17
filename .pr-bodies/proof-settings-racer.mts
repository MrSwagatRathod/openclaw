/** One real OS process persisting one setting into a shared settings.json. */
import { SettingsManager } from "/home/user/openclaw/src/agents/sessions/settings-manager.js";

const agentDir = process.argv[2];
const field = process.argv[3];
const value = process.argv[4];
const startAt = Number(process.argv[5]);

// Line both processes up on the same wall-clock instant to hit the create race.
while (Date.now() < startAt) {
  /* spin */
}

const mgr = SettingsManager.create(agentDir, agentDir);
if (field === "defaultModel") {
  mgr.setDefaultModel(value);
} else {
  mgr.setTheme(value);
}
await mgr.flush();
console.log(`pid ${process.pid} wrote ${field}=${value}`);
