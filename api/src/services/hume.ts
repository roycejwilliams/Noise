import { HumeClient } from "hume";

// Hume EVI — end-to-end voice AI for Co's call pipeline
// Pipeline: Twilio → Hume EVI (STT + emotion + TTS) → /co/webhook → Anthropic (psychographic extraction) → co_profiles

const hume = new HumeClient({ apiKey: process.env.HUME_API_KEY! });

export default hume;
