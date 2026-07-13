import type { QueuedRecord, RoundRecord, SessionFeedbackRecord, SessionRecord } from "./types";

const QUEUE_KEY = "pacman-dda-pending-v1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const cloudConfigured =
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_KEY.length > 20 &&
  !SUPABASE_KEY.includes("replace_with");

function readQueue(): QueuedRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as QueuedRecord[];
  } catch {
    return [];
  }
}

function writeQueue(records: QueuedRecord[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(records));
  window.dispatchEvent(new Event("pacman-queue-change"));
}

export function queueCount() {
  return readQueue().length;
}

function enqueue(record: QueuedRecord) {
  const queue = readQueue();
  const duplicate = queue.some(
    (item) => item.kind === record.kind && item.payload.id === record.payload.id,
  );
  if (!duplicate) writeQueue([...queue, record]);
}

async function insert(table: string, payload: SessionRecord | RoundRecord | SessionFeedbackRecord) {
  if (!cloudConfigured) throw new Error("Cloud collection is not configured");
  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  if (SUPABASE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (response.status === 409) {
    const conflict = await response.json().catch(() => ({})) as { code?: string };
    if (conflict.code === "23505") return;
  }
  if (!response.ok) throw new Error(`Collection request failed (${response.status})`);
}

export async function submitSession(payload: SessionRecord) {
  const record: QueuedRecord = { kind: "session", payload };
  try {
    await insert("web_game_sessions", payload);
  } catch {
    enqueue(record);
  }
}

export async function submitRound(payload: RoundRecord) {
  const record: QueuedRecord = { kind: "round", payload };
  try {
    await insert("web_round_logs", payload);
  } catch {
    enqueue(record);
  }
}

export async function submitSessionFeedback(payload: SessionFeedbackRecord) {
  const record: QueuedRecord = { kind: "feedback", payload };
  try {
    await insert("web_session_feedback", payload);
  } catch {
    enqueue(record);
  }
}

export async function flushQueue() {
  if (!cloudConfigured) return { sent: 0, remaining: queueCount() };
  const queue = readQueue();
  const remaining: QueuedRecord[] = [];
  let sent = 0;
  for (const record of queue) {
    try {
      const table = record.kind === "session"
        ? "web_game_sessions"
        : record.kind === "round" ? "web_round_logs" : "web_session_feedback";
      await insert(table, record.payload);
      sent += 1;
    } catch {
      remaining.push(record);
    }
  }
  writeQueue(remaining);
  return { sent, remaining: remaining.length };
}
