import { readFile } from "node:fs/promises";

const file = process.argv[2] ?? "docs/beta/cohort.json";
const data = JSON.parse(await readFile(file, "utf8"));
if (data.schemaVersion !== 1 || ![data.participants, data.taskRuns, data.issues].every(Array.isArray)) {
  throw new Error("Invalid beta tracker schema");
}
const { participants, taskRuns, issues } = data;
const rate = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const dateOnly = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use YYYY-MM-DD dates");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
  return date;
};
const now = dateOnly(new Date().toISOString().slice(0, 10));
const retention = (day) => {
  let eligible = 0, returned = 0;
  for (const participant of participants) {
    if (!participant.firstUsedAt) continue;
    const target = dateOnly(participant.firstUsedAt);
    target.setUTCDate(target.getUTCDate() + day - 1);
    if (target > now) continue;
    eligible++;
    if ((participant.activeDates ?? []).includes(target.toISOString().slice(0, 10))) returned++;
  }
  return { eligible, returned, rate: rate(returned, eligible) };
};
const invited = participants.filter((person) => person.invitedAt).length;
const installed = participants.filter((person) => person.installedAt).length;
const completed = taskRuns.filter((task) => task.completed === true && task.testsPassed === true).length;
console.log(JSON.stringify({
  asOf: now.toISOString().slice(0, 10), invited, installed,
  installRate: rate(installed, invited),
  taskRuns: taskRuns.length, completedAndTested: completed,
  taskSuccessRate: rate(completed, taskRuns.length),
  lostWorkIncidents: taskRuns.filter((task) => task.lostWork === true).length,
  day2: retention(2), day7: retention(7),
  unresolvedIssues: issues.filter((issue) => issue.status !== "verified").length,
}, null, 2));
