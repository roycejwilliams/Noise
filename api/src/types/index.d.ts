declare namespace Express {
  interface Request {
    user?: UserProp;
  }
}

interface ApplicationProp {
  id?: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  work_link: string;
  status?: "pending" | "accepted" | "rejected";
  created_at?: string;
}

interface UserProp {
  id?: string;
  first_name: string;
  last_name: string;
  phone_number: string;
  email: string;
  description: string;
  username: string;
  profile_image: string;
  otp_code: string;
  otp_expiry: Date;
  created_at: Date;
  application_id: string;
  otp_attempts: number;
  locked: boolean;
  role: string;
  location: string;
  instagram: string;
  twitter: string;
  linkedin: string;
  subscription_status: "active" | "inactive" | "past_due" | "canceled";
  stripe_customer_id: string;
  contact_verified: boolean;
  identity_captured: boolean;
  intake_asked: boolean;
}

interface CircleProp {
  id?: string;
  owner_id: string;
  circle_name: string;
  circle_image: string;
  created_at: Date;
  updated_at: Date;
  members: {
    id: string;
    first_name: string;
    last_name: string;
    username: string;
    profile_image: string;
  }[];
}

interface MomentProp {
  id?: string;
  creator_id: string;
  circle_id: string;
  image: string;
  moments_name: string;
  created_at: Date;
  updated_at: Date;
  moment_start: Date;
  moment_end: Date;
  description: string;
  location: [number, number];
  location_name: string;
  cap_attendance: number;
  close_moment: boolean;
  visibility_type?: "nearby" | "circle" | "people";
  principles: string[];
  expectations: string[];
  vibes: string[];
  faqs: { question: string; answer: string }[];
  recap?: string;
}

interface InviteMembersProp {
  id?: string;
  member_id: string;
  circle_id: string;
  created_at: Date;
  accepted_at: Date;
  invited_by: string;
  status?: "pending" | "accepted" | "rejected";
}

interface InviteAttendeesProp {
  id?: string;
  attendee_id: string;
  moment_id: string;
  created_at: Date;
  accepted_at: Date;
  invited_by: string;
  status?: "pending" | "accepted" | "rejected";
}

type LifeChapter =
  | "new_to_city"
  | "building_solo"
  | "career_pivot"
  | "starting_over";

// CoPatible Intelligence Layer
interface CoProfileProp {
  id?: string;
  user_id: string;
  life_chapters: LifeChapter[];
  social_energy: number;
  connection_style: "small_group" | "medium_group" | "large_social";
  activity_preferences: string[];
  emotional_state: string;
  goals: string[];
  blockers: string[];
  availability_pattern: string;
  city: string;
  coordinates?: { x: number; y: number };
  trust_score: number;
  trust_components: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

interface CoMemoryProp {
  id?: string;
  user_id: string;
  memory_type:
    | "call_transcript"
    | "text_exchange"
    | "check_in"
    | "recap"
    | "intent";
  content: string;
  emotional_context?: string;
  audio_url?: string;
  created_at?: Date;
}

interface HumeWebhookPayload {
  call_id: string;
  user_id: string;
  transcript: string;
  emotions: {
    name: string;
    score: number;
  }[];
  duration_seconds: number;
  recording_url?: string;
}
