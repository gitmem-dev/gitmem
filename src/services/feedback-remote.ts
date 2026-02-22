/**
 * Remote feedback submission via Supabase anon key.
 *
 * This uses the PUBLIC anon key (designed to be shipped in client apps).
 * RLS restricts anon to INSERT-only on community_feedback.
 * Separate from supabase-client.ts because it uses the anon key, not service role.
 */

const FEEDBACK_URL = "https://cjptxyezuxdiinufgrrm.supabase.co/rest/v1/community_feedback";
const FEEDBACK_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqcHR4eWV6dXhkaWludWZncnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxODY3MDMsImV4cCI6MjA4MTc2MjcwM30.L0oZy3LYCMikmZ15IUU5DnfJmucM37DJ14nUkM3AreY";

export interface FeedbackPayload {
  feedback_id: string;
  type: string;
  tool: string;
  description: string;
  severity: string;
  suggested_fix?: string;
  context?: string;
  gitmem_version: string;
  agent_identity?: string;
  install_id?: string | null;
  client_timestamp: string;
}

export async function submitFeedbackRemote(payload: FeedbackPayload): Promise<void> {
  const response = await fetch(FEEDBACK_URL, {
    method: "POST",
    headers: {
      "apikey": FEEDBACK_ANON_KEY,
      "Authorization": `Bearer ${FEEDBACK_ANON_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "public",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Feedback submit failed: ${response.status} - ${text.slice(0, 200)}`);
  }
}
