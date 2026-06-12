import { HumeClient } from "hume";

// Expression Measurement — analyzes vocal, facial, and verbal expression
// Used as the emotion detection layer in Co's custom voice pipeline
// Pipeline: Twilio → Deepgram (STT) → Hume (emotion) → Anthropic (response) → ElevenLabs (TTS) → Twilio

const hume = new HumeClient({ apiKey: process.env.HUME_API_KEY! });

export default hume;
