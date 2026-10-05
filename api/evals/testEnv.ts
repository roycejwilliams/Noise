// Imported first by model-free checks whose imports reach the Sendblue client,
// which reads its key when it loads: static imports run before any code in the
// file, so the placeholder has to be set by an import of its own.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
export {};
