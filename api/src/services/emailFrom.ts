// Who Co's emails come from (Resend). Each environment sends from a domain
// verified in its own Resend account: co-test sets RESEND_FROM to an address
// on test.copatible.com (2026-09-24: copatible.com isn't verified there, so
// every alert, login and introduction email from co-test was refused).
// Replies still go to the real hello@copatible.com inbox.
export const CO_EMAIL_FROM = process.env.RESEND_FROM || "Co <hello@copatible.com>";
