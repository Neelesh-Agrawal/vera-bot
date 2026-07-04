// Types mirror the *actual* schemas found in challenge-testing-brief.md §3
// and confirmed against dataset/{categories,merchants,customers,triggers}/*.json

// ---------------------------------------------------------------------------
// Context payloads (what /v1/context delivers, per scope)
// ---------------------------------------------------------------------------

export interface DigestItem {
  id: string;
  kind: string; // "research" | "compliance" | ...
  title: string;
  source?: string;
  trial_n?: number;
  patient_segment?: string;
  summary?: string;
  [k: string]: unknown;
}

export interface OfferCatalogItem {
  id: string;
  title: string;
  value?: string;
  audience?: string;
  type?: string;
}

export interface CategoryContext {
  slug: string;
  display_name?: string;
  voice: {
    tone: string;
    register?: string;
    code_mix?: string;
    vocab_allowed?: string[];
    vocab_taboo?: string[];
    salutation_examples?: string[];
    tone_examples?: string[];
  };
  offer_catalog: OfferCatalogItem[];
  peer_stats: Record<string, number | string>;
  digest: DigestItem[];
  patient_content_library?: Array<Record<string, unknown>>;
  seasonal_beats?: Array<{ month_range: string; note: string }>;
  trend_signals?: Array<Record<string, unknown>>;
}

export interface MerchantOffer {
  id: string;
  title: string;
  status: "active" | "expired" | "paused" | string;
  started?: string;
  ended?: string;
}

export interface ConversationHistoryEntry {
  ts: string;
  from: "vera" | "merchant" | string;
  body: string;
  engagement?: string;
}

export interface ReviewTheme {
  theme: string;
  sentiment: "pos" | "neg" | string;
  occurrences_30d: number;
  common_quote?: string;
}

export interface MerchantContext {
  merchant_id: string;
  category_slug: string;
  identity: {
    name: string;
    city: string;
    locality: string;
    place_id?: string;
    verified?: boolean;
    languages?: string[];
    owner_first_name?: string;
    established_year?: number;
  };
  subscription?: { status: string; plan: string; days_remaining: number; renewed_at?: string };
  performance?: {
    window_days: number;
    views?: number;
    calls?: number;
    directions?: number;
    ctr?: number;
    leads?: number;
    delta_7d?: Record<string, number>;
  };
  offers?: MerchantOffer[];
  conversation_history?: ConversationHistoryEntry[];
  customer_aggregate?: Record<string, number>;
  signals?: string[];
  review_themes?: ReviewTheme[];
}

export interface CustomerContext {
  customer_id: string;
  merchant_id: string;
  identity: {
    name: string;
    phone_redacted?: string;
    language_pref?: string; // e.g. "hi-en mix"
    age_band?: string;
  };
  relationship?: {
    first_visit?: string;
    last_visit?: string;
    visits_total?: number;
    services_received?: string[];
    lifetime_value?: number;
  };
  state?: "new" | "active" | "lapsed_soft" | "lapsed_hard" | "churned" | string;
  preferences?: { preferred_slots?: string; channel?: string; reminder_opt_in?: boolean };
  consent?: { opted_in_at?: string; scope?: string[] };
}

export interface TriggerContext {
  id: string;
  scope: "merchant" | "customer";
  kind: string;
  source: "external" | "internal";
  merchant_id: string;
  customer_id?: string | null;
  payload: Record<string, unknown>;
  urgency: number; // 1-5
  suppression_key: string;
  expires_at: string;
}

export type ContextScope = "category" | "merchant" | "customer" | "trigger";

export interface ContextEnvelope {
  scope: ContextScope;
  context_id: string;
  version: number;
  payload: CategoryContext | MerchantContext | CustomerContext | TriggerContext;
  delivered_at: string;
}

// ---------------------------------------------------------------------------
// /v1/tick
// ---------------------------------------------------------------------------

export interface TickRequestBody {
  now: string;
  available_triggers: string[];
}

export type CtaShape = "yes_no" | "open_ended" | "multi_choice" | "none";
export type SendAs = "vera" | "merchant_on_behalf";

export interface TickAction {
  conversation_id: string;
  merchant_id: string;
  customer_id: string | null;
  send_as: SendAs;
  trigger_id: string;
  template_name: string;
  template_params: string[];
  body: string;
  cta: CtaShape;
  suppression_key: string;
  rationale: string;
}

export interface TickResponseBody {
  actions: TickAction[];
}

// ---------------------------------------------------------------------------
// /v1/reply
// ---------------------------------------------------------------------------

export interface ReplyRequestBody {
  conversation_id: string;
  merchant_id: string | null;
  customer_id: string | null;
  from_role: "merchant" | "customer";
  message: string;
  received_at: string;
  turn_number: number;
}

export type ReplyAction = "send" | "wait" | "end";

export interface ReplyResponseBody {
  action: ReplyAction;
  body?: string;
  cta?: CtaShape;
  wait_seconds?: number;
  rationale: string;
}

// ---------------------------------------------------------------------------
// /v1/healthz, /v1/metadata
// ---------------------------------------------------------------------------

export interface HealthzResponseBody {
  status: "ok" | "degraded";
  uptime_seconds: number;
  contexts_loaded: { category: number; merchant: number; customer: number; trigger: number };
}

export interface MetadataResponseBody {
  team_name: string;
  team_members: string[];
  model: string;
  approach: string;
  contact_email: string;
  version: string;
  submitted_at: string;
}

// ---------------------------------------------------------------------------
// Composer output (internal, shared by /v1/tick and the offline batch script)
// ---------------------------------------------------------------------------

export interface ComposedMessage {
  body: string;
  cta: CtaShape;
  send_as: SendAs;
  suppression_key: string;
  rationale: string;
}
