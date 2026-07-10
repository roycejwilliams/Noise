--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3 (Homebrew)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_table_access_method = heap;

--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    email character varying(50) NOT NULL,
    phone_number character varying(20),
    work_link character varying(200),
    reason character varying(800),
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    referred_by uuid
);


--
-- Name: circle_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    circle_id uuid,
    user_id uuid,
    status text DEFAULT 'pending'::text,
    responded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: circle_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_members (
    member_id uuid NOT NULL,
    circle_id uuid NOT NULL,
    joined_at timestamp without time zone DEFAULT now(),
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT circle_members_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);


--
-- Name: circles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circles (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT circle_id_not_null NOT NULL,
    owner_id uuid,
    circle_name character varying(50) CONSTRAINT circle_circle_name_not_null NOT NULL,
    circle_image character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    status text DEFAULT 'pending_approval'::text,
    keana_notified_at timestamp with time zone
);


--
-- Name: co_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.co_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    memory_type text,
    content text NOT NULL,
    emotional_context text,
    created_at timestamp with time zone DEFAULT now(),
    audio_url text,
    content_embedding public.vector(1536),
    CONSTRAINT co_memories_memory_type_check CHECK ((memory_type = ANY (ARRAY['call_transcript'::text, 'text_exchange'::text, 'check_in'::text, 'intent'::text, 'recap'::text, 'system'::text, 'placement'::text])))
);


--
-- Name: co_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.co_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    life_chapters text[] DEFAULT '{}'::text[],
    social_energy integer,
    connection_style text,
    activity_preferences text[] DEFAULT '{}'::text[],
    emotional_state text,
    goals text[] DEFAULT '{}'::text[],
    blockers text[] DEFAULT '{}'::text[],
    availability_pattern text,
    city text,
    coordinates public.geometry(Point,4326),
    trust_score integer DEFAULT 50,
    trust_components jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    goal_embeddings public.vector(1536),
    is_circle_connector boolean DEFAULT false,
    hume_chat_group_id text,
    intent jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT co_profiles_connection_style_check CHECK ((connection_style = ANY (ARRAY['small_group'::text, 'medium_group'::text, 'large_social'::text]))),
    CONSTRAINT co_profiles_life_chapters_check CHECK ((life_chapters <@ ARRAY['new_to_city'::text, 'building_solo'::text, 'career_pivot'::text, 'starting_over'::text])),
    CONSTRAINT co_profiles_social_energy_check CHECK (((social_energy >= 0) AND (social_energy <= 100))),
    CONSTRAINT co_profiles_trust_score_check CHECK (((trust_score >= 0) AND (trust_score <= 100)))
);


--
-- Name: co_venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.co_venues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    vibe text[],
    neighborhood text,
    city text DEFAULT 'San Francisco'::text,
    capacity_min integer,
    capacity_max integer,
    payment_tier text,
    deposit_amount numeric,
    booking_method text,
    contact text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT co_venues_booking_method_check CHECK ((booking_method = ANY (ARRAY['api'::text, 'co_call'::text, 'none'::text]))),
    CONSTRAINT co_venues_payment_tier_check CHECK ((payment_tier = ANY (ARRAY['free'::text, 'pay_there'::text, 'deposit'::text])))
);


--
-- Name: invite_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_attendees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attendee_id uuid,
    moment_id uuid,
    created_at timestamp without time zone DEFAULT now(),
    accepted_at timestamp without time zone,
    invited_by uuid,
    status character varying(20) DEFAULT 'pending'::character varying
);


--
-- Name: invite_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid,
    circle_id uuid,
    create_at timestamp without time zone DEFAULT now(),
    accepted_at timestamp without time zone,
    invited_by uuid,
    status character varying(20) DEFAULT 'pending'::character varying
);


--
-- Name: moment_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moment_attendees (
    attendee_id uuid NOT NULL,
    moment_id uuid NOT NULL,
    joined_at timestamp without time zone DEFAULT now(),
    checked_in boolean DEFAULT false,
    checked_in_at timestamp without time zone
);


--
-- Name: moment_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moment_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    moment_id uuid,
    uploader_id uuid,
    image_url character varying(400) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: moment_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moment_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    moment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    response text,
    created_at timestamp with time zone DEFAULT now(),
    responded_at timestamp with time zone
);


--
-- Name: moments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    creator_id uuid,
    circle_id uuid,
    image character varying(400),
    moments_name character varying(100) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    moment_start timestamp with time zone,
    moment_end timestamp with time zone,
    description character varying(400),
    location point,
    cap_attendance bigint,
    close_moment boolean,
    visibility_type character varying(40) DEFAULT 'nearby'::character varying,
    location_name character varying(255),
    principles text[],
    expectations text[],
    vibes text[],
    faqs jsonb,
    recap text,
    venue text,
    status text DEFAULT 'pending'::text,
    suggested_time text,
    booking_link_sent_at timestamp with time zone,
    consensus_nudge_sent_at timestamp with time zone,
    connector_nudge_sent_at timestamp with time zone,
    venue_booking_url text,
    day_of_reminder_sent_at timestamp with time zone,
    venue_place_id text
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    moment_id uuid,
    moments_name text,
    moment_image text,
    friend_id uuid,
    friend_first_name text,
    friend_last_name text,
    friend_username text,
    friend_profile_image text,
    read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pending_call_followups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_call_followups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    call_sid text NOT NULL,
    call_status text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referrer_id uuid,
    recipient character varying(255) NOT NULL,
    reason text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    email character varying(50) NOT NULL,
    phone_number character varying(20) NOT NULL,
    username character varying(50) NOT NULL,
    profile_image character varying,
    description character varying(400),
    otp_code character varying(6),
    otp_expiry timestamp without time zone,
    otp_attempts integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    application_id uuid,
    locked boolean DEFAULT false,
    role character varying(50) DEFAULT 'user'::character varying,
    location character varying(100),
    instagram character varying(100),
    twitter character varying(100),
    linkedin character varying(100),
    referrals_available integer DEFAULT 3,
    subscription_status text DEFAULT 'inactive'::text,
    stripe_customer_id text,
    contact_verified boolean DEFAULT false NOT NULL,
    CONSTRAINT users_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['active'::text, 'inactive'::text, 'past_due'::text, 'canceled'::text])))
);


--
-- Name: voicemail_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voicemail_calls (
    call_sid text NOT NULL,
    detected_at timestamp with time zone DEFAULT now()
);


--
-- Name: applications applications_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_email_key UNIQUE (email);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: circle_invites circle_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_pkey PRIMARY KEY (id);


--
-- Name: circle_members circle_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_members
    ADD CONSTRAINT circle_members_pkey PRIMARY KEY (circle_id, member_id);


--
-- Name: circles circle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circle_pkey PRIMARY KEY (id);


--
-- Name: co_memories co_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_memories
    ADD CONSTRAINT co_memories_pkey PRIMARY KEY (id);


--
-- Name: co_profiles co_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_profiles
    ADD CONSTRAINT co_profiles_pkey PRIMARY KEY (id);


--
-- Name: co_profiles co_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_profiles
    ADD CONSTRAINT co_profiles_user_id_key UNIQUE (user_id);


--
-- Name: co_venues co_venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_venues
    ADD CONSTRAINT co_venues_pkey PRIMARY KEY (id);


--
-- Name: invite_attendees invite_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_attendees
    ADD CONSTRAINT invite_attendees_pkey PRIMARY KEY (id);


--
-- Name: invite_members invite_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_members
    ADD CONSTRAINT invite_members_pkey PRIMARY KEY (id);


--
-- Name: moment_attendees moment_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_attendees
    ADD CONSTRAINT moment_attendees_pkey PRIMARY KEY (moment_id, attendee_id);


--
-- Name: moment_photos moment_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_photos
    ADD CONSTRAINT moment_photos_pkey PRIMARY KEY (id);


--
-- Name: moment_responses moment_responses_moment_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_responses
    ADD CONSTRAINT moment_responses_moment_user_unique UNIQUE (moment_id, user_id);


--
-- Name: moment_responses moment_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_responses
    ADD CONSTRAINT moment_responses_pkey PRIMARY KEY (id);


--
-- Name: moments moments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: pending_call_followups pending_call_followups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_call_followups
    ADD CONSTRAINT pending_call_followups_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: voicemail_calls voicemail_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voicemail_calls
    ADD CONSTRAINT voicemail_calls_pkey PRIMARY KEY (call_sid);


--
-- Name: co_memories_content_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX co_memories_content_embedding_idx ON public.co_memories USING hnsw (content_embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: co_memories_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX co_memories_embedding_hnsw_idx ON public.co_memories USING hnsw (content_embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_circle_members_circle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_members_circle_id ON public.circle_members USING btree (circle_id);


--
-- Name: idx_co_memories_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_memories_type ON public.co_memories USING btree (memory_type);


--
-- Name: idx_co_memories_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_memories_user_id ON public.co_memories USING btree (user_id);


--
-- Name: idx_co_profiles_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_profiles_city ON public.co_profiles USING btree (city);


--
-- Name: idx_co_profiles_coordinates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_profiles_coordinates ON public.co_profiles USING gist (coordinates);


--
-- Name: idx_co_profiles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_profiles_user_id ON public.co_profiles USING btree (user_id);


--
-- Name: idx_invite_attendees_moment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_attendees_moment_id ON public.invite_attendees USING btree (moment_id);


--
-- Name: idx_invite_members_circle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_members_circle_id ON public.invite_members USING btree (circle_id);


--
-- Name: idx_moment_attendees_attendee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moment_attendees_attendee_id ON public.moment_attendees USING btree (attendee_id);


--
-- Name: idx_moment_attendees_moment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moment_attendees_moment_id ON public.moment_attendees USING btree (moment_id);


--
-- Name: idx_moments_creator_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moments_creator_id ON public.moments USING btree (creator_id);


--
-- Name: idx_moments_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moments_location ON public.moments USING gist (location);


--
-- Name: applications applications_referred_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES public.users(id);


--
-- Name: circle_invites circle_invites_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id);


--
-- Name: circle_invites circle_invites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: circle_members circle_members_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_members
    ADD CONSTRAINT circle_members_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id) ON DELETE CASCADE;


--
-- Name: circle_members circle_members_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_members
    ADD CONSTRAINT circle_members_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: circles circle_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circle_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: co_memories co_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_memories
    ADD CONSTRAINT co_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: co_profiles co_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_profiles
    ADD CONSTRAINT co_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invite_attendees invite_attendees_attendee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_attendees
    ADD CONSTRAINT invite_attendees_attendee_id_fkey FOREIGN KEY (attendee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invite_attendees invite_attendees_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_attendees
    ADD CONSTRAINT invite_attendees_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: invite_attendees invite_attendees_moment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_attendees
    ADD CONSTRAINT invite_attendees_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;


--
-- Name: invite_members invite_members_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_members
    ADD CONSTRAINT invite_members_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id) ON DELETE CASCADE;


--
-- Name: invite_members invite_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_members
    ADD CONSTRAINT invite_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: invite_members invite_members_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_members
    ADD CONSTRAINT invite_members_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: moment_attendees moment_attendees_attendee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_attendees
    ADD CONSTRAINT moment_attendees_attendee_id_fkey FOREIGN KEY (attendee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: moment_attendees moment_attendees_moment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_attendees
    ADD CONSTRAINT moment_attendees_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;


--
-- Name: moment_photos moment_photos_moment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_photos
    ADD CONSTRAINT moment_photos_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;


--
-- Name: moment_photos moment_photos_uploader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_photos
    ADD CONSTRAINT moment_photos_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: moment_responses moment_responses_moment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_responses
    ADD CONSTRAINT moment_responses_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;


--
-- Name: moment_responses moment_responses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moment_responses
    ADD CONSTRAINT moment_responses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: moments moments_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id) ON DELETE SET NULL;


--
-- Name: moments moments_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_friend_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_friend_id_fkey FOREIGN KEY (friend_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_moment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pending_call_followups pending_call_followups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_call_followups
    ADD CONSTRAINT pending_call_followups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.users(id);


--
-- Name: users users_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id);


--
-- PostgreSQL database dump complete
--


