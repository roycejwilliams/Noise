export interface User {
  id: string;
  first_name: string;
  email: string;
  phone_number: string;
  subscription_status?: "active" | "inactive";
}

export interface CoProfile {
  user_id: string;
  life_chapters: string[];
  social_energy: number;
  connection_style: string;
  activity_preferences: string[];
  emotional_state: string | null;
  goals: string[];
  blockers: string[];
  availability_pattern: string | null;
  city: string | null;
  trust_score: number;
  is_circle_connector: boolean;
  check_in_count?: number;
}

export interface CircleMember {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  profile_image?: string;
}

export interface Circle {
  id: string;
  circle_name: string;
  owner_id: string;
  status: string;
  members: CircleMember[];
}

export interface Moment {
  id: string;
  moments_name: string;
  location_name: string | null;
  venue: string | null;
  suggested_time: string | null;
  moment_start: string;
  status: string;
  description: string | null;
  circle_id: string | null;
  venue_booking_url: string | null;
  vibes?: string[];
}

export interface MomentResponse {
  user_id: string;
  first_name: string;
  response: string | null;
}

export interface CoNotification {
  id: string;
  memory_type: "placement" | "moment_invite" | "booking_confirmed";
  content: string;
  created_at: string;
}
