// Mirrors numen/models.py and the API responses in numen/api.py.

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

export interface DaySchedule { open: boolean; start: string; end: string }
export interface Holiday { date: string; name: string }

export interface PhoneNumber {
  id: string;
  number: string;
  label: string;
  provider: "twilio";
  agent_id: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  greeting: string;
  prompt: string;
  llm: { provider: "openai"; model: string };
  voice: {
    provider: "elevenlabs";
    voice_id: string;
    voice_name: string;
    model: string;
    speed: number;
    stability: number;
    similarity_boost: number;
  };
  knowledge: {
    knowledge_base_id: string | null;
    answer_mode: "verbatim" | "rephrase";
    route_all_questions: boolean;
    lookup_filler: string;
    follow_up: string;
    typing_sound: boolean;
  };
  routing: {
    office_hours_enabled: boolean;
    timezone: string;
    week: Record<Weekday, DaySchedule>;
    holidays: Holiday[];
    transfer_enabled: boolean;
    transfer_number: string | null;
    transfer_message: string;
    after_hours_action: "answer" | "transfer";
    after_hours_number: string | null;
    after_hours_message: string;
    transfer_message_after_hours: string;
    transfer_message_voicemail: string;
    transfer_failed_message: string;
    transfer_unavailable_message: string;
  };
  conversation: {
    ring_seconds: number;
    mute_during_greeting: boolean;
    min_words_to_interrupt: number;
    background_voice_filter: "off" | "standard" | "strong";
    caller_language: "en" | "es" | "auto";
    keyterms: string[];
    end_call_enabled: boolean;
    goodbye_message: string;
  };
  safety: { enabled: boolean; emergency_message: string; crisis_message: string };
  created_at: string;
  updated_at: string;
  // response-only
  phone_numbers?: PhoneNumber[];
  knowledge_base_name?: string | null;
  office_open_now?: boolean;
}

export interface SecretStatus { set: boolean; hint: string; source?: string }

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  type: "rag_service";
  url: string;
  api_key: string;
  timeout_s: number;
  fallback_message: string;
  created_at: string;
  updated_at: string;
  api_key_status?: SecretStatus;
  used_by?: { id: string; name: string }[];
}

export interface KBLookup {
  question: string;
  found: boolean;
  answer: string | null;
  result: string;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  used_fallback: boolean;
  knowledge_base_id?: string | null;
  knowledge_base_name?: string | null;
  spoken?: string;
  spoken_to_caller?: string;
  answer_mode?: string;
}

export type NumberStatus = "connected" | "elsewhere" | "not_in_account" | "unknown";

export interface PhoneNumberRow extends PhoneNumber {
  agent_name: string | null;
  status: NumberStatus;
  voice_url: string | null;
}

export interface TwilioNumber {
  sid: string;
  number: string;
  friendly_name: string;
  voice_url: string | null;
  imported: boolean;
}

export interface CallSummary {
  caller_turns?: number;
  bot_turns?: number;
  kb_lookups?: number;
  kb_hits?: number;
  kb_misses?: number;
  kb_failures?: number;
  kb_avg_latency_ms?: number | null;
  kb_max_latency_ms?: number | null;
  transfers?: number;
  errors?: number;
}

export interface CallRow {
  call_sid: string;
  agent_id: string | null;
  agent_name: string | null;
  from_number: string | null;
  to_number: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  end_reason: string | null;
  summary: CallSummary;
}

export interface TimelineEvent {
  t: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface CallRecord {
  call: {
    call_sid: string;
    stream_sid: string | null;
    from: string | null;
    to: string | null;
    started_at: string;
    ended_at: string | null;
    duration_s: number | null;
    end_reason: string | null;
    debug_log: string;
  };
  agent: { id: string | null; name: string | null } | null;
  config: Record<string, unknown>;
  timeline: TimelineEvent[];
  kb_lookups: (KBLookup & { n: number; t: number; at: string })[];
  transfers: { t: number; number: string | null; reason: string; success: boolean; error?: string | null }[];
  errors: { t: number; message: string }[];
  summary: CallSummary;
}

export interface Settings {
  workspace_name: string;
  public_base_url: string;
  twilio_account_sid: string;
  twilio_auth_token: string;
  elevenlabs_api_key: string;
  openai_api_key: string;
  app_base_url: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: "starttls" | "ssl" | "none";
  smtp_username: string;
  smtp_password: string;
  smtp_from: string;
  smtp_password_status?: SecretStatus;
  email_configured?: boolean;
  twilio_auth_token_status?: SecretStatus;
  elevenlabs_api_key_status?: SecretStatus;
  openai_api_key_status?: SecretStatus;
  twilio_account_sid_source?: string;
  public_base_url_source?: string;
  webhook_url?: string | null;
}

export interface Voice {
  voice_id: string;
  name: string;
  category: string | null;
  description: string;
  accent: string | null;
  gender: string | null;
  age: string | null;
  use_case: string | null;
  preview_url: string | null;
}

export interface ModelOption { id: string; name: string; description: string }
export interface Meta {
  llm_models: ModelOption[];
  tts_models: ModelOption[];
  timezones: string[];
  webhook_url: string | null;
}

export interface Dashboard {
  stats: {
    calls: number;
    avg_duration_s: number;
    kb_lookups: number;
    kb_hits: number;
    transfers: number;
    kb_avg_latency_ms: number | null;
    daily: { day: string; calls: number }[];
  };
  counts: { agents: number; knowledge_bases: number; phone_numbers: number };
  recent_calls: CallRow[];
}

export type TestEvent =
  | { type: "bot"; source: string; text: string; latency_ms?: number }
  | { type: "user"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown>; latency_ms?: number }
  | ({ type: "kb_lookup" } & KBLookup)
  | { type: "transfer"; number: string | null; office_open: boolean; simulated: boolean }
  | { type: "end_call"; simulated: boolean };
